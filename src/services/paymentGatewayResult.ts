export function paymentOutcome(status?: string): 'success' | 'failure' | 'pending' {
  const normalized = (status || '').trim().toUpperCase();
  if (['SUCCESS', 'SUCCESSFUL', 'VALID', 'PENDING_SETTLEMENT'].includes(normalized)) return 'success';
  if (['FAILED', 'FAILURE', 'UNSUCCESSFUL', 'REJECTED', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'TIMED_OUT', 'EXPIRED', 'REVERSED', 'REFUNDED'].includes(normalized)) return 'failure';
  return 'pending';
}

// An API-level message such as "Successful" describes the request, not the payment.
export function paymentFailureReason(raw: any): string | undefined {
  if (paymentOutcome(raw?.data?.transaction_status) !== 'failure') return undefined;
  const reason = [raw?.data?.reason, raw?.data?.failure_reason, raw?.data?.rejection_reason, raw?.reason]
    .find(value => typeof value === 'string' && value.trim());
  return reason?.trim() || 'Payment was not completed.';
}

export const PAYMENT_RETRY_GUIDANCE = 'Before retrying, check that you entered the correct MTN Mobile Money or Airtel Money number and that your wallet has enough funds to cover the payment and any applicable charges.';
