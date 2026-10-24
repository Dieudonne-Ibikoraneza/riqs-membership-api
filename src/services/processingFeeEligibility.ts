import { ApplicationStatus, Prisma } from '@prisma/client';

export function processingFeeSubmissionWhere(applicationId: string, amount: number): Prisma.FinancialTransactionWhereInput {
  return {
    applicationId,
    txType: 'Processing_Fee',
    amount,
    OR: [
      { status: 'Paid' },
      {
        status: 'Pending_Verification',
        providerTransactionId: null,
        paymentMethod: { in: ['Manual_Payment', 'Bank_Transfer', 'Manual_Cash'] },
        receiptUrl: { not: null }
      }
    ]
  };
}

export function processingFeeRequiresFailedRetry(status: ApplicationStatus | null): boolean | null {
  if (status === 'Draft' || status === 'Correction_Required') return false;
  if (status === 'Pending' || status === 'Under_Review' || status === 'Pending_Approval') return true;
  return null;
}
