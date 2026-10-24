const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { z } = require('zod');
const filename = path.resolve(__dirname, '../../frontend/src/lib/import/rosterImportParser.ts');
const parserModule = new Module(filename, module);
parserModule.filename = filename;
parserModule.paths = Module._nodeModulePaths(path.dirname(filename));
parserModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const parser = parserModule.exports;
const XLSX = require('../../frontend/node_modules/xlsx');

test('preview email validation agrees with backend validation', () => {
  for (const email of ['bad|@gmail.com', 'a..b@gmail.com', '.a@gmail.com', 'a@b.c', 'valid+tag@example.co.rw', "o'brien@example.com", 'valid_name@example.com']) {
    assert.equal(parser.isValidEmail(email), z.string().email().safeParse(email).success, email);
  }
});

test('registered graduates retain their IDs, exclude invalid and conflicting contacts, and use unique keys across sheets', async () => {
  const workbook = XLSX.utils.book_new();
  const matrix = [
    ['S/N', 'REGISTRATION NUMBER', '', '', '', '', '', '', 'NAME', 'CONTACT', 'EMAIL ADDRESS'],
    [1, 'RIQS', '/', 2024, '/', 'GrQS', '/', 25, 'Test Graduate', '0784173933', 'bad|@gmail.com'],
    [2, 'RIQS', '/', 2024, '/', 'GrQS', '/', 34, 'First Name', '0784173933', 'shared@gmail.com'],
    [3, 'RIQS', '/', 2025, '/', 'GrQS', '/', 36, 'Second Name', '0784173933', 'SHARED@gmail.com'],
    [4, 'RIQS', '/', 2026, '/', 'GrQST', '/', 1, 'Technologist', '0784173933', 'good@example.com'],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'First');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'Second');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const result = await parser.parseRosterWorkbook({ arrayBuffer: async () => buffer });
  assert.equal(result.rows.length, 8);
  assert.equal(new Set(result.rows.map(r => r.key)).size, 8);
  assert.ok(result.rows.every(r => r.sourceSheet === 'GRADUATE'));
  assert.equal(result.rows[0].membershipIdOverride, 'RIQS-2024-GrQS-0025');
  assert.equal(result.rows[0].include, false);
  assert.equal(result.rows[1].include, false);
  assert.match(result.rows[1].reason, /Duplicate email/);
  assert.equal(parser.toSubmitRow(result.rows[0]).rawSourceRow, 2);
  assert.equal(parser.getDuplicateIssues([result.rows[1]]).size, 0);
});
