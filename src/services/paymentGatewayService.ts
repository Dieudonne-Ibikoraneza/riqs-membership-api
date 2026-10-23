/** UrubutoPay adapter kept behind the application's provider-neutral gateway surface. */
import crypto from 'crypto';
import { paymentFailureReason } from './paymentGatewayResult';

const BASE_URL = (process.env.URUBUTOPAY_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.URUBUTOPAY_API_KEY || '';
const MERCHANT_CODE = process.env.URUBUTOPAY_MERCHANT_CODE || '';
const SERVICE_CODE = process.env.URUBUTOPAY_SERVICE_CODE || '';

function authorizationValue() {
  return API_KEY.startsWith('upg:') ? API_KEY : `upg:${API_KEY}`;
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

function requireConfig() {
  const missing = [
    !BASE_URL && 'URUBUTOPAY_BASE_URL',
    !API_KEY && 'URUBUTOPAY_API_KEY',
    !MERCHANT_CODE && 'URUBUTOPAY_MERCHANT_CODE',
    !SERVICE_CODE && 'URUBUTOPAY_SERVICE_CODE'
  ].filter(Boolean);
  if (missing.length) throw new Error(`UrubutoPay configuration is incomplete: ${missing.join(', ')}`);
  if (/\/(?:v2|reference)$/i.test(BASE_URL)) {
    throw new Error('URUBUTOPAY_BASE_URL must exclude /v2 and /reference');
  }
}

async function postToGateway(path: string, body: Record<string, unknown>) {
  requireConfig();
  const headers = { 'Content-Type': 'application/json', 'x-api-key': authorizationValue() };
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let raw: any;
  try { raw = JSON.parse(text); } catch { raw = { message: text }; }
  return { httpStatus: response.status, raw };
}

export async function requestPayment(params: UrubutoPaymentParams) {
  const payload = {
    merchant_code: MERCHANT_CODE,
    service_code: SERVICE_CODE,
    payer_code: params.payerCode || params.requesttransactionid,
    payer_names: params.payerNames || 'RIQS Member',
    payer_email: params.payerEmail || process.env.URUBUTOPAY_DEFAULT_PAYER_EMAIL || 'payments@riqs.org.rw',
    amount: Number(params.amount),
    channel_name: params.channelName || 'MOMO',
    phone_number: String(params.mobilephone),
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
      transaction_id: raw?.data?.external_transaction_ref_number || params.requesttransactionid,
      internal_transaction_id: raw?.data?.internal_transaction_ref_number,
      raw
    }
  };
}

export async function getTransactionStatus(params: { requesttransactionid: string; transactionid?: string }) {
  const { httpStatus, raw } = await postToGateway('/v2/payment/transaction/status', {
    merchant_code: MERCHANT_CODE,
    transaction_id: params.transactionid || params.requesttransactionid
  });
  return {
    httpStatus,
    data: {
      success: httpStatus >= 200 && httpStatus < 300 && raw?.status === 200,
      responsecode: raw?.status,
      message: raw?.message || 'Payment status retrieved.',
      status: raw?.data?.transaction_status,
      statusdesc: paymentFailureReason(raw),
      transaction_id: raw?.data?.transaction_id || params.requesttransactionid,
      internal_transaction_id: raw?.data?.internal_transaction_id,
      raw
    }
  };
}

export async function getBalance() {
  const { httpStatus, raw } = await postToGateway('/v2/wallet/balance', {});
  return {
    httpStatus,
    data: {
      success: httpStatus >= 200 && httpStatus < 300 && raw?.status === true,
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
