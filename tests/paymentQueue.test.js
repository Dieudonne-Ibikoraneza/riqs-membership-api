const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');

const dbPath = require.resolve('../src/config/db.ts');
let listQuery;
let countQuery;
let rows = [];
const prisma = {
  financialTransaction: {
    findMany: async query => { listQuery = query; return rows; },
    count: async query => { countQuery = query; return 31; }
  }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } };
const { getPendingPayments } = require('../src/controllers/paymentController.ts');

async function queue(query, user = { id: 'staff-1' }) {
  listQuery = countQuery = undefined;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await getPendingPayments({ user, query }, res);
  return res;
}

test('queue applies server pagination and the same filters to records and total', async () => {
  const res = await queue({ page: '2', limit: '15', status: 'Paid', method: 'Offline', txType: 'Annual_Renewal', search: '  Alice   example.com ' });
  assert.equal(res.statusCode, 200);
  assert.equal(listQuery.skip, 15);
  assert.equal(listQuery.take, 15);
  assert.deepEqual(listQuery.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(countQuery.where, listQuery.where);
  assert.equal(listQuery.where.status, 'Paid');
  assert.equal(listQuery.where.txType, 'Annual_Renewal');
  const [method, ...terms] = listQuery.where.AND;
  assert.deepEqual(method.AND, [{ paymentMethod: { not: 'Mobile_Money' } }, { paymentMethod: { not: null } }]);
  assert.equal(terms.length, 2);
  assert.deepEqual(terms[0].OR[0], { member: { fullName: { contains: 'Alice', mode: 'insensitive' } } });
  assert.deepEqual(terms[1].OR[1], { member: { email: { contains: 'example.com', mode: 'insensitive' } } });
  assert.equal(terms[0].OR.length, 5);
  assert.deepEqual(res.body.pagination, { total: 31, page: 2, limit: 15, totalPages: 3 });
  assert.deepEqual(listQuery.where.NOT, { providerTransactionId: { not: null }, status: 'Pending_Verification', clearedAt: null });
});

test('queue preserves report-sized requests and defaults', async () => {
  await queue({ status: 'all', limit: '100000' });
  assert.equal(listQuery.take, 100000);
  assert.equal(listQuery.where.status, undefined);
  assert.deepEqual(listQuery.where.AND, [{}]);
  await queue({ method: 'Online' });
  assert.equal(listQuery.where.status, 'Pending_Verification');
  assert.deepEqual(listQuery.where.AND, [{ paymentMethod: 'Mobile_Money' }]);
});

test('queue rejects malformed pagination and filters before querying the database', async () => {
  for (const query of [
    { page: '0' }, { page: '-1' }, { page: '1abc' }, { page: ['1'] },
    { limit: '0' }, { limit: '1.5' }, { limit: '100001' }, { page: '9007199254740991', limit: '20' },
    { status: 'invalid' }, { method: 'invalid' }, { txType: 'invalid' },
    { search: ['Alice'] }, { search: 'a'.repeat(201) }
  ]) {
    const res = await queue(query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(listQuery, undefined);
    assert.equal(countQuery, undefined);
  }
});

test('queue requires authentication', async () => {
  const res = await queue({}, null);
  assert.equal(res.statusCode, 401);
  assert.equal(listQuery, undefined);
});
