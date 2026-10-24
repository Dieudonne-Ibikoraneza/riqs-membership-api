#!/usr/bin/env node
// Read-only by default. Keys go to curl through stdin, never its process arguments.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const args = process.argv.slice(2);
const transactionIndex = args.indexOf('--transaction');
if (args.length !== 0 && !(args.length === 2 && transactionIndex === 0 && args[1].trim() && !args[1].startsWith('--'))) {
  throw new Error('Usage: npm run payments:check -- [--transaction <existing-reference>]');
}
const base = (process.env.URUBUTOPAY_BASE_URL || '').replace(/\/+$/, '');
const key = process.env.URUBUTOPAY_API_KEY;
const merchant = process.env.URUBUTOPAY_MERCHANT_CODE;
if (!key || !merchant || !base) throw new Error('Missing UrubutoPay environment configuration.');
if (!['https://staging.urubutopay.rw/api', 'https://urubutopay.rw/api'].includes(base)) throw new Error('Expected an official UrubutoPay API base URL.');
const authorization = key.startsWith('upg:') ? key : `upg:${key}`;
// Use the same environment/header selection as the backend adapter.
require('ts-node/register');
const { gatewayAuthHeader } = require('../src/services/paymentGatewayService');
const authHeader = gatewayAuthHeader();
function request(endpoint, body) {
  // JSON string syntax also quotes the values safely for curl's config format.
  const config = [
    `url = ${JSON.stringify(base + endpoint)}`,
    'request = "POST"',
    `header = ${JSON.stringify(authHeader + ': ' + authorization)}`,
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    `data = ${JSON.stringify(JSON.stringify(body))}`
  ].join('\n');
  const result = spawnSync('curl', ['--config', '-', '--silent', '--show-error', '--max-time', '30', '--write-out', '\n%{http_code}'], { input: config, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('curl failed; check DNS and network connectivity.');
  const separator = result.stdout.lastIndexOf('\n');
  const httpStatus = Number(result.stdout.slice(separator + 1));
  let raw;
  try { raw = JSON.parse(result.stdout.slice(0, separator)); } catch { throw new Error(`Gateway returned non-JSON (HTTP ${httpStatus}).`); }
  return { httpStatus, raw };
}
const wallet = request('/v2/wallet/balance', process.env.URUBUTOPAY_WALLET_ACCOUNT_ID ? { wallet_account_id: process.env.URUBUTOPAY_WALLET_ACCOUNT_ID } : {});
if (wallet.httpStatus !== 200 || ![true, 200].includes(wallet.raw.status)) throw new Error(`Wallet check failed (HTTP ${wallet.httpStatus}).`);
console.log(`Wallet: PASS (HTTP 200, ${wallet.raw.data?.currency})`);
const reference = transactionIndex >= 0 ? args[transactionIndex + 1] : `RIQS-CHECK-MISSING-${Date.now()}`;
const status = request('/v2/payment/transaction/status', { merchant_code: merchant, transaction_id: reference });
if (transactionIndex < 0) {
  if (status.httpStatus !== 404) throw new Error(`Expected unknown transaction to return 404; got ${status.httpStatus}.`);
  console.log('Unknown transaction: PASS (HTTP 404)');
} else {
  if (status.httpStatus !== 200 || status.raw.status !== 200 || typeof status.raw.data?.transaction_status !== 'string') throw new Error(`Status lookup failed (HTTP ${status.httpStatus}).`);
  console.log(`Transaction: ${reference}; status: ${status.raw.data.transaction_status} (HTTP 200)`);
}
