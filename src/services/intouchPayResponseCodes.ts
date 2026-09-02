// Maps IntouchPay's own `responsecode` values (from the HTTP Interface to IntouchPay
// Payments Gateway spec) to the HTTP status our API should return to the caller.
// Anything not listed falls back to 500 (unexpected/unmapped gateway condition).

export const BALANCE_CODE_STATUS: Record<string, number> = {
  '0002': 400, // Missing Username Information
  '0003': 400, // Missing Password Information
  '0004': 400, // Missing Date Information
  '0005': 401, // Invalid Password
  '0006': 401, // User Does not have an intouchPay Account
  '0007': 404, // No such user
  '0008': 401  // Failed to Authenticate
};

export const TRANSACTION_STATUS_CODE_STATUS: Record<string, number> = {
  '3000': 400, // Missing Transaction ID Information
  '3200': 400, // Missing Request Transaction ID Information
  '3100': 404  // Transaction Doesn't Exist
};

export const PAYMENT_CODE_STATUS: Record<string, number> = {
  '0002': 400, '0003': 400, '0004': 400,
  '0005': 401, '0006': 401, '0007': 404, '0008': 401,
  '2100': 422, // Amount should be greater than 0
  '2200': 422, // Amount below minimum
  '2300': 422, // Amount above maximum
  '2400': 409, // Duplicate Transaction ID
  '2500': 404, // Route Not Found
  '2600': 422, // Operation Not Allowed
  '2700': 500, // Failed to Complete Transaction
  '1005': 422, // Failed Due to Insufficient Funds
  '1002': 422, // Mobile number not registered on mobile money
  '1008': 500, // General Failure
  '1200': 422, // Invalid Number
  '1100': 422, // Number not supported on this Mobile money network
  '1300': 500  // Failed to Complete Transaction, Unknown Exception
};

// RequestDeposit shares the same response-code taxonomy as RequestPayment per IntouchPay's
// gateway spec (both are just "send a mobile money transaction" operations, one pull one push).
// Commented out alongside requestDeposit (see intouchPayService.ts/intouchPayController.ts) —
// built and confirmed working, kept for future use rather than wired in right now.
// export const DEPOSIT_CODE_STATUS: Record<string, number> = PAYMENT_CODE_STATUS;

export function statusForCode(map: Record<string, number>, code?: string | number | null, fallback = 500): number {
  if (code === undefined || code === null) return fallback;
  return map[String(code)] ?? fallback;
}
