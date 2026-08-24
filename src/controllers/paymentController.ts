import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { TransactionType, PaymentMethod, TransactionStatus, Prisma } from '@prisma/client';
import { deriveMemberClass, getCertificateCode } from '../utils/membershipUtils';
import { sendMail } from '../config/mailer';
import { nextMembershipId } from './progressionController';
import { finalizeApplicationSubmission } from './applicantController';
import * as intouchPay from '../services/intouchPayService';
import { issuePaymentReceipt } from '../services/receiptService';

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
  // action: 'Paid' | 'Failed' | 'Refunded'

  if (!transactionId || !action) {
    return res.status(400).json({ error: 'Missing transactionId or action.' });
  }

  const validActions = ['Paid', 'Failed', 'Refunded'];
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
        application: { include: { category: true, pendingUpgradeCategory: true } }
      }
    });

    if (!existingTransaction || existingTransaction.status !== 'Pending_Verification') {
      return res.status(400).json({ error: 'Transaction not found or already verified.' });
    }

    // A transaction with a providerTransactionId was initiated through the live IntouchPay
    // gateway (see paymentController.initiateProcessingFeePayment) and is only ever resolved
    // by the gateway itself (its callback, or the status-poll fallback) — never by staff.
    // paymentMethod alone can't be used for this check: the manual receipt-upload flow also
    // tags its rows 'MTN_Momo' (meaning "an MTN transfer", not "went through our gateway").
    // Manually flipping a gateway row to Paid would let it be marked paid without money ever
    // actually moving, which is exactly the fraud risk this restriction exists to prevent.
    if (existingTransaction.providerTransactionId) {
      return res.status(400).json({ error: 'Mobile Money payments are verified automatically by the payment gateway and cannot be manually cleared.' });
    }

    const isFirstYearFee = existingTransaction.txType === 'First_Year_Fee';
    let generatedMembershipId: string | null = null;
    let generatedMembershipClass: string | null = null;

    if (action === 'Paid' && isFirstYearFee && existingTransaction.application?.category && !existingTransaction.member.membershipId) {
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

    // Membership-class upgrade (APC pass or Associate award) held pending this
    // exact fee. Only apply the class/ID/role change once it clears.
    const pendingUpgrade = existingTransaction.application?.pendingUpgradeClass
      ? existingTransaction.application
      : null;
    let upgradeMembershipId: string | null = null;

    if (action === 'Paid' && isFirstYearFee && pendingUpgrade && pendingUpgrade.pendingUpgradeCertCode) {
      const currentYear = new Date().getFullYear();
      upgradeMembershipId = await nextMembershipId(`RIQS-${currentYear}-${pendingUpgrade.pendingUpgradeCertCode}-`);
    }

    const transactionQueries: any[] = [
      prisma.financialTransaction.update({
        where: { id: transactionId },
        data: {
          status: action as TransactionStatus,
          verifiedByEmail: req.user.email,
          rejectionReason: rejectionReason || null,
          clearedAt: action === 'Paid' ? new Date() : null
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

    if (action === 'Paid' && (existingTransaction.txType === 'First_Year_Fee' || existingTransaction.txType === 'Annual_Renewal')) {
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

    if (upgradeMembershipId && pendingUpgrade) {
      transactionQueries.push(
        prisma.member.update({
          where: { id: existingTransaction.memberId },
          data: {
            membershipId: upgradeMembershipId,
            membershipClass: pendingUpgrade.pendingUpgradeClass as any,
            membershipExpiresAt: new Date(Date.UTC(new Date().getFullYear(), 11, 31, 23, 59, 59)),
            ...(pendingUpgrade.pendingUpgradePromoteToMentor ? { systemRole: 'Mentor' } : {}),
            updatedAt: new Date()
          }
        }),
        prisma.application.update({
          where: { id: pendingUpgrade.id },
          data: {
            categoryId: pendingUpgrade.pendingUpgradeCategoryId!,
            pendingUpgradeClass: null,
            pendingUpgradeCategoryId: null,
            pendingUpgradeCertCode: null,
            pendingUpgradePromoteToMentor: false
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: existingTransaction.memberId,
            actionByEmail: req.user.email,
            actionType: 'MEMBERSHIP_UPGRADE_ACTIVATED',
            details: `First-year fee cleared. Membership upgraded to ${pendingUpgrade.pendingUpgradeClass}. New ID: ${upgradeMembershipId}.`
          }
        })
      );

      if (pendingUpgrade.pendingUpgradeCategory?.annualRenewalFee) {
        transactionQueries.push(
          prisma.financialTransaction.updateMany({
            where: {
              memberId: existingTransaction.memberId,
              txType: 'Annual_Renewal',
              status: 'Unpaid'
            },
            data: { amount: pendingUpgrade.pendingUpgradeCategory.annualRenewalFee }
          })
        );
      }

      const stampFeeAmount = pendingUpgrade.pendingUpgradeCategory?.stampFee ?? 0;
      if (Number(stampFeeAmount) > 0) {
        transactionQueries.push(
          prisma.financialTransaction.create({
            data: {
              memberId: existingTransaction.memberId,
              applicationId: pendingUpgrade.id,
              amount: stampFeeAmount,
              currency: pendingUpgrade.pendingUpgradeCategory?.currency || 'RWF',
              txType: 'Stamp_Fee',
              paymentMethod: 'Bank_Transfer',
              transactionReference: `STAMP-${upgradeMembershipId}-${Date.now()}`,
              status: 'Unpaid'
            }
          })
        );
      }
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

    if (upgradeMembershipId && pendingUpgrade) {
      try {
        await sendMail(existingTransaction.member.email, 'membershipActivated', {
          name: existingTransaction.member.fullName,
          membershipId: upgradeMembershipId,
          category: pendingUpgrade.pendingUpgradeCategory?.categoryName || ''
        });
      } catch (mailErr: any) {
        console.warn('[Verify Payment] Upgrade activation email failed:', mailErr.message);
      }
    }

    if (action === 'Paid') {
      try {
        await issuePaymentReceipt(transactionId);
      } catch (receiptErr: any) {
        console.error('[Verify Payment] Receipt issuance failed:', receiptErr.message);
      }
    }

    return res.status(200).json({ message: (generatedMembershipId || upgradeMembershipId)
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
  const statusFilter: Prisma.FinancialTransactionWhereInput = (status === 'All' || status === 'all') ? {} : { status: status as TransactionStatus };
  // A row with a providerTransactionId went through the live IntouchPay gateway and is
  // verified automatically (callback/status-poll) — a still-pending one is never actionable
  // by staff and would just be confusing noise here, so it's excluded regardless of which
  // status filter is selected. This is NOT the same test as paymentMethod === 'MTN_Momo':
  // the manual receipt-upload flow also tags its rows 'MTN_Momo' but has no providerTransactionId,
  // and those genuinely need to stay in the queue for staff to review.
  const whereClause: Prisma.FinancialTransactionWhereInput = {
    ...statusFilter,
    NOT: { providerTransactionId: { not: null }, status: 'Pending_Verification' as TransactionStatus }
  };

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

// 5. Member-initiated Mobile Money payment for the application Processing Fee.
// This is the first phase of replacing manual receipt-upload + admin-clearance with
// real IntouchPay payments: the member pays directly, the gateway's callback (or a
// status-poll fallback, in case the callback doesn't arrive) clears the transaction,
// and the application is auto-submitted the moment that fee clears. Manual clearance
// (submitPayment/verifyPayment above) is left untouched for every other fee type.
export async function initiateProcessingFeePayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, mobilephone } = req.body;
  if (!applicationId || !mobilephone) {
    return res.status(400).json({ error: 'applicationId and mobilephone are required.' });
  }

  try {
    const application = await prisma.application.findFirst({
      where: {
        id: applicationId,
        memberId: req.user.id,
        status: { in: ['Draft', 'Correction_Required'] }
      },
      include: { category: true }
    });

    if (!application || !application.category) {
      return res.status(404).json({ error: 'Application not found or not eligible for payment.' });
    }

    const fee = Number(application.category.processingFee || 0);
    if (fee <= 0) {
      return res.status(400).json({ error: 'This category has no processing fee — you can submit directly.' });
    }

    // A processing fee cleared through ANY channel (including the manual upload/admin-clearance
    // flow) counts as paid — don't make the member pay twice. Must match the CURRENT category's
    // fee though: if they paid for one category then switched to a pricier one before submitting,
    // that older payment doesn't cover the difference and shouldn't waive this one.
    const clearedFee = await prisma.financialTransaction.findFirst({
      where: { applicationId, txType: 'Processing_Fee', status: 'Paid', amount: fee }
    });
    if (clearedFee) {
      return res.status(200).json({ status: 'Paid', transactionId: clearedFee.id, message: 'Processing fee already paid.' });
    }

    // Only a transaction WE created for this Mobile Money flow (paymentMethod MTN_Momo,
    // has a providerTransactionId) can be "already in progress" here. A manual-flow row
    // (e.g. an uploaded receipt awaiting admin review) must never block or be reused by
    // this gateway flow — it belongs to a completely separate payment method.
    const existingMomo = await prisma.financialTransaction.findFirst({
      where: { applicationId, txType: 'Processing_Fee', paymentMethod: 'MTN_Momo', providerTransactionId: { not: null } },
      orderBy: { createdAt: 'desc' }
    });

    if (existingMomo?.status === 'Pending_Verification') {
      return res.status(409).json({
        error: 'A payment request is already in progress for this application.',
        transactionId: existingMomo.id
      });
    }

    const requesttransactionid = `PROC-${applicationId.slice(0, 8)}-${Date.now()}`;

    const { data } = await intouchPay.requestPayment({ amount: fee, mobilephone, requesttransactionid });
    console.log('[Initiate Processing Fee Payment] IntouchPay response:', { requesttransactionid, mobilephone, amount: fee, data });

    if (!data?.success) {
      return res.status(422).json({ error: data?.message || 'Payment request was rejected by the mobile money gateway.' });
    }

    const txData = {
      memberId: req.user.id,
      applicationId,
      amount: fee,
      currency: application.category.currency || 'RWF',
      txType: 'Processing_Fee' as TransactionType,
      paymentMethod: 'MTN_Momo' as PaymentMethod,
      transactionReference: requesttransactionid,
      providerTransactionId: requesttransactionid,
      status: 'Pending_Verification' as TransactionStatus,
      rejectionReason: null
    };

    const transaction = existingMomo
      ? await prisma.financialTransaction.update({ where: { id: existingMomo.id }, data: txData })
      : await prisma.financialTransaction.create({ data: txData });

    return res.status(200).json({
      status: 'Pending',
      transactionId: transaction.id,
      message: data.message || 'Payment request sent. Approve the prompt on your phone to complete payment.'
    });
  } catch (err: any) {
    console.error('[Initiate Processing Fee Payment] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error initiating payment.' });
  }
}

// 6. Member polls this to find out whether their Processing Fee payment has cleared.
// Primarily driven by the IntouchPay callback (see intouchPayController.receivePaymentCallback),
// but if the callback is delayed this actively re-checks with IntouchPay's GetTransactionStatus
// as a fallback so the member's UI isn't left hanging.
export async function getProcessingFeePaymentStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { transactionId } = req.params;

  try {
    let transaction = await prisma.financialTransaction.findFirst({
      where: { id: transactionId, memberId: req.user.id, txType: 'Processing_Fee' }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (transaction.status === 'Pending_Verification' && transaction.providerTransactionId) {
      try {
        const { data } = await intouchPay.getTransactionStatus({ requesttransactionid: transaction.providerTransactionId });
        if (data?.success && data?.status) {
          transaction = await applyProcessingFeeGatewayResult(transaction, data.status, data.statusdesc);
        }
      } catch (pollErr: any) {
        console.warn('[Processing Fee Status] Gateway status poll failed:', pollErr.message);
      }
    }

    return res.status(200).json({
      status: transaction.status,
      transactionId: transaction.id,
      applicationId: transaction.applicationId,
      rejectionReason: transaction.rejectionReason
    });
  } catch (error: any) {
    console.error('[Processing Fee Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error checking payment status.' });
  }
}

// Shared by the callback receiver and the status-poll fallback above: applies a final
// gateway status (Success/Failed, as reported by IntouchPay) to a Pending_Verification
// Processing_Fee transaction, and auto-finalizes the application submission on success.
// A non-final status (still pending gateway-side) is a no-op — the row is left untouched.
async function applyProcessingFeeGatewayResult(
  transaction: { id: string; txType: TransactionType; applicationId: string | null },
  gatewayStatus?: string,
  gatewayStatusDesc?: string
) {
  const normalized = (gatewayStatus || '').toLowerCase();
  const isSuccess = normalized.includes('success');
  const isFailure = normalized.includes('fail') || normalized.includes('reject') || normalized.includes('cancel') || normalized.includes('timeout');

  if (!isSuccess && !isFailure) {
    return prisma.financialTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
  }

  const updated = await prisma.financialTransaction.update({
    where: { id: transaction.id },
    data: isSuccess
      ? { status: 'Paid', clearedAt: new Date(), rejectionReason: null }
      : { status: 'Failed', rejectionReason: gatewayStatusDesc || 'Payment was not completed.' }
  });

  if (isSuccess && updated.txType === 'Processing_Fee' && updated.applicationId) {
    try {
      await finalizeApplicationSubmission(updated.applicationId);
    } catch (finalizeErr: any) {
      console.error('[Processing Fee] Auto-finalize after payment failed:', finalizeErr.message);
    }
  }

  if (isSuccess) {
    try {
      await issuePaymentReceipt(updated.id);
    } catch (receiptErr: any) {
      console.error('[Processing Fee] Receipt issuance failed:', receiptErr.message);
    }
  }

  return updated;
}

// Called by intouchPayController.receivePaymentCallback once IntouchPay reports the final
// outcome of a member-initiated Processing Fee payment. Looks the transaction up by the
// requesttransactionid we generated when initiating it — returns null if no such payment
// was ever initiated through this flow (e.g. an admin-initiated IntouchPay request).
export async function resolveProcessingFeePaymentByProviderId(
  requesttransactionid: string,
  gatewayStatus?: string,
  gatewayStatusDesc?: string
) {
  const transaction = await prisma.financialTransaction.findUnique({ where: { providerTransactionId: requesttransactionid } });
  if (!transaction || transaction.txType !== 'Processing_Fee') return null;
  if (transaction.status !== 'Pending_Verification') return transaction;
  return applyProcessingFeeGatewayResult(transaction, gatewayStatus, gatewayStatusDesc);
}
