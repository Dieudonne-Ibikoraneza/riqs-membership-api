import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { TransactionType, PaymentMethod, TransactionStatus } from '@prisma/client';
import { deriveMemberClass, getCertificateCode } from '../utils/membershipUtils';
import { sendMail } from '../config/mailer';

// 1. Submit a payment transaction record (manual receipt reference)
export async function submitPayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    applicationId, amount, currency, txType,
    paymentMethod, transactionReference, receiptUrl, cpdDocumentUrl
  } = req.body;

  if (!amount || !currency || !txType || !paymentMethod || !transactionReference) {
    return res.status(400).json({ error: 'Missing required payment fields: amount, currency, txType, paymentMethod, transactionReference.' });
  }

  try {
    // Check for duplicate transaction reference (fraud prevention)
    const dupCheck = await prisma.financialTransaction.findUnique({
      where: { transactionReference }
    });
    
    if (dupCheck) {
      return res.status(409).json({ error: 'Duplicate transaction reference. This reference code has already been submitted.' });
    }

    const existingTx = await prisma.financialTransaction.findFirst({
      where: {
        memberId: req.user.id,
        applicationId: applicationId || null,
        txType: txType as TransactionType,
        status: { in: ['Unpaid', 'Failed'] }
      }
    });

    let transaction;
    if (existingTx) {
      transaction = await prisma.financialTransaction.update({
        where: { id: existingTx.id },
        data: {
          amount,
          currency,
          paymentMethod: paymentMethod as PaymentMethod,
          transactionReference,
          receiptUrl: receiptUrl || null,
          cpdDocumentUrl: cpdDocumentUrl || null,
          status: 'Pending_Verification',
          rejectionReason: null // clear previous reason
        }
      });
    } else {
      transaction = await prisma.financialTransaction.create({
        data: {
          memberId: req.user.id,
          applicationId: applicationId || null,
          amount,
          currency,
          txType: txType as TransactionType,
          paymentMethod: paymentMethod as PaymentMethod,
          transactionReference,
          receiptUrl: receiptUrl || null,
          cpdDocumentUrl: cpdDocumentUrl || null,
          status: 'Pending_Verification'
        }
      });
    }

    return res.status(201).json({ message: 'Payment submitted for verification.', transaction });
  } catch (error: any) {
    console.error('[Submit Payment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting payment.' });
  }
}

// 2. Get member's payment history
export async function getPaymentHistory(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const transactions = await prisma.financialTransaction.findMany({
      where: { memberId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    return res.status(200).json({ transactions });
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
    const existingTransaction = await prisma.financialTransaction.findUnique({
      where: { id: transactionId },
      include: {
        member: true,
        application: { include: { category: true } }
      }
    });

    if (!existingTransaction || existingTransaction.status !== 'Pending_Verification') {
      return res.status(400).json({ error: 'Transaction not found or already verified.' });
    }

    const isFirstYearFee = existingTransaction.txType === 'First_Year_Fee';
    let generatedMembershipId: string | null = null;
    let generatedMembershipClass: string | null = null;

    if (action === 'Cleared' && isFirstYearFee && existingTransaction.application?.category && !existingTransaction.member.membershipId) {
      const currentYear = new Date().getFullYear();
      const certCode = getCertificateCode(existingTransaction.application.category.categoryCode);
      const prefix = `RIQS-${currentYear}-${certCode}-`;
      const lastMember = await prisma.member.findFirst({
        where: { membershipId: { startsWith: prefix } },
        orderBy: { membershipId: 'desc' }
      });
      const lastNumber = lastMember?.membershipId?.split('-').pop();
      const nextNumber = lastNumber && !isNaN(Number(lastNumber)) ? Number(lastNumber) + 1 : 1;
      generatedMembershipId = `${prefix}${String(nextNumber).padStart(4, '0')}`;
      generatedMembershipClass = deriveMemberClass(existingTransaction.application.category.categoryCode);
    }

    const transactionQueries: any[] = [
      prisma.financialTransaction.update({
        where: { id: transactionId },
        data: {
          status: action as TransactionStatus,
          verifiedByEmail: req.user.email,
          rejectionReason: rejectionReason || null,
          clearedAt: action === 'Cleared' ? new Date() : null
        }
      }),
      prisma.auditLog.create({
        data: {
          memberId: existingTransaction.memberId,
          actionByEmail: req.user.email,
          actionType: 'PAYMENT_VERIFICATION',
          details: `Transaction ${transactionId} marked as ${action}.`
        }
      })
    ];

    if (action === 'Cleared' && (existingTransaction.txType === 'First_Year_Fee' || existingTransaction.txType === 'Annual_Renewal')) {
      const now = new Date();
      let expiryYear = now.getFullYear();
      if (now.getMonth() === 11) {
        expiryYear++; // If paid in December, extends to next year
      }
      const newExpiry = new Date(Date.UTC(expiryYear, 11, 31, 23, 59, 59));
      
      transactionQueries.push(
        prisma.member.update({
          where: { id: existingTransaction.memberId },
          data: { membershipExpiresAt: newExpiry }
        })
      );
    }

    if (generatedMembershipId && generatedMembershipClass) {
      transactionQueries.push(
        prisma.member.update({
          where: { id: existingTransaction.memberId },
          data: {
            membershipId: generatedMembershipId,
            membershipClass: generatedMembershipClass as any,
            membershipExpiresAt: new Date(Date.UTC(new Date().getFullYear(), 11, 31, 23, 59, 59)),
            ...(existingTransaction.member.systemRole === 'Standard' && (generatedMembershipClass.includes('Technologist') || generatedMembershipClass.includes('Professional'))
              ? { systemRole: 'Mentor' }
              : {}),
            updatedAt: new Date()
          }
        })
      );
    }

    const [updatedTransaction] = await prisma.$transaction(transactionQueries);

    if (generatedMembershipId) {
      try {
        await sendMail(existingTransaction.member.email, 'membershipActivated', {
          name: existingTransaction.member.fullName,
          membershipId: generatedMembershipId,
          category: existingTransaction.application?.category?.categoryName || ''
        });
      } catch (mailErr: any) {
        console.warn('[Verify Payment] Membership activation email failed:', mailErr.message);
      }
    }

    return res.status(200).json({ message: generatedMembershipId
      ? 'Payment cleared and membership credentials issued.'
      : `Payment ${action.toLowerCase()}.`, transaction: updatedTransaction });
  } catch (error: any) {
    console.error('[Verify Payment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error verifying payment.' });
  }
}

// 4. Admin: Get all payments queue (supports filtering by status or all)
export async function getPendingPayments(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { status = 'Pending_Verification', page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
  const take = parseInt(limit as string, 10);
  const whereClause = (status === 'All' || status === 'all') ? {} : { status: status as TransactionStatus };

  try {
    const [transactions, total] = await Promise.all([
      prisma.financialTransaction.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          member: { select: { fullName: true, email: true, isFellow: true, isHonorary: true, honors: true, membershipClass: true } },
          application: { select: { category: { select: { categoryName: true } } } }
        }
      }),
      prisma.financialTransaction.count({
        where: whereClause
      })
    ]);

    // Flatten nested member relation and fetch document file names
    const formattedTransactions = await Promise.all(transactions.map(async tx => {
      let receiptFileName = null;
      if (tx.receiptUrl) {
        const doc = await prisma.uploadedDocument.findUnique({
          where: { id: tx.receiptUrl },
          select: { fileName: true }
        });
        if (doc) {
          receiptFileName = doc.fileName;
        }
      }
      return {
        ...tx,
        full_name: tx.member.fullName,
        email: tx.member.email,
        isFellow: (tx.member as any).isFellow,
        isHonorary: (tx.member as any).isHonorary,
        honors: (tx.member as any).honors || [],
        category: (tx as any).application?.category?.categoryName || (tx.member as any).membershipClass || "Unknown Category",
        member: undefined,
        receiptFileName
      };
    }));

    return res.status(200).json({
      transactions: formattedTransactions,
      pagination: {
        total,
        page: parseInt(page as string, 10),
        limit: take
      }
    });
  } catch (error: any) {
    console.error('[Get Pending Payments] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching payment queue.' });
  }
}
