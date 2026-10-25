const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

let created = [];
let mails = [];
let failAudit = false;
const tx = {
  member: { create: async ({ data }) => { created.push(data); return { id: 'member-1', ...data }; } },
  application: { create: async () => ({ id: 'app-1' }) },
  financialTransaction: { create: async () => ({}) },
  auditLog: { create: async () => { if (failAudit) throw new Error('Audit unavailable'); } },
};
const prisma = {
  membershipCategory: { findFirst: async () => ({ id: 'cat-1', location: 'Rwandan', processingFee: 10000, currency: 'RWF' }) },
  member: { findFirst: async ({ where }) => created.find(m => m.email === where.email.equals), findUnique: async () => null },
  $transaction: async callback => {
    const before = created.length;
    try { return await callback(tx); } catch (err) { created.length = before; throw err; }
  },
};
for (const [path, exports] of [
  ['../src/config/db.ts', { prisma }],
  ['../src/config/mailer.ts', { sendRawMail: async mail => { mails.push(mail); } }],
  ['../src/controllers/progressionController.ts', { nextMembershipId: async prefix => `${prefix}0001` }],
]) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { bulkImportMembers } = require('../src/controllers/memberImportController.ts');
const row = (extra = {}) => ({ sourceSheet: 'GRADUATE', rawSourceRow: 73, fullName: 'Test Graduate', email: 'test@example.com', categoryCode: 'GrQS', registrationYear: 2024, membershipExpiresAt: '2026-12-31', ...extra });
async function submit(body) {
  created = []; mails = [];
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await bulkImportMembers({ user: { email: 'admin@example.com' }, body }, res);
  return res;
}

test('invalid email fails only its row, preserving the Excel row number', async () => {
  const res = await submit({ rows: [row({ email: 'bad|@gmail.com' }), row({ rawSourceRow: 74 })] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.summary, { total: 2, created: 1, skipped: 0, failed: 1 });
  assert.equal(res.body.results[0].rawSourceRow, 73);
  assert.match(res.body.results[0].reason, /email/);
  assert.equal(created.length, 1);
  assert.equal(mails.length, 1);
});

test('normalizes email before validation and skips duplicate accounts', async () => {
  const res = await submit({ rows: [row({ email: ' TEST@EXAMPLE.COM ' }), row()] });
  assert.deepEqual(res.body.summary, { total: 2, created: 1, skipped: 1, failed: 0 });
  assert.equal(created[0].email, 'test@example.com');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'test@example.com');
});

test('successful graduate and professional imports each send a welcome email', async () => {
  const res = await submit({ rows: [row(), row({ sourceSheet: 'PROF_TECH', categoryCode: 'PrQS', email: 'professional@example.com' })] });
  assert.equal(res.body.summary.created, 2);
  assert.equal(created.length, 2);
  assert.ok(created.every(member => member.passwordHash && member.resetPasswordOtp === 'CHANGE'));
  assert.equal(mails.length, 2);
  assert.deepEqual(mails.map(mail => mail.to), ['test@example.com', 'professional@example.com']);
  assert.ok(mails.every(mail => mail.html.includes('Temporary Password:')));
});

test('invalid dates, years and malformed rows do not reach persistence', async () => {
  const res = await submit({ rows: [row({ membershipExpiresAt: '2026-02-30' }), row({ registrationYear: 1 }), null, row({ fullName: ' ' })] });
  assert.equal(res.body.summary.failed, 4);
  assert.equal(created.length, 0);
  assert.equal(mails.length, 0);
});

test('malformed and oversized envelopes are rejected', async () => {
  for (const body of [{}, { rows: [] }, { rows: Array(501).fill(row()) }]) {
    assert.equal((await submit(body)).statusCode, 400);
    assert.equal(created.length, 0);
  }
});

test('audit failure rolls back account creation before any welcome email', async () => {
  failAudit = true;
  try {
    const res = await submit({ rows: [row()] });
    assert.equal(res.body.summary.failed, 1);
    assert.equal(created.length, 0);
    assert.equal(mails.length, 0);
  } finally { failAudit = false; }
});
