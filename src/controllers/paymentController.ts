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
          rejectionReason: null, // clear previous reason
          // If this row was previously used for a (failed) gateway attempt — e.g. the member
          // tried Mobile Money first, it failed, and they fell back to manual upload — it would
          // still carry that attempt's providerTransactionId. verifyPayment refuses to manually
          // clear any row with one set (that's precisely what stops staff from rubber-stamping
          // an unpaid gateway transaction), which would otherwise permanently lock staff out of
          // reviewing this now-manual submission. A manual submission never goes through the
          // gateway, so it must never carry one.
          providerTransactionId: null
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
    // gateway (see paymentController.initiateProcessingFeePayment) and its payment veracity is
    // only ever resolved by the gateway itself (its callback, or the status-poll fallback) —
    // never by staff. paymentMethod alone can't be used for this check: the manual
    // receipt-upload flow also tags its rows 'MTN_Momo' (meaning "an MTN transfer", not "went
    // through our gateway"). Manually flipping a still-unresolved gateway row to Paid would let
    // it be marked paid without money ever actually moving, which is exactly the fraud risk
    // this restriction exists to prevent.
    //
    // The one carve-out: an Annual_Renewal row the gateway already confirmed (clearedAt is
    // set — see applyGatewayFeeResult) is deliberately held in Pending_Verification pending an
    // Admin/Admin Assistant's CPD/Annual Report review, not because the payment is in doubt.
    // Staff confirming 'Paid' there is signing off on CPD compliance, not re-verifying money
    // that's already cleared — so it's exempt from the block. Failed/Refunded stay blocked
    // unconditionally for any gateway row: reversing a confirmed gateway payment is a real
    // refund action, out of scope for this endpoint.
    const isClearedAnnualRenewalAwaitingCpdReview =
      existingTransaction.txType === 'Annual_Renewal' && existingTransaction.clearedAt !== null;
    if (existingTransaction.providerTransactionId && !(action === 'Paid' && isClearedAnnualRenewalAwaitingCpdReview)) {
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

    // Manually-uploaded processing-fee proofs (bank slip / other method) block application
    // submission until a staff member clears them — previously the member had no way to
    // find out the outcome except by going back to the application page and trying to
    // resubmit blind. Notify them either way so they know to come back and resubmit.
    if (existingTransaction.txType === 'Processing_Fee' && (action === 'Paid' || action === 'Failed')) {
      try {
        await sendMail(
          existingTransaction.member.email,
          action === 'Paid' ? 'paymentProofCleared' : 'paymentProofFailed',
          {
            name: existingTransaction.member.fullName,
            amount: Number(existingTransaction.amount).toLocaleString(),
            currency: existingTransaction.currency,
            categoryName: existingTransaction.application?.category?.categoryName || '',
            rejectionReason: rejectionReason || 'The submitted proof could not be verified.'
          }
        );
      } catch (mailErr: any) {
        console.error('[Verify Payment] Proof-of-payment result email failed:', mailErr.message);
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
  // A row with a providerTransactionId went through the live IntouchPay gateway. One still
  // awaiting the gateway's own callback/status-poll (clearedAt not yet set) is never actionable
  // by staff and would just be confusing noise here, so it's excluded regardless of which
  // status filter is selected. This is NOT the same test as paymentMethod === 'MTN_Momo':
  // the manual receipt-upload flow also tags its rows 'MTN_Momo' but has no providerTransactionId,
  // and those genuinely need to stay in the queue for staff to review.
  //
  // The one exception: an Annual_Renewal row the gateway *has* already confirmed (clearedAt
  // set) deliberately stays Pending_Verification pending an Admin/Admin Assistant's CPD/Annual
  // Report review — see applyGatewayFeeResult — so it must stay visible here, not be swept up
  // by this same exclusion.
  const whereClause: Prisma.FinancialTransactionWhereInput = {
    ...statusFilter,
    NOT: {
      providerTransactionId: { not: null },
      status: 'Pending_Verification' as TransactionStatus,
      clearedAt: null
    }
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
          transaction = await applyGatewayFeeResult(transaction, data.status, data.statusdesc);
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

// The Mobile Money gateway flow, generalized: originally built for Processing_Fee only,
// now also used by Annual_Renewal and First_Year_Fee (the latter covers both a fresh
// membership's first-year fee and a mentorship/APC upgrade's pending-upgrade fee — see
// initiateFirstYearFeePayment/getFirstYearFeePaymentStatus below). Member-initiated real
// IntouchPay payments for any of these fee types land here.
const GATEWAY_ENABLED_TX_TYPES: TransactionType[] = ['Processing_Fee', 'Annual_Renewal', 'First_Year_Fee'];

// Shared by the callback receiver and the status-poll fallbacks above: applies a final
// gateway status (Success/Failed, as reported by IntouchPay) to a Pending_Verification
// transaction, and applies whatever side effect that fee type needs once cleared —
// auto-finalizing application submission for Processing_Fee, and activating the pending
// membership/upgrade for First_Year_Fee (mirroring verifyPayment's manual-clearance
// branches, since this gateway path never goes through that admin endpoint).
//
// Annual_Renewal is the one exception: RIQS requires an Admin/Admin Assistant to review the
// member's CPD/Annual Report before a renewal is complete — the same standard the manual
// receipt-upload path already holds every renewal to. A successful gateway payment alone
// only proves the money moved, so it stays in Pending_Verification (with clearedAt set to
// record that the payment itself is confirmed) instead of jumping straight to Paid; the
// membership expiry is only extended once that CPD review happens via verifyPayment.
//
// A non-final status (still pending gateway-side) is a no-op — the row is left untouched.
async function applyGatewayFeeResult(
  transaction: { id: string; txType: TransactionType; applicationId: string | null; memberId: string },
  gatewayStatus?: string,
  gatewayStatusDesc?: string
) {
  const normalized = (gatewayStatus || '').toLowerCase();
  const isSuccess = normalized.includes('success');
  const isFailure = normalized.includes('fail') || normalized.includes('reject') || normalized.includes('cancel') || normalized.includes('timeout');

  if (!isSuccess && !isFailure) {
    return prisma.financialTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
  }

  const awaitsCpdReview = isSuccess && transaction.txType === 'Annual_Renewal';

  const updated = await prisma.financialTransaction.update({
    where: { id: transaction.id },
    data: isSuccess
      ? (awaitsCpdReview
          ? { clearedAt: new Date(), rejectionReason: null } // status stays Pending_Verification
          : { status: 'Paid', clearedAt: new Date(), rejectionReason: null })
      : { status: 'Failed', rejectionReason: gatewayStatusDesc || 'Payment was not completed.' }
  });

  if (isSuccess && updated.txType === 'Processing_Fee' && updated.applicationId) {
    try {
      await finalizeApplicationSubmission(updated.applicationId);
    } catch (finalizeErr: any) {
      console.error('[Payment Gateway] Auto-finalize after payment failed:', finalizeErr.message);
    }
  }

  if (isSuccess && updated.txType === 'First_Year_Fee') {
    try {
      await finalizeFirstYearFeeGatewayClearance(updated.id);
    } catch (upgradeErr: any) {
      console.error('[Payment Gateway] First-year fee membership activation failed:', upgradeErr.message);
    }
  }

  if (isSuccess) {
    try {
      await issuePaymentReceipt(updated.id);
    } catch (receiptErr: any) {
      console.error('[Payment Gateway] Receipt issuance failed:', receiptErr.message);
    }
  }

  return updated;
}

// Mirrors the First_Year_Fee branch of verifyPayment's manual-clearance logic (membership ID
// issuance for a brand-new member, or activating a pending mentorship/APC upgrade), for a
// payment that cleared automatically through the Mobile Money gateway instead of an admin
// action. Kept as its own copy rather than shared with verifyPayment: that function weaves
// its version into one $transaction batch alongside the admin's own audit trail entry, which
// doesn't apply here.
async function finalizeFirstYearFeeGatewayClearance(transactionId: string) {
  const transaction = await prisma.financialTransaction.findUnique({
    where: { id: transactionId },
    include: {
      member: true,
      application: { include: { category: true, pendingUpgradeCategory: true } }
    }
  });
  if (!transaction || !transaction.application) return;

  const application = transaction.application;
  const member = transaction.member;

  let generatedMembershipId: string | null = null;
  let generatedMembershipClass: string | null = null;
  if (application.category && !member.membershipId) {
    const currentYear = new Date().getFullYear();
    const certCode = getCertificateCode(application.category.categoryCode);
    const prefix = `RIQS-${currentYear}-${certCode}-`;
    const lastMember = await prisma.member.findFirst({
      where: { membershipId: { startsWith: prefix } },
      orderBy: { membershipId: 'desc' }
    });
    const lastNumber = lastMember?.membershipId?.split('-').pop();
    const nextNumber = lastNumber && !isNaN(Number(lastNumber)) ? Number(lastNumber) + 1 : 1;
    generatedMembershipId = `${prefix}${String(nextNumber).padStart(4, '0')}`;
    generatedMembershipClass = deriveMemberClass(application.category.categoryCode);
  }

  const pendingUpgrade = application.pendingUpgradeClass ? application : null;
  let upgradeMembershipId: string | null = null;
  if (pendingUpgrade && pendingUpgrade.pendingUpgradeCertCode) {
    const currentYear = new Date().getFullYear();
    upgradeMembershipId = await nextMembershipId(`RIQS-${currentYear}-${pendingUpgrade.pendingUpgradeCertCode}-`);
  }

  const ops: any[] = [];

  if (generatedMembershipId && generatedMembershipClass) {
    ops.push(prisma.member.update({
      where: { id: member.id },
      data: {
        membershipId: generatedMembershipId,
        membershipClass: generatedMembershipClass as any,
        membershipExpiresAt: new Date(Date.UTC(new Date().getFullYear(), 11, 31, 23, 59, 59)),
        ...(member.systemRole === 'Standard' && (generatedMembershipClass.includes('Technologist') || generatedMembershipClass.includes('Professional'))
          ? { systemRole: 'Mentor' }
          : {}),
        updatedAt: new Date()
      }
    }));
  }

  if (upgradeMembershipId && pendingUpgrade) {
    ops.push(
      prisma.member.update({
        where: { id: member.id },
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
          memberId: member.id,
          actionByEmail: member.email,
          actionType: 'MEMBERSHIP_UPGRADE_ACTIVATED',
          details: `First-year fee cleared via Mobile Money gateway. Membership upgraded to ${pendingUpgrade.pendingUpgradeClass}. New ID: ${upgradeMembershipId}.`
        }
      })
    );

    if (pendingUpgrade.pendingUpgradeCategory?.annualRenewalFee) {
      ops.push(prisma.financialTransaction.updateMany({
        where: { memberId: member.id, txType: 'Annual_Renewal', status: 'Unpaid' },
        data: { amount: pendingUpgrade.pendingUpgradeCategory.annualRenewalFee }
      }));
    }

    const stampFeeAmount = pendingUpgrade.pendingUpgradeCategory?.stampFee ?? 0;
    if (Number(stampFeeAmount) > 0) {
      ops.push(prisma.financialTransaction.create({
        data: {
          memberId: member.id,
          applicationId: pendingUpgrade.id,
          amount: stampFeeAmount,
          currency: pendingUpgrade.pendingUpgradeCategory?.currency || 'RWF',
          txType: 'Stamp_Fee',
          paymentMethod: 'Bank_Transfer',
          transactionReference: `STAMP-${upgradeMembershipId}-${Date.now()}`,
          status: 'Unpaid'
        }
      }));
    }
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops);
  }

  if (generatedMembershipId) {
    try {
      await sendMail(member.email, 'membershipActivated', {
        name: member.fullName,
        membershipId: generatedMembershipId,
        category: application.category?.categoryName || ''
      });
    } catch (mailErr: any) {
      console.warn('[Payment Gateway] Membership activation email failed:', mailErr.message);
    }
  }

  if (upgradeMembershipId && pendingUpgrade) {
    try {
      await sendMail(member.email, 'membershipActivated', {
        name: member.fullName,
        membershipId: upgradeMembershipId,
        category: pendingUpgrade.pendingUpgradeCategory?.categoryName || ''
      });
    } catch (mailErr: any) {
      console.warn('[Payment Gateway] Upgrade activation email failed:', mailErr.message);
    }
  }
}

// Called by intouchPayController.receivePaymentCallback once IntouchPay reports the final
// outcome of a member-initiated gateway payment (Processing_Fee, Annual_Renewal, or
// First_Year_Fee). Looks the transaction up by the requesttransactionid we generated when
// initiating it — returns null if no such payment was ever initiated through this flow.
export async function resolveProcessingFeePaymentByProviderId(
  requesttransactionid: string,
  gatewayStatus?: string,
  gatewayStatusDesc?: string
) {
  const transaction = await prisma.financialTransaction.findUnique({ where: { providerTransactionId: requesttransactionid } });
  if (!transaction || !GATEWAY_ENABLED_TX_TYPES.includes(transaction.txType)) return null;
  if (transaction.status !== 'Pending_Verification') return transaction;
  return applyGatewayFeeResult(transaction, gatewayStatus, gatewayStatusDesc);
}

// 7. Member-initiated Annual Renewal payment via the same Mobile Money gateway used for the
// Processing Fee in the application flow — mirrors initiateProcessingFeePayment above, but
// this fee is tied to the member directly (renewals happen well after the application is
// submitted/approved) rather than gated behind an in-progress Draft application.
export async function initiateAnnualRenewalPayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { mobilephone, cpdDocumentUrl } = req.body;
  if (!mobilephone) {
    return res.status(400).json({ error: 'mobilephone is required.' });
  }
  // The CPD/Annual Report is a renewal requirement regardless of how the fee itself is paid
  // (the manual receipt-upload path already enforces this on submitPayment) — attach it here
  // too so it's on the transaction for the Admin Assistant to review once the gateway confirms
  // payment, instead of the payment silently skipping that check.
  if (!cpdDocumentUrl) {
    return res.status(400).json({ error: 'cpdDocumentUrl is required — upload your CPD/Annual Report before paying.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: req.user.id } });
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    // Already in flight via this gateway?
    const alreadyInProgress = await prisma.financialTransaction.findFirst({
      where: { memberId: req.user.id, txType: 'Annual_Renewal', status: 'Pending_Verification', providerTransactionId: { not: null } }
    });
    if (alreadyInProgress) {
      return res.status(409).json({
        error: 'A payment request is already in progress.',
        transactionId: alreadyInProgress.id
      });
    }

    // The daily renewal cron (see cronJobs.ts) proactively creates an Unpaid Annual_Renewal
    // placeholder ~30 days before expiry (and the manual-upload path can also leave one behind
    // in Failed after a rejection) — reuse that same row rather than creating a second,
    // competing one. Without this, a successful gateway payment would clear its own new row
    // while the original placeholder stayed Unpaid forever, so the Payments page would keep
    // showing "Renewal Due" even after the member had actually paid.
    const outstandingFee = await prisma.financialTransaction.findFirst({
      where: { memberId: req.user.id, txType: 'Annual_Renewal', status: { in: ['Unpaid', 'Failed'] } },
      orderBy: { createdAt: 'desc' }
    });

    let fee: number;
    let currency: string;
    let applicationId: string | null;

    if (outstandingFee) {
      // The placeholder already carries the correct amount/currency for this billing cycle
      // (possibly bumped after a mentorship/APC upgrade — see finalizeFirstYearFeeGatewayClearance).
      fee = Number(outstandingFee.amount);
      currency = outstandingFee.currency;
      applicationId = outstandingFee.applicationId;
    } else {
      // No placeholder yet (e.g. member is renewing early, ahead of the cron) — compute fresh.
      const application = await prisma.application.findFirst({
        where: { memberId: req.user.id },
        include: { category: true },
        orderBy: { createdAt: 'desc' }
      });

      // Prefer the category matching the member's current membership class (covers a
      // post-upgrade renewal, where the application's original category may be stale),
      // falling back to the application's own category.
      let category = application?.category || null;
      if (member.membershipClass) {
        const currentCategory = await prisma.membershipCategory.findFirst({ where: { categoryName: member.membershipClass } });
        if (currentCategory) category = currentCategory;
      }

      fee = Number(category?.annualRenewalFee || 0);
      currency = category?.currency || 'RWF';
      applicationId = application?.id || null;

      if (fee <= 0) {
        return res.status(400).json({ error: 'Unable to determine your annual renewal fee. Please contact the secretariat.' });
      }
    }

    const requesttransactionid = `RENEW-${req.user.id.slice(0, 8)}-${Date.now()}`;

    const { data } = await intouchPay.requestPayment({ amount: fee, mobilephone, requesttransactionid });
    console.log('[Initiate Annual Renewal Payment] IntouchPay response:', { requesttransactionid, mobilephone, amount: fee, data });

    if (!data?.success) {
      return res.status(422).json({ error: data?.message || 'Payment request was rejected by the mobile money gateway.' });
    }

    const gatewayFields = {
      paymentMethod: 'MTN_Momo' as PaymentMethod,
      transactionReference: requesttransactionid,
      providerTransactionId: requesttransactionid,
      status: 'Pending_Verification' as TransactionStatus,
      rejectionReason: null,
      cpdDocumentUrl: cpdDocumentUrl as string
    };

    const transaction = outstandingFee
      ? await prisma.financialTransaction.update({ where: { id: outstandingFee.id }, data: gatewayFields })
      : await prisma.financialTransaction.create({
          data: {
            memberId: req.user.id,
            applicationId,
            amount: fee,
            currency,
            txType: 'Annual_Renewal' as TransactionType,
            ...gatewayFields
          }
        });

    return res.status(200).json({
      status: 'Pending',
      transactionId: transaction.id,
      message: data.message || 'Payment request sent. Approve the prompt on your phone to complete payment.'
    });
  } catch (err: any) {
    console.error('[Initiate Annual Renewal Payment] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error initiating payment.' });
  }
}

// 8. Member polls this to find out whether their Annual Renewal payment has cleared —
// mirrors getProcessingFeePaymentStatus above.
export async function getAnnualRenewalPaymentStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { transactionId } = req.params;

  try {
    let transaction = await prisma.financialTransaction.findFirst({
      where: { id: transactionId, memberId: req.user.id, txType: 'Annual_Renewal' }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    // Once clearedAt is set the gateway has already confirmed this payment (see
    // applyGatewayFeeResult) — status deliberately stays Pending_Verification pending CPD
    // review, so there's nothing further to poll IntouchPay for.
    if (transaction.status === 'Pending_Verification' && transaction.providerTransactionId && !transaction.clearedAt) {
      try {
        const { data } = await intouchPay.getTransactionStatus({ requesttransactionid: transaction.providerTransactionId });
        if (data?.success && data?.status) {
          transaction = await applyGatewayFeeResult(transaction, data.status, data.statusdesc);
        }
      } catch (pollErr: any) {
        console.warn('[Annual Renewal Status] Gateway status poll failed:', pollErr.message);
      }
    }

    return res.status(200).json({
      status: transaction.status,
      transactionId: transaction.id,
      rejectionReason: transaction.rejectionReason,
      // The payment cleared through the gateway but this fee type always still needs an
      // Admin/Admin Assistant to confirm the member's CPD/Annual Report before the renewal
      // is complete — see applyGatewayFeeResult.
      awaitingReview: transaction.status === 'Pending_Verification' && Boolean(transaction.clearedAt)
    });
  } catch (error: any) {
    console.error('[Annual Renewal Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error checking payment status.' });
  }
}

// 9. Member-initiated First Year Fee payment via the same Mobile Money gateway — covers
// both a brand-new membership's first-year fee and a mentorship/APC upgrade's pending-upgrade
// fee (see progressionController.ts: gradeApc / awardAssociate, which create the Unpaid
// placeholder row this reuses). Mirrors initiateProcessingFeePayment/initiateAnnualRenewalPayment,
// but reuses the existing Unpaid/Failed row in place (rather than creating a separate MTN_Momo
// row alongside it) so the manual-upload path and this gateway path never leave two competing
// rows for the same fee.
export async function initiateFirstYearFeePayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { mobilephone } = req.body;
  if (!mobilephone) {
    return res.status(400).json({ error: 'mobilephone is required.' });
  }

  try {
    const alreadyInProgress = await prisma.financialTransaction.findFirst({
      where: { memberId: req.user.id, txType: 'First_Year_Fee', status: 'Pending_Verification', providerTransactionId: { not: null } }
    });
    if (alreadyInProgress) {
      return res.status(409).json({
        error: 'A payment request is already in progress.',
        transactionId: alreadyInProgress.id
      });
    }

    const outstandingFee = await prisma.financialTransaction.findFirst({
      where: { memberId: req.user.id, txType: 'First_Year_Fee', status: { in: ['Unpaid', 'Failed'] } },
      orderBy: { createdAt: 'desc' }
    });
    if (!outstandingFee) {
      return res.status(400).json({ error: 'No outstanding first-year fee found for your account.' });
    }

    const fee = Number(outstandingFee.amount);
    const requesttransactionid = `FYF-${req.user.id.slice(0, 8)}-${Date.now()}`;

    const { data } = await intouchPay.requestPayment({ amount: fee, mobilephone, requesttransactionid });
    console.log('[Initiate First Year Fee Payment] IntouchPay response:', { requesttransactionid, mobilephone, amount: fee, data });

    if (!data?.success) {
      return res.status(422).json({ error: data?.message || 'Payment request was rejected by the mobile money gateway.' });
    }

    const transaction = await prisma.financialTransaction.update({
      where: { id: outstandingFee.id },
      data: {
        paymentMethod: 'MTN_Momo',
        transactionReference: requesttransactionid,
        providerTransactionId: requesttransactionid,
        status: 'Pending_Verification',
        rejectionReason: null
      }
    });

    return res.status(200).json({
      status: 'Pending',
      transactionId: transaction.id,
      message: data.message || 'Payment request sent. Approve the prompt on your phone to complete payment.'
    });
  } catch (err: any) {
    console.error('[Initiate First Year Fee Payment] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error initiating payment.' });
  }
}

// 10. Member polls this to find out whether their First Year Fee payment has cleared —
// mirrors getProcessingFeePaymentStatus/getAnnualRenewalPaymentStatus above.
export async function getFirstYearFeePaymentStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { transactionId } = req.params;

  try {
    let transaction = await prisma.financialTransaction.findFirst({
      where: { id: transactionId, memberId: req.user.id, txType: 'First_Year_Fee' }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (transaction.status === 'Pending_Verification' && transaction.providerTransactionId) {
      try {
        const { data } = await intouchPay.getTransactionStatus({ requesttransactionid: transaction.providerTransactionId });
        if (data?.success && data?.status) {
          transaction = await applyGatewayFeeResult(transaction, data.status, data.statusdesc);
        }
      } catch (pollErr: any) {
        console.warn('[First Year Fee Status] Gateway status poll failed:', pollErr.message);
      }
    }

    return res.status(200).json({
      status: transaction.status,
      transactionId: transaction.id,
      rejectionReason: transaction.rejectionReason
    });
  } catch (error: any) {
    console.error('[First Year Fee Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error checking payment status.' });
  }
}
