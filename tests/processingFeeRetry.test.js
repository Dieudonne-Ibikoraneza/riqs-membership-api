const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

const { processingFeeRequiresFailedRetry } = require('../src/services/processingFeeEligibility.ts');

test('only unfinished applications are eligible for a processing fee payment or failed-fee retry', () => {
  for (const status of ['Draft', 'Correction_Required']) {
    assert.equal(processingFeeRequiresFailedRetry(status), false);
  }
  for (const status of ['Pending', 'Under_Review', 'Pending_Approval']) {
    assert.equal(processingFeeRequiresFailedRetry(status), true);
  }
  for (const status of ['Approved', 'Rejected', null]) {
    assert.equal(processingFeeRequiresFailedRetry(status), null);
  }
});

const dbPath = require.resolve('../src/config/db.ts');
const gatewayPath = require.resolve('../src/services/paymentGatewayService.ts');
let applicationStatus = 'Pending_Approval';
let transactions = [];
let gatewayCalls = 0;
let updatedId = null;
let created = false;
const prisma = {
  application: {
    findFirst: async () => ({
      id: 'app-1', memberId: 'member-1', status: applicationStatus,
      category: { processingFee: 10000, currency: 'RWF' },
      member: { id: 'member-1', membershipId: 'RIQS-1', fullName: 'Test Member', email: 'test@example.com' }
    })
  },
  financialTransaction: {
    findFirst: async ({ where }) => transactions.find(tx =>
      tx.applicationId === where.applicationId && tx.txType === where.txType &&
      tx.status === where.status && (where.amount === undefined || tx.amount === where.amount)
    ) || null,
    update: async ({ where, data }) => { updatedId = where.id; return { id: where.id, ...data }; },
    create: async ({ data }) => { created = true; return { id: 'new-transaction', ...data }; }
  }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } };
require.cache[gatewayPath] = {
  id: gatewayPath, filename: gatewayPath, loaded: true,
  exports: {
    normalizePhoneNumber: phone => phone,
    requestPayment: async () => { gatewayCalls++; return { data: { success: true, message: 'Accepted' } }; }
  }
};
const { initiateProcessingFeePayment } = require('../src/controllers/paymentController.ts');

async function initiate(status, rows) {
  applicationStatus = status;
  transactions = rows;
  gatewayCalls = 0;
  updatedId = null;
  created = false;
  const req = { user: { id: 'member-1' }, body: { applicationId: 'app-1', mobilephone: '250788000000' } };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await initiateProcessingFeePayment(req, res);
  return res;
}

const row = (status, id = 'fee-1', extra = {}) => ({
  id, applicationId: 'app-1', txType: 'Processing_Fee', status, amount: 10000, ...extra
});

test('a Pending_Approval application retries its failed fee in the same transaction row', async () => {
  const res = await initiate('Pending_Approval', [row('Failed')]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'Pending');
  assert.equal(res.body.transactionId, 'fee-1');
  assert.equal(gatewayCalls, 1);
  assert.equal(updatedId, 'fee-1');
  assert.equal(created, false);
});

test('a submitted application cannot start a new fee without a failed payment', async () => {
  const res = await initiate('Pending_Approval', []);
  assert.equal(res.statusCode, 409);
  assert.equal(gatewayCalls, 0);
});

test('a pending manual proof blocks a duplicate gateway charge', async () => {
  const res = await initiate('Pending_Approval', [row('Failed'), row('Pending_Verification', 'manual-1')]);
  assert.equal(res.statusCode, 409);
  assert.equal(gatewayCalls, 0);
});

test('an already paid fee does not trigger another charge', async () => {
  const res = await initiate('Pending_Approval', [row('Failed'), row('Paid', 'paid-1')]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'Paid');
  assert.equal(gatewayCalls, 0);
});

test('an approved application remains ineligible even with a failed fee', async () => {
  const res = await initiate('Approved', [row('Failed')]);
  assert.equal(res.statusCode, 404);
  assert.equal(gatewayCalls, 0);
});
