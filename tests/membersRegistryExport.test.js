const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

let registryQuery;
const member = {
  id: 'graduate-1', fullName: 'Test Graduate', email: 'graduate@example.com',
  membershipId: 'RIQS-2026-GrQS-0001', membershipClass: 'Graduate',
  phoneNumber: '+250788123456', countryOfOrigin: null,
  membershipExpiresAt: new Date('2099-12-31T00:00:00Z'),
  applications: [{ category: { id: 'cat-1', categoryName: 'Graduate Quantity Surveyor' }, practiceLocation: 'Rwandan' }],
  financialTransactions: [{ status: 'Paid' }],
};
const prisma = {
  member: { findMany: async args => { registryQuery = args; return [member]; }, count: async () => 1 },
  application: { count: async () => 1 },
};
for (const [path, exports] of [
  ['../src/config/db.ts', { prisma }],
  ['../src/config/mailer.ts', {}],
  ['uuid', { v4: () => 'test-uuid' }],
]) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { getMembersRegistry } = require('../src/controllers/adminController.ts');

test('registry returns stored phone numbers and machine-readable expiry without inventing country', async () => {
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await getMembersRegistry({ query: { status: 'In Mentorship', page: '1', limit: '500' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.members[0].phoneNumber, member.phoneNumber);
  assert.equal(res.body.members[0].country, null);
  assert.equal(res.body.members[0].expiresAtIso, '2099-12-31T00:00:00.000Z');
  assert.equal(res.body.members[0].status, 'In Mentorship');
  assert.equal(registryQuery.take, 500);
  assert.ok(registryQuery.where.AND.some(c => c.membershipClass === 'Graduate'));
  assert.ok(registryQuery.where.AND.some(c => c.financialTransactions?.some?.status === 'Paid'));
});
