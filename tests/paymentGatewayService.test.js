const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

function loadAdapter() {
  const modulePath = require.resolve('../src/services/paymentGatewayService.ts');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('payment initiation uses the documented Authorization header with the upg prefix', async () => {
  process.env.URUBUTOPAY_BASE_URL = 'https://gateway.example.test/';
  process.env.URUBUTOPAY_API_KEY = 'test-key';
  process.env.URUBUTOPAY_MERCHANT_CODE = 'merchant-1';
  process.env.URUBUTOPAY_SERVICE_CODE = 'service-1';

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://gateway.example.test/v2/payment/initiate');
    assert.equal(options.headers.Authorization, 'upg:test-key');
    assert.equal(options.headers['x-api-key'], undefined);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
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

test('wallet balance accepts the live staging envelope and the documented envelope', async () => {
  const originalFetch = global.fetch;
  const adapter = loadAdapter();
  try {
    for (const status of [200, true]) {
      global.fetch = async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { wallet_account_id: 'wallet-1' });
        return { status: 200, text: async () => JSON.stringify({ status, data: { balance: 0, currency: 'RWF' } }) };
      };
      const result = await adapter.getBalance('wallet-1');
      assert.equal(result.data.success, true);
      assert.equal(result.data.balance, 0);
      assert.equal(result.data.currency, 'RWF');
    }
    global.fetch = async () => ({ status: 401, text: async () => '{"status":200}' });
    assert.equal((await adapter.getBalance()).data.success, false);
  } finally { global.fetch = originalFetch; }
});

test('normalizes local wallet numbers and selects the Airtel channel', async () => {
  const originalFetch = global.fetch;
  const adapter = loadAdapter();
  try {
    for (const [phone, normalized, channel] of [
      ['0788000000', '250788000000', 'MOMO'],
      ['+250 790 000 000', '250790000000', 'MOMO'],
      ['0722000000', '250722000000', 'AIRTEL_MONEY'],
      ['0733000000', '250733000000', 'AIRTEL_MONEY']
    ]) {
      global.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.phone_number, normalized);
        assert.equal(body.channel_name, channel);
        return { status: 200, text: async () => '{"status":200}' };
      };
      await adapter.requestPayment({ amount: 5, mobilephone: phone, requesttransactionid: 'ref' });
    }
  } finally { global.fetch = originalFetch; }
});

test('invalid payment data never reaches the gateway', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { assert.fail('invalid input must not cause a collection'); };
  const adapter = loadAdapter();
  const valid = { amount: 5, mobilephone: '250788000000', requesttransactionid: 'ref' };
  try {
    for (const invalid of [
      { amount: -1 }, { amount: 0 }, { amount: 'NaN' }, { amount: Infinity }, { amount: true },
      { mobilephone: '123' }, { requesttransactionid: ' ' }, { channelName: 'OTHER' },
      { channelName: 'CARD' }, { channelName: 'CARD', redirectionUrl: 'javascript:alert(1)' }
    ]) {
      await assert.rejects(adapter.requestPayment({ ...valid, ...invalid }), error => error.status === 400);
    }
  } finally { global.fetch = originalFetch; }
});

test('gateway errors and non-JSON responses cannot be mistaken for successful payments', async () => {
  const originalFetch = global.fetch;
  const adapter = loadAdapter();
  try {
    global.fetch = async () => ({ status: 502, text: async () => 'Bad gateway' });
    const result = await adapter.getTransactionStatus({ requesttransactionid: 'ref' });
    assert.equal(result.data.success, false);
    assert.equal(result.data.message, 'Bad gateway');
    global.fetch = async () => { throw new DOMException('Request timed out', 'TimeoutError'); };
    await assert.rejects(adapter.getTransactionStatus({ requesttransactionid: 'ref' }), /timed out/);
  } finally { global.fetch = originalFetch; }
});

test('payment initiation and status do not log request or response details', async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const logs = [];
  const key = process.env.URUBUTOPAY_API_KEY;
  const raw = { status: 200, data: { transaction_status: 'PENDING' }, message: `Echo upg:${key}`, api_key: key };
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, `upg:${key}`);
    return { status: 200, headers: new Headers({ 'content-type': 'application/json', 'x-api-key': key }), text: async () => JSON.stringify(raw) };
  };
  console.log = (...args) => logs.push(args);
  try {
    const adapter = loadAdapter();
    const result = await adapter.requestPayment({ amount: 5, mobilephone: '250788000000', requesttransactionid: 'logging-ref' });
    await adapter.getTransactionStatus({ requesttransactionid: 'logging-ref' });
    assert.equal(logs.length, 0);
    assert.deepEqual(result.data.raw, raw, 'removing logs must not alter the gateway response');
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('payment initiation and status select their authentication header from the payment environment', async () => {
  const originalFetch = global.fetch;
  const saved = Object.fromEntries(['URUBUTOPAY_BASE_URL', 'URUBUTOPAY_ENVIRONMENT', 'URUBUTOPAY_API_KEY', 'NODE_ENV'].map(key => [key, process.env[key]]));
  try {
    for (const [base, environment, nodeEnvironment, expected] of [
      ['https://staging.urubutopay.rw/api', undefined, 'production', 'x-api-key'],
      ['https://urubutopay.rw/api', undefined, 'development', 'Authorization'],
      ['https://staging.urubutopay.rw/api', 'testing', 'development', 'x-api-key'],
      ['https://urubutopay.rw/api', 'live', 'production', 'Authorization']
    ]) {
      process.env.URUBUTOPAY_BASE_URL = base;
      if (environment === undefined) delete process.env.URUBUTOPAY_ENVIRONMENT;
      else process.env.URUBUTOPAY_ENVIRONMENT = environment;
      process.env.NODE_ENV = nodeEnvironment;
      process.env.URUBUTOPAY_API_KEY = 'upg:environment-test-key';
      let calls = 0;
      global.fetch = async (_url, options) => {
        calls++;
        assert.equal(options.headers[expected], 'upg:environment-test-key');
        assert.equal(options.headers[expected === 'x-api-key' ? 'Authorization' : 'x-api-key'], undefined);
        return { status: 200, text: async () => '{"status":200,"data":{"transaction_status":"PENDING"}}' };
      };
      const adapter = loadAdapter();
      await adapter.requestPayment({ amount: 5, mobilephone: '250788000000', requesttransactionid: 'environment-ref' });
      await adapter.getTransactionStatus({ requesttransactionid: 'environment-ref' });
      assert.equal(calls, 2);
    }
    global.fetch = async () => { assert.fail('invalid environment must not send a request'); };
    for (const [base, environment, error] of [
      ['https://urubutopay.rw/api', 'testing', /does not match/],
      ['https://staging.urubutopay.rw/api', 'live', /does not match/],
      ['https://staging.urubutopay.rw/api', 'invalid', /must be testing or live/]
    ]) {
      process.env.URUBUTOPAY_BASE_URL = base;
      process.env.URUBUTOPAY_ENVIRONMENT = environment;
      await assert.rejects(loadAdapter().getTransactionStatus({ requesttransactionid: 'environment-ref' }), error);
    }
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
