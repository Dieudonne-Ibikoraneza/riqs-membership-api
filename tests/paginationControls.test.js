const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the shared controls' event contract with lightweight UI primitives.
// Page components own the data; the bar must return to page one when resized.
const filename = path.resolve(__dirname, '../../frontend/src/components/ui/pagination-bar.tsx');
const component = new Module(filename, module);
component.filename = filename;
component.paths = Module._nodeModulePaths(path.dirname(filename));
const element = (type, props) => ({ type, props });
component.require = id => {
  if (id === 'react') return { useMemo: fn => fn() };
  if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element };
  if (id === '@/components/ui/button') return { Button: 'Button' };
  if (id === '@/components/ui/select') return Object.fromEntries(['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map(name => [name, name]));
  if (id === '@/lib/utils') return { cn: (...classes) => classes.filter(Boolean).join(' ') };
  if (id === 'lucide-react') return Object.fromEntries(['ChevronLeft', 'ChevronRight', 'ChevronsLeft', 'ChevronsRight'].map(name => [name, name]));
  throw new Error(`Unexpected dependency: ${id}`);
};
component._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);
const { PaginationBar, RowsPerPageSelect } = component.exports;
function findAll(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}

test('resizing a later page selects the new limit and returns to page one', () => {
  const events = [];
  const bar = PaginationBar({ page: 7, totalPages: 12, pageSize: 15, onPageSizeChange: size => events.push(['size', size]), onChange: page => events.push(['page', page]) });
  const selector = findAll(bar, node => node.type === RowsPerPageSelect)[0];
  selector.props.onChange(50);
  assert.deepEqual(events, [['size', 50], ['page', 1]]);
});

test('single-page lists keep the size selector while navigation is disabled', () => {
  const bar = PaginationBar({ page: 1, totalPages: 1, pageSize: 100, onPageSizeChange() {}, onChange() {} });
  assert.equal(findAll(bar, node => node.type === RowsPerPageSelect).length, 1);
  const arrows = findAll(bar, node => node.type === 'Button' && node.props.title);
  assert.equal(arrows.length, 4);
  assert.ok(arrows.every(button => button.props.disabled));
});

test('shared selector offers the payment page limits and emits a numeric value', () => {
  let selected;
  const selector = RowsPerPageSelect({ value: 15, onChange: value => { selected = value; } });
  assert.deepEqual(findAll(selector, node => node.type === 'SelectItem').map(item => item.props.value), ['15', '30', '50', '100']);
  findAll(selector, node => node.type === 'Select')[0].props.onValueChange('100');
  assert.equal(selected, 100);
});

test('page navigation remains usable after consolidating custom paginators', () => {
  let selected;
  const bar = PaginationBar({ page: 4, totalPages: 20, onChange: page => { selected = page; } });
  findAll(bar, node => node.type === 'Button' && node.props.title === 'Next Page')[0].props.onClick();
  assert.equal(selected, 5);
  findAll(bar, node => node.type === 'Button' && node.props.title === 'Last Page')[0].props.onClick();
  assert.equal(selected, 20);
});
