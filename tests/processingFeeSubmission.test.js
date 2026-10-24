const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

let rows = [];
let teacherFlow = false;
let reads = 0;
let feeQuery;
const app = { id: 'app-1', memberId: 'member-1', status: 'Draft', category: { categoryName: 'Graduate', categoryCode: 'GRAD', processingFee: 10000 }, member: { id: 'member-1', email: 'member@example.com' } };
function matches(row, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some(branch => matches(row, branch));
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return condition.in.includes(row[key]);
      if ('not' in condition) return (row[key] ?? null) !== condition.not;
    }
    return (row[key] ?? null) === condition;
  });
}
const prisma = {
  application: {
    findFirst: async () => app,
    // Stop at the finalizer boundary: these tests verify submission eligibility,
    // without running mentorship, document checks, email, or review side effects.
    findUnique: async () => { reads++; return teacherFlow && reads === 1 ? app : null; }
  },
  financialTransaction: { findFirst: async ({ where }) => { feeQuery = where; return rows.find(row => matches(row, where)) || null; } }
};
const dbPath = require.resolve('../src/config/db.ts');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } };
const { submitApplication } = require('../src/controllers/applicantController.ts');
const { submitStudentApplication } = require('../src/controllers/teacherController.ts');
const fee = extra => ({ applicationId: 'app-1', txType: 'Processing_Fee', amount: 10000, ...extra });

for (const [name, handler, teacher] of [['applicant', submitApplication, false], ['teacher', submitStudentApplication, true]]) {
  test(`${name}: an unapproved gateway fee cannot submit, even after waiting five minutes`, async () => {
    for (const row of [
      null,
      fee({ status: 'Pending_Verification', paymentMethod: 'Mobile_Money', providerTransactionId: 'provider-ref', createdAt: new Date(Date.now() - 6 * 60 * 1000) }),
      fee({ status: 'Pending_Verification', paymentMethod: 'Mobile_Money', providerTransactionId: null }),
      fee({ status: 'Pending_Verification', paymentMethod: 'Manual_Payment', providerTransactionId: 'unpaid-ref', receiptUrl: 'receipt' }),
      fee({ status: 'Failed' }), fee({ status: 'Unpaid' }),
      fee({ status: 'Paid', amount: 5000 }),
      fee({ status: 'Pending_Verification', paymentMethod: 'Manual_Payment', receiptUrl: null })
    ]) {
      rows = row ? [row] : []; teacherFlow = teacher; reads = 0;
      const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ user: { id: 'member-1', role: 'Admin' }, body: { applicationId: 'app-1' } }, res);
      assert.equal(res.statusCode, 402, JSON.stringify(row));
      assert.equal(res.body.code, 'PAYMENT_REQUIRED');
      assert.equal(reads, teacher ? 1 : 0, 'blocked submissions must not enter the finalizer');
      assert.equal(feeQuery.amount, 10000);
    }
  });
  test(`${name}: confirmed fees and uploaded manual proofs retain their supported submission paths`, async () => {
    for (const extra of [
      { status: 'Paid', paymentMethod: 'Mobile_Money', providerTransactionId: 'confirmed-ref' },
      { status: 'Pending_Verification', paymentMethod: 'Manual_Payment', receiptUrl: 'uploaded-receipt' }
    ]) {
      rows = [fee(extra)]; teacherFlow = teacher; reads = 0;
      const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ user: { id: 'member-1', role: 'Admin' }, body: { applicationId: 'app-1' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(reads, teacher ? 2 : 1);
    }
  });
}
