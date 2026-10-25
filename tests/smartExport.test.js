const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../frontend/src/lib/export/smartExport.ts');
const helperModule = new Module(filename, module);
helperModule.filename = filename;
helperModule.paths = Module._nodeModulePaths(path.dirname(filename));
helperModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { EXPORT_FIELDS, exportRows, exportCsv, exportExcel, exportFilename, loadExportMembers } = helperModule.exports;
const XLSX = require('../../frontend/node_modules/xlsx');
const ExcelJS = require('../../frontend/node_modules/exceljs');

test('filename includes the selected status and Kigali date across a UTC date boundary', () => {
  const instant = new Date('2026-10-24T22:30:45Z');
  assert.equal(exportFilename('In Mentorship', 'csv', instant), 'RIQS In Mentorship 25 October 2026.csv');
  assert.equal(exportFilename('all', 'xlsx', instant), 'RIQS All Members 25 October 2026.xlsx');
  assert.equal(exportFilename('Pending Payment', 'csv', instant), 'RIQS Pending Payment 25 October 2026.csv');
  assert.equal(exportFilename('Active', 'csv', instant), 'RIQS Active 25 October 2026.csv');
});

test('CSV roundtrip preserves quoted names, commas, line breaks, Unicode and phone numbers', () => {
  const fields = EXPORT_FIELDS.filter(f => ['fullName', 'phoneNumber', 'expiresAt'].includes(f.k));
  const rows = exportRows([{ fullName: 'A "quoted", José\nGraduate', phoneNumber: '+250788123456', expiresAt: '31 Dec 2026', expiresAtIso: '2026-12-31T00:00:00.000Z' }], fields);
  const csv = exportCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  const sheet = XLSX.read(csv.slice(1), { type: 'string', raw: true }).Sheets.Sheet1;
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 }), rows);
  assert.equal(rows[1][2], '2026-12-31');
  assert.equal(exportRows([{ expiresAt: 'N/A' }], [EXPORT_FIELDS[8]])[1][0], 'N/A');
});

test('Excel output is a real XLSX workbook with selected columns and phone numbers stored as text', async () => {
  const rows = exportRows([{ fullName: 'Graduate', phoneNumber: '+250788123456' }], [EXPORT_FIELDS[1], EXPORT_FIELDS[5]]);
  const buffer = await exportExcel(rows);
  assert.equal(Buffer.from(buffer).subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Members');
  assert.equal(sheet.columnCount, 2);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A1').value, 'Full Name');
  assert.equal(sheet.getCell('B2').value, '+250788123456');
  assert.equal(sheet.views[0].ySplit, 1);
});

test('loads all pages instead of silently exporting only the first page', async () => {
  const calls = [];
  const members = await loadExportMembers(async (page, limit) => {
    calls.push([page, limit]);
    return { members: page === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }], pagination: { total: 3 } };
  });
  assert.deepEqual(members.map(m => m.id), ['a', 'b', 'c']);
  assert.deepEqual(calls, [[1, 500], [2, 500]]);
  await assert.rejects(() => loadExportMembers(async () => ({ members: [], pagination: { total: 3 } })), /changed while loading/);
  assert.deepEqual(await loadExportMembers(async () => ({ members: [], pagination: { total: 0 } })), []);
});
