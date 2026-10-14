import { ApplicationStatus } from '@prisma/client';

export function processingFeeRequiresFailedRetry(status: ApplicationStatus | null): boolean | null {
  if (status === 'Draft' || status === 'Correction_Required') return false;
  if (status === 'Pending' || status === 'Under_Review' || status === 'Pending_Approval') return true;
  return null;
}
