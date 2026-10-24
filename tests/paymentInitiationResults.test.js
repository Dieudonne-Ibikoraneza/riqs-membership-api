const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

const { paymentOutcome } = require('../src/services/paymentGatewayResult.ts');
const dbPath = require.resolve('../src/config/db.ts');
const gatewayPath = require.resolve('../src/services/paymentGatewayService.ts');
const receiptPath = require.resolve('../src/services/receiptService.ts');
const applicantPath = require.resolve('../src/controllers/applicantController.ts');
let tx;
let gatewayResult;
let finalized;
let receipts;
const member = { id: 'member-1', membershipId: 'RIQS-1', fullName: 'Test Member', email: 'test@example.com' };
const application = { id: 'app-1', memberId: member.id, status: 'Draft', member, category: { processingFee: 10000, categoryName: 'Professional', currency: 'RWF' } };
const prisma = {
  member: { findUnique: async () => member },
  application: { findFirst: async () => application, findUnique: async () => application },
  financialTransaction: {
    findFirst: async ({ where }) => {
      const states = where.status?.in || [where.status];
      return tx && where.txType === tx.txType && (where.status === undefined || states.includes(tx.status)) ? tx : null;
    },
    findUnique: async () => ({ ...tx, application, member }),
    findUniqueOrThrow: async () => tx,
    update: async ({ data }) => { tx = { ...tx, ...data }; return tx; },
    create: async ({ data }) => { tx = { id: 'fee-1', clearedAt: null, ...data }; return tx; }
  }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } };
require.cache[gatewayPath] = {
  id: gatewayPath, filename: gatewayPath, loaded: true,
  exports: {
    normalizePhoneNumber: value => value,
    requestPayment: async () => ({ data: gatewayResult }),
    getTransactionStatus: async () => ({ data: gatewayResult }),
    webhookJwtSecret: () => 'webhook-test-secret'
  }
};
require.cache[receiptPath] = { id: receiptPath, filename: receiptPath, loaded: true, exports: { issuePaymentReceipt: async () => { receipts++; } } };
require.cache[applicantPath] = { id: applicantPath, filename: applicantPath, loaded: true, exports: { finalizeApplicationSubmission: async () => { finalized++; } } };
const controller = require('../src/controllers/paymentController.ts');
const flows = [
  ['Processing_Fee', controller.initiateProcessingFeePayment],
  ['First_Year_Fee', controller.initiateFirstYearFeePayment],
  ['Annual_Renewal', controller.initiateAnnualRenewalPayment]
];

async function initiate(type, handler, status) {
  tx = { id: 'fee-1', memberId: member.id, applicationId: application.id, txType: type, amount: 10000, currency: 'RWF', status: 'Unpaid', clearedAt: null };
  gatewayResult = { success: true, status, message: 'Thank you for initiating a new Payment.', ...(paymentOutcome(status) === 'failure' ? { statusdesc: 'Payment was not completed.' } : {}) };
  finalized = receipts = 0;
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ user: { id: member.id }, body: { applicationId: application.id, mobilephone: '250795601005', cpdDocumentUrl: 'cpd-document' } }, res);
  return res;
}

test('an accepted initiation with FAILED is persisted as failed and can be retried in every fee flow', async () => {
  for (const [type, handler] of flows) {
    const res = await initiate(type, handler, 'FAILED');
    assert.equal(res.statusCode, 422, type);
    assert.equal(res.body.status, 'Failed', type);
    assert.equal(res.body.transactionId, 'fee-1');
    assert.equal(res.body.error, 'Payment was not completed.');
    assert.match(res.body.guidance, /enough funds/);
    assert.match(res.body.guidance, /correct MTN Mobile Money or Airtel Money number/);
    assert.equal(tx.status, 'Failed');
    assert.equal(tx.rejectionReason, 'Payment was not completed.');
    assert.equal(finalized, 0);
    assert.equal(receipts, 0);
  }
});

test('INITIATED and PENDING remain unresolved rather than marking a payment paid or failed', async () => {
  for (const status of ['INITIATED', 'PENDING']) {
    for (const [type, handler] of flows) {
      const res = await initiate(type, handler, status);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'Pending');
      assert.equal(tx.status, 'Pending_Verification');
      assert.equal(tx.rejectionReason, null);
      assert.equal(receipts, 0);
    }
  }
});

test('completed initiation applies payment side effects while annual renewal still requires CPD review', async () => {
  for (const [type, handler] of flows) {
    const res = await initiate(type, handler, 'VALID');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, type === 'Annual_Renewal' ? 'Pending' : 'Paid');
    assert.equal(tx.status, type === 'Annual_Renewal' ? 'Pending_Verification' : 'Paid');
    assert.ok(tx.clearedAt instanceof Date);
    assert.equal(finalized, type === 'Processing_Fee' ? 1 : 0);
    assert.equal(receipts, 1);
  }
});

test('UNSUCCESSFUL is a failure rather than a substring match for success', async () => {
  assert.equal(paymentOutcome('UNSUCCESSFUL'), 'failure');
  const res = await initiate('First_Year_Fee', controller.initiateFirstYearFeePayment, 'UNSUCCESSFUL');
  assert.equal(res.statusCode, 422);
  assert.equal(tx.status, 'Failed');
});

test('polling follows the transaction state and does not interpret a Successful API message as payment success', async () => {
  for (const [type, initiateHandler, pollHandler] of [
    ['Processing_Fee', controller.initiateProcessingFeePayment, controller.getProcessingFeePaymentStatus],
    ['First_Year_Fee', controller.initiateFirstYearFeePayment, controller.getFirstYearFeePaymentStatus],
    ['Annual_Renewal', controller.initiateAnnualRenewalPayment, controller.getAnnualRenewalPaymentStatus]
  ]) {
    await initiate(type, initiateHandler, 'INITIATED');
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const req = { user: { id: member.id }, params: { transactionId: tx.id } };
    gatewayResult = { success: true, status: 'PENDING', message: 'Successful' };
    await pollHandler(req, res);
    assert.equal(res.body.status, 'Pending_Verification');
    assert.equal(res.body.rejectionReason, null);
    gatewayResult = { success: true, status: 'FAILED', message: 'Successful', statusdesc: 'Payment was not completed.' };
    await pollHandler(req, res);
    assert.equal(res.body.status, 'Failed');
    assert.equal(res.body.rejectionReason, 'Payment was not completed.');
    assert.match(res.body.guidance, /enough funds/);
    assert.equal(receipts, 0);
  }
});

test('a failure callback uses the explicit reason rather than the generic payment observation', async () => {
  await initiate('First_Year_Fee', controller.initiateFirstYearFeePayment, 'INITIATED');
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({}, 'webhook-test-secret', { audience: 'urubutopay' });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.receivePaymentCallback({
    headers: { authorization: `Bearer ${token}` },
    body: { callback_type: 'PAYMENT', transaction_id: tx.providerTransactionId, transaction_status: 'FAILED', reason: 'Insufficient funds', observation: 'payment' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(tx.status, 'Failed');
  assert.equal(tx.rejectionReason, 'Insufficient funds');
});

test('duplicate renewal callbacks preserve the original clearance and issue one receipt', async () => {
  await initiate('Annual_Renewal', controller.initiateAnnualRenewalPayment, 'INITIATED');
  await controller.resolveProcessingFeePaymentByProviderId(tx.providerTransactionId, 'VALID');
  const clearedAt = tx.clearedAt;
  await controller.resolveProcessingFeePaymentByProviderId(tx.providerTransactionId, 'VALID');
  await controller.resolveProcessingFeePaymentByProviderId(tx.providerTransactionId, 'FAILED');
  assert.equal(tx.status, 'Pending_Verification');
  assert.equal(tx.clearedAt, clearedAt);
  assert.equal(receipts, 1);
});

test('callbacks reject missing, expired, or wrong-audience tokens and malformed payment events', async () => {
  const jwt = require('jsonwebtoken');
  const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  for (const authorization of [undefined, 'Bearer invalid',
    `Bearer ${jwt.sign({}, 'webhook-test-secret', { audience: 'other' })}`,
    `Bearer ${jwt.sign({}, 'webhook-test-secret', { audience: 'urubutopay', expiresIn: -1 })}`
  ]) {
    const res = response();
    await controller.receivePaymentCallback({ headers: { authorization }, body: {} }, res);
    assert.equal(res.statusCode, 401);
  }
  const authorization = `Bearer ${jwt.sign({}, 'webhook-test-secret', { audience: 'urubutopay' })}`;
  for (const body of [{}, { callback_type: 'PAYMENT' }, { callback_type: 'PAYMENT', transaction_id: 'ref' },
    { callback_type: 'PAYMENT', transaction_id: {}, transaction_status: 'VALID' }]) {
    const res = response();
    await controller.receivePaymentCallback({ headers: { authorization }, body }, res);
    assert.equal(res.statusCode, 400);
  }
});
