const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

let query;
const prisma = {
  member: {
    findMany: async args => { query = args; return []; },
    count: async () => 32,
  },
};
for (const [path, exports] of [
  ['../src/config/db.ts', { prisma }],
  ['../src/config/storage.ts', {}],
]) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { getPublicMembersDirectory } = require('../src/controllers/memberController.ts');

async function directory(params = {}) {
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await getPublicMembersDirectory({ query: params }, res);
  assert.equal(res.statusCode, 200);
  return res.body;
}

test('All Members includes every membership class while retaining public-directory restrictions', async () => {
  const result = await directory({ category: 'all' });
  assert.equal(query.where.membershipClass, undefined);
  assert.deepEqual(query.where.membershipId, { not: null });
  assert.ok(query.where.systemRole.notIn.includes('Admin'));
  assert.deepEqual(query.orderBy, [{ fullName: 'asc' }, { id: 'asc' }]);
  assert.equal(result.pagination.totalCount, 32);
  assert.equal(result.pagination.totalPages, 4);
});

test('search, sorting and pagination apply to All Members on the server', async () => {
  await directory({ category: 'all', search: 'Test Member', sortKey: 'id', sortDir: 'desc', page: '2', limit: '10' });
  assert.equal(query.where.membershipClass, undefined);
  assert.equal(query.where.OR[0].fullName.contains, 'Test Member');
  assert.equal(query.where.OR[1].email.contains, 'Test Member');
  assert.equal(query.where.OR[2].membershipId.contains, 'Test Member');
  assert.deepEqual(query.orderBy, [{ membershipId: 'desc' }, { id: 'asc' }]);
  assert.equal(query.skip, 10);
  assert.equal(query.take, 10);
});

test('category tabs and sorted exports retain their category constraints', async () => {
  await directory({ category: 'Graduate', sortKey: 'category', sortDir: 'asc', limit: '500' });
  assert.equal(query.where.membershipClass, 'Graduate');
  assert.deepEqual(query.orderBy, [{ membershipClass: 'asc' }, { id: 'asc' }]);
  assert.equal(query.take, 500);
  await directory({ category: 'Firm' });
  assert.equal(query.where.membershipClass.in.length, 6);
});

test('unsupported sort inputs fall back to name ascending', async () => {
  await directory({ sortKey: 'passwordHash', sortDir: 'invalid' });
  assert.deepEqual(query.orderBy, [{ fullName: 'asc' }, { id: 'asc' }]);
});
