const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

function loadAdapter() {
  const modulePath = require.resolve('../src/services/paymentGatewayService.ts');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('payment initiation preserves the configured x-api-key header with the upg prefix', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test/';
  process.env.URUBUTOPAY_API_KEY = 'test-key';
  process.env.URUBUTOPAY_MERCHANT_CODE = 'merchant-1';
  process.env.URUBUTOPAY_SERVICE_CODE = 'service-1';

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://gateway.example.test/v2/payment/initiate');
    assert.equal(options.headers['x-api-key'], 'upg:test-key');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.merchant_code, 'merchant-1');
    assert.equal(body.service_code, 'service-1');
    return { status: 200, text: async () => JSON.stringify({ status: 200, data: {} }) };
  };

  try {
    const { requestPayment } = loadAdapter();
    const result = await requestPayment({
      amount: 5,
      mobilephone: '250788000000',
      requesttransactionid: 'test-transaction'
    });
    assert.equal(result.data.success, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy gateway URL cannot substitute for the UrubutoPay API host', async () => {
  delete process.env.URUBUTOPAY_BASE_URL;
  process.env.PAYMENT_GATEWAY_BASE_URL = 'https://legacy.example.test';
  const { requestPayment } = loadAdapter();
  await assert.rejects(
    requestPayment({ amount: 5, mobilephone: '250788000000', requesttransactionid: 'test-transaction' }),
    /URUBUTOPAY_BASE_URL/
  );
});

test('base URL cannot include the versioned API path', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test/v2';
  const { requestPayment } = loadAdapter();
  await assert.rejects(
    requestPayment({ amount: 5, mobilephone: '250788000000', requesttransactionid: 'test-transaction' }),
    /exclude \/v2/
  );
});

test('webhook signing requires a dedicated secret', () => {
  delete process.env.URUBUTOPAY_WEBHOOK_JWT_SECRET;
  const { webhookJwtSecret } = loadAdapter();
  assert.throws(webhookJwtSecret, /URUBUTOPAY_WEBHOOK_JWT_SECRET/);
});

test('the supplied initiation and lookup response fields retain their distinct references and payment states', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test';
  const reference = 'trx-01M59Y31ATECQF2SFRQ1VPWZNI';
  const internalReference = '33202610231548510816';
  const initiation = {
    status: 200,
    message: 'Thank you for initiating a new Payment.',
    data: { transaction_status: 'INITIATED', external_transaction_ref_number: reference, internal_transaction_ref_number: internalReference }
  };
  const lookup = {
    status: 200,
    message: 'Successful',
    data: { transaction_status: 'PENDING', transaction_id: reference, internal_transaction_id: internalReference }
  };
  const originalFetch = global.fetch;
  global.fetch = async url => ({ status: 200, text: async () => JSON.stringify(url.endsWith('/initiate') ? initiation : lookup) });
  try {
    const adapter = loadAdapter();
    const initial = await adapter.requestPayment({ amount: 5, mobilephone: '250795601005', requesttransactionid: reference });
    const current = await adapter.getTransactionStatus({ requesttransactionid: reference });
    assert.equal(initial.data.status, 'INITIATED');
    assert.equal(current.data.status, 'PENDING');
    for (const result of [initial, current]) {
      assert.equal(result.data.success, true);
      assert.equal(result.data.transaction_id, reference);
      assert.equal(result.data.internal_transaction_id, internalReference);
      assert.equal(result.data.statusdesc, undefined);
    }
    assert.deepEqual(initial.data.raw, initiation);
    assert.deepEqual(current.data.raw, lookup);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a successful status lookup never supplies its API message as a payment rejection reason', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test';
  const raw = { status: 200, message: 'Successful', data: { transaction_status: 'FAILED' } };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, text: async () => JSON.stringify(raw) });
  try {
    const adapter = loadAdapter();
    for (const request of [
      () => adapter.requestPayment({ amount: 5, mobilephone: '250795601005', requesttransactionid: 'ref-1' }),
      () => adapter.getTransactionStatus({ requesttransactionid: 'ref-1' })
    ]) {
      const result = await request();
      assert.equal(result.data.success, true);
      assert.equal(result.data.status, 'FAILED');
      assert.equal(result.data.statusdesc, 'Payment was not completed.');
    }
    raw.data.reason = 'Insufficient funds';
    const result = await adapter.getTransactionStatus({ requesttransactionid: 'ref-1' });
    assert.equal(result.data.statusdesc, 'Insufficient funds');
  } finally {
    global.fetch = originalFetch;
  }
});
