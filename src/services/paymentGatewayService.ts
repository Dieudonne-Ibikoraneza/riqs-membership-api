/** UrubutoPay adapter kept behind the application's provider-neutral gateway surface. */
import crypto from 'crypto';
import { paymentFailureReason, paymentOutcome, PAYMENT_RETRY_GUIDANCE } from './paymentGatewayResult';

const BASE_URL = (process.env.URUBUTOPAY_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.URUBUTOPAY_API_KEY || '';
const MERCHANT_CODE = process.env.URUBUTOPAY_MERCHANT_CODE || '';
const SERVICE_CODE = process.env.URUBUTOPAY_SERVICE_CODE || '';

function authorizationValue() {
  return API_KEY.startsWith('upg:') ? API_KEY : `upg:${API_KEY}`;
}

export function gatewayAuthHeader(): 'x-api-key' | 'Authorization' {
  const environment = (process.env.URUBUTOPAY_ENVIRONMENT || '').trim().toLowerCase();
  if (environment && !['testing', 'live'].includes(environment)) {
    throw new Error('URUBUTOPAY_ENVIRONMENT must be testing or live');
  }
  const host = new URL(BASE_URL).hostname;
  const detected = host === 'staging.urubutopay.rw' ? 'testing'
    : host === 'urubutopay.rw' ? 'live' : undefined;
  if (environment && detected && environment !== detected) {
    throw new Error('URUBUTOPAY_ENVIRONMENT does not match URUBUTOPAY_BASE_URL');
  }
  return (environment || detected) === 'testing' ? 'x-api-key' : 'Authorization';
}

export type UrubutoPaymentParams = {
  amount: string | number;
  mobilephone: string | number;
  requesttransactionid: string;
  payerCode?: string;
  payerNames?: string;
  payerEmail?: string;
  channelName?: 'MOMO' | 'AIRTEL_MONEY' | 'CARD';
  redirectionUrl?: string;
};

function requireConfig(needsService = false) {
  const missing = [
    !BASE_URL && 'URUBUTOPAY_BASE_URL',
    !API_KEY && 'URUBUTOPAY_API_KEY',
    !MERCHANT_CODE && 'URUBUTOPAY_MERCHANT_CODE',
    needsService && !SERVICE_CODE && 'URUBUTOPAY_SERVICE_CODE'
  ].filter(Boolean);
  if (missing.length) throw new Error(`UrubutoPay configuration is incomplete: ${missing.join(', ')}`);
  if (/\/(?:v2|reference)(?:\/|$)/i.test(BASE_URL)) {
    throw new Error('URUBUTOPAY_BASE_URL must exclude /v2 and /reference');
  }
  if (new URL(BASE_URL).protocol !== 'https:') throw new Error('URUBUTOPAY_BASE_URL must use HTTPS');
}

async function postToGateway(path: string, body: Record<string, unknown>) {
  requireConfig();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', [gatewayAuthHeader()]: authorizationValue() };

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error'
  });
  const text = await response.text();
  let raw: any;
  try { raw = JSON.parse(text); } catch { raw = { message: text }; }

  return { httpStatus: response.status, raw };
}

export async function requestPayment(params: UrubutoPaymentParams) {
  requireConfig(true);
  const { phone, channel } = validatePaymentInput(params);
  const payload = {
    merchant_code: MERCHANT_CODE,
    service_code: SERVICE_CODE,
    payer_code: params.payerCode || params.requesttransactionid,
    payer_names: params.payerNames || 'RIQS Member',
    payer_email: params.payerEmail || process.env.URUBUTOPAY_DEFAULT_PAYER_EMAIL || 'payments@riqs.org.rw',
    amount: Number(params.amount),
    channel_name: channel,
    phone_number: phone,
    transaction_id: params.requesttransactionid,
    ...(params.redirectionUrl ? { redirection_url: params.redirectionUrl } : {})
  };

  const { httpStatus, raw } = await postToGateway('/v2/payment/initiate', payload);
  return {
    httpStatus,
    data: {
      success: httpStatus >= 200 && httpStatus < 300 && raw?.status === 200,
      responsecode: raw?.status,
      message: raw?.message || 'Payment request was sent to the customer.',
      status: raw?.data?.transaction_status || 'PENDING',
      statusdesc: paymentFailureReason(raw),
      guidance: httpStatus >= 400 || raw?.status !== 200 || paymentOutcome(raw?.data?.transaction_status) === 'failure' ? PAYMENT_RETRY_GUIDANCE : undefined,
      transaction_id: raw?.data?.external_transaction_ref_number || params.requesttransactionid,
      internal_transaction_id: raw?.data?.internal_transaction_ref_number,
      raw
    }
  };

}

export async function getTransactionStatus(params: { requesttransactionid: string; transactionid?: string }) {
  const payload = {
    merchant_code: MERCHANT_CODE,
    transaction_id: params.transactionid || params.requesttransactionid
  };
  const { httpStatus, raw } = await postToGateway('/v2/payment/transaction/status', payload);
  return {
    httpStatus,
    data: {
      success: httpStatus >= 200 && httpStatus < 300 && raw?.status === 200,
      responsecode: raw?.status,
      message: raw?.message || 'Payment status retrieved.',
      status: raw?.data?.transaction_status,
      statusdesc: paymentFailureReason(raw),
      guidance: httpStatus >= 400 || raw?.status !== 200 || paymentOutcome(raw?.data?.transaction_status) === 'failure' ? PAYMENT_RETRY_GUIDANCE : undefined,
      transaction_id: raw?.data?.transaction_id || params.requesttransactionid,
      internal_transaction_id: raw?.data?.internal_transaction_id,
      raw
    }
  };
}

export async function getBalance(walletAccountId = process.env.URUBUTOPAY_WALLET_ACCOUNT_ID) {
  const { httpStatus, raw } = await postToGateway('/v2/wallet/balance', walletAccountId ? { wallet_account_id: walletAccountId } : {});
  return {
    httpStatus,
    data: {
      success: httpStatus >= 200 && httpStatus < 300 && (raw?.status === true || raw?.status === 200),
      responsecode: raw?.code,
      message: raw?.message || 'Wallet balance retrieved.',
      balance: raw?.data?.balance,
      currency: raw?.data?.currency,
      raw
    }
  };
}

export function normalizePhoneNumber(phone: string | number) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('07')) return `250${digits.slice(1)}`;
  if (digits.startsWith('7')) return `250${digits}`;
  return digits;
}

export class PaymentInputError extends Error {
  readonly status = 400;
}

export function validatePaymentInput(params: UrubutoPaymentParams) {
  if (!['string', 'number'].includes(typeof params.amount) || !Number.isFinite(Number(params.amount)) || Number(params.amount) <= 0) {
    throw new PaymentInputError('Payment amount must be a positive number.');
  }
  if (typeof params.requesttransactionid !== 'string' || !params.requesttransactionid.trim()) {
    throw new PaymentInputError('A transaction reference is required.');
  }
  const phone = normalizePhoneNumber(params.mobilephone);
  const channel = params.channelName || (phone.startsWith('25072') || phone.startsWith('25073') ? 'AIRTEL_MONEY' : 'MOMO');
  if (!['MOMO', 'AIRTEL_MONEY', 'CARD'].includes(channel)) throw new PaymentInputError('Unsupported payment channel.');
  if (channel !== 'CARD' && !/^2507[2389]\d{7}$/.test(phone)) {
    throw new PaymentInputError('A valid Rwandan mobile money number is required.');
  }
  if (channel === 'CARD') {
    if (!/^\d{8,15}$/.test(phone)) throw new PaymentInputError('A valid phone number is required.');
    try {
      if (!['https:', 'http:'].includes(new URL(params.redirectionUrl || '').protocol)) throw new Error();
    } catch { throw new PaymentInputError('Card payments require a valid redirection URL.'); }
  }
  return { phone, channel };
}

export function timingSafeEqualText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function webhookUsername() { return process.env.URUBUTOPAY_WEBHOOK_USERNAME || ''; }
export function webhookPassword() { return process.env.URUBUTOPAY_WEBHOOK_PASSWORD || ''; }
export function webhookJwtSecret() {
  const secret = process.env.URUBUTOPAY_WEBHOOK_JWT_SECRET;
  if (!secret) throw new Error('UrubutoPay configuration is incomplete: URUBUTOPAY_WEBHOOK_JWT_SECRET');
  return secret;
}
