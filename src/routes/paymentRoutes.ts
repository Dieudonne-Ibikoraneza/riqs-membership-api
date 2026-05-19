import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import { submitPayment, getPaymentHistory, verifyPayment, getPendingPayments } from '../controllers/paymentController';

const router = Router();

/**
 * @openapi
 * /api/v1/payments/submit:
 *   post:
 *     summary: Submit a Payment Transaction
 *     description: Registers a new fee transaction (MTN Momo ref code or bank slip reference) to the double-entry financial ledger. Enforces duplicate reference detection for anti-fraud security.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: OBJECT
 *             required:
 *               - amount
 *               - currency
 *               - txType
 *               - paymentMethod
 *               - transactionReference
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *                 example: 10000
 *               currency:
 *                 type: string
 *                 enum: [RWF, USD]
 *                 example: RWF
 *               txType:
 *                 type: string
 *                 enum: [Processing_Fee, First_Year_Fee, Annual_Renewal, Stamp_Fee, APC_Fee]
 *                 example: Processing_Fee
 *               paymentMethod:
 *                 type: string
 *                 enum: [MTN_Momo, Bank_Transfer, Card_Payment, Manual_Cash]
 *                 example: MTN_Momo
 *               transactionReference:
 *                 type: string
 *                 example: MOMO-REF-998877A
 *     responses:
 *       201:
 *         description: Transaction record successfully logged (Pending Verification)
 *       400:
 *         description: Missing fields or schema validation failed
 *       409:
 *         description: Anti-Fraud Trigger — Duplicate transaction reference code
 *       500:
 *         description: Internal server error
 */
router.post('/submit', requireAuth, submitPayment);

/**
 * @openapi
 * /api/v1/payments/history:
 *   get:
 *     summary: Fetch member payment history
 *     description: Returns the full chronological array of financial ledger transactions submitted by the logged-in member.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Successfully fetched member ledger
 *       500:
 *         description: Internal server error
 */
router.get('/history', requireAuth, getPaymentHistory);

/**
 * @openapi
 * /api/v1/payments/verify:
 *   post:
 *     summary: Verify/Clear Payment (Finance/Admin only)
 *     description: Clearance action for finance/admin roles to clear, fail, or refund a pending ledger transaction. Automatically logs an administrative audit trace.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: OBJECT
 *             required:
 *               - transactionId
 *               - action
 *             properties:
 *               transactionId:
 *                 type: string
 *                 format: uuid
 *               action:
 *                 type: string
 *                 enum: [Cleared, Failed, Refunded]
 *                 example: Cleared
 *               rejectionReason:
 *                 type: string
 *                 description: Mandatory description of failure reason if failing/refunding transaction
 *                 example: "Fraudulent Bank Transfer reference number."
 *     responses:
 *       200:
 *         description: Transaction status successfully modified
 *       400:
 *         description: Missing parameters or invalid clearance action
 *       500:
 *         description: Internal server error
 */
router.post('/verify', requireAuth, requireRoles(['admin', 'finance']), verifyPayment);

/**
 * @openapi
 * /api/v1/payments/queue:
 *   get:
 *     summary: Fetch Payments Review Queue (Finance/Admin only)
 *     description: Paginated queue listing transactions awaiting review, clearance, or audit processing.
 *     tags:
 *       - Payments & Invoices
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           default: Pending_Verification
 *         description: Filter queue by payment state
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Retreived queue successfully
 *       401:
 *         description: Access Denied
 *       500:
 *         description: Internal server error
 */
router.get('/queue', requireAuth, requireRoles(['admin', 'finance']), getPendingPayments);

export default router;
