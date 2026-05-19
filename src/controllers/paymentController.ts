import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';

// 1. Submit a payment transaction record (manual receipt reference)
export async function submitPayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    applicationId, amount, currency, txType,
    paymentMethod, transactionReference
  } = req.body;

  if (!amount || !currency || !txType || !paymentMethod || !transactionReference) {
    return res.status(400).json({ error: 'Missing required payment fields: amount, currency, txType, paymentMethod, transactionReference.' });
  }

  try {
    // Check for duplicate transaction reference (fraud prevention)
    const dupCheck = await pool.query(
      'SELECT id FROM financial_transactions WHERE transaction_reference = $1',
      [transactionReference]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Duplicate transaction reference. This reference code has already been submitted.' });
    }

    const result = await pool.query(
      `INSERT INTO financial_transactions
       (member_id, application_id, amount, currency, tx_type, payment_method, transaction_reference, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending_Verification') RETURNING *`,
      [req.user.id, applicationId || null, amount, currency, txType, paymentMethod, transactionReference]
    );

    return res.status(201).json({ message: 'Payment submitted for verification.', transaction: result.rows[0] });
  } catch (error: any) {
    console.error('[Submit Payment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting payment.' });
  }
}

// 2. Get member's payment history
export async function getPaymentHistory(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const result = await pool.query(
      'SELECT * FROM financial_transactions WHERE member_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.status(200).json({ transactions: result.rows });
  } catch (error: any) {
    console.error('[Get Payment History] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching payment history.' });
  }
}

// 3. Admin: Verify/Clear a payment (Finance Officer action)
export async function verifyPayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { transactionId, action, rejectionReason } = req.body;
  // action: 'Cleared' | 'Failed' | 'Refunded'

  if (!transactionId || !action) {
    return res.status(400).json({ error: 'Missing transactionId or action.' });
  }

  const validActions = ['Cleared', 'Failed', 'Refunded'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
  }

  if ((action === 'Failed' || action === 'Refunded') && !rejectionReason) {
    return res.status(400).json({ error: 'Rejection reason is mandatory when failing or refunding a payment.' });
  }

  try {
    const result = await pool.query(
      `UPDATE financial_transactions
       SET status = $1, verified_by_email = $2, rejection_reason = $3, cleared_at = $4, 
           invoice_url = NULL, receipt_url = NULL
       WHERE id = $5 AND status = 'Pending_Verification' RETURNING *`,
      [
        action,
        req.user.email,
        rejectionReason || null,
        action === 'Cleared' ? new Date().toISOString() : null,
        transactionId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Transaction not found or already verified.' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
       VALUES ($1, $2, 'PAYMENT_VERIFICATION', $3)`,
      [result.rows[0].member_id, req.user.email, `Transaction ${transactionId} marked as ${action}.`]
    );

    return res.status(200).json({ message: `Payment ${action.toLowerCase()}.`, transaction: result.rows[0] });
  } catch (error: any) {
    console.error('[Verify Payment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error verifying payment.' });
  }
}

// 4. Admin: Get all pending payments queue
export async function getPendingPayments(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { status = 'Pending_Verification', page = '1', limit = '20' } = req.query;
  const offset = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);

  try {
    const result = await pool.query(
      `SELECT ft.*, m.full_name, m.email
       FROM financial_transactions ft
       JOIN members m ON ft.member_id = m.id
       WHERE ft.status = $1
       ORDER BY ft.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, parseInt(limit as string, 10), offset]
    );

    const countRes = await pool.query(
      'SELECT COUNT(*) FROM financial_transactions WHERE status = $1', [status]
    );

    return res.status(200).json({
      transactions: result.rows,
      pagination: {
        total: parseInt(countRes.rows[0].count, 10),
        page: parseInt(page as string, 10),
        limit: parseInt(limit as string, 10)
      }
    });
  } catch (error: any) {
    console.error('[Get Pending Payments] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching payment queue.' });
  }
}
