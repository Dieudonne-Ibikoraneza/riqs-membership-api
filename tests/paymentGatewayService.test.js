const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

function loadAdapter() {
  const modulePath = require.resolve('../src/services/paymentGatewayService.ts');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('payment initiation sends the BK API key in Authorization with the upg prefix', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test/';
  process.env.URUBUTOPAY_API_KEY = 'test-key';
  process.env.URUBUTOPAY_MERCHANT_CODE = 'merchant-1';
  process.env.URUBUTOPAY_SERVICE_CODE = 'service-1';

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://gateway.example.test/v2/payment/initiate');
    assert.equal(options.headers.Authorization, 'upg:test-key');
    assert.equal(options.headers['x-api-key'], undefined);
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
