import crypto from 'crypto';

const BASE_URL = process.env.INTOUCHPAY_BASE_URL || 'https://developer.intouchpay.co.rw/api/v1/sandbox';
const USERNAME = process.env.INTOUCH_USERNAME || '';
const ACCOUNT_NO = process.env.INTOUCH_ACCOUNT_NO || '';
const PARTNER_PASSWORD = process.env.INTOUCH_PARTNER_PASSWORD || '';

// yyyymmddhhmmss in UTC, as required by the IntouchPay password/signature scheme.
export function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

// password = sha256(username + accountno + partnerpassword + timestamp).hexdigest()
export function generatePassword(timestamp: string): string {
  return crypto
    .createHash('sha256')
    .update(`${USERNAME}${ACCOUNT_NO}${PARTNER_PASSWORD}${timestamp}`)
    .digest('hex');
}

async function postToIntouchPay(path: string, body: Record<string, any>) {
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) payload[key] = value;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { httpStatus: response.status, data };
}

export async function getBalance() {
  const timestamp = generateTimestamp();
  const password = generatePassword(timestamp);

  return postToIntouchPay('/getbalance/', {
    username: USERNAME,
    timestamp,
    accountno: ACCOUNT_NO,
    password
  });
}

export async function getTransactionStatus(params: { requesttransactionid: string; transactionid?: string }) {
  const timestamp = generateTimestamp();
  const password = generatePassword(timestamp);

  return postToIntouchPay('/gettransactionstatus/', {
    username: USERNAME,
    timestamp,
    password,
    requesttransactionid: params.requesttransactionid,
    transactionid: params.transactionid || ''
  });
}

export async function requestPayment(params: {
  amount: string | number;
  mobilephone: string | number;
  requesttransactionid: string;
}) {
  const timestamp = generateTimestamp();
  const password = generatePassword(timestamp);

  return postToIntouchPay('/requestpayment/', {
    username: USERNAME,
    timestamp,
    password,
    accountno: ACCOUNT_NO,
    amount: params.amount,
    mobilephone: params.mobilephone,
    requesttransactionid: params.requesttransactionid,
    callbackurl: process.env.INTOUCH_CALLBACK_URL || ''
  });
}

// RequestDeposit — Sending Payment (disbursement to a subscriber), the mirror image of
// RequestPayment: instead of collecting money from a subscriber's mobile money wallet, this
// pushes money from the App's IntouchPay account out to one. Same async Pending-then-callback
// flow as RequestPayment, but its own payload shape per IntouchPay's spec — no accountno or
// callbackurl; instead a withdrawcharge, a free-text reason, and a fixed "sid" (service id).
//
// Commented out (not deleted) at the user's request — built and confirmed working, kept
// on ice for future use rather than wired into the live routes right now.
// export async function requestDeposit(params: {
//   amount: string | number;
//   withdrawcharge: string | number;
//   reason: string;
//   mobilephone: string | number;
//   requesttransactionid: string;
// }) {
//   const timestamp = generateTimestamp();
//   const password = generatePassword(timestamp);
//
//   return postToIntouchPay('/requestdeposit/', {
//     username: USERNAME,
//     timestamp,
//     amount: params.amount,
//     withdrawcharge: params.withdrawcharge,
//     reason: params.reason,
//     password,
//     sid: process.env.INTOUCH_SID || '1',
//     mobilephone: params.mobilephone,
//     requesttransactionid: params.requesttransactionid
//   });
// }
