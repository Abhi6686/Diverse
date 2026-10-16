/* The three-way merge on its own, under plain node.
 *
 *   node tests/merge.js
 */
'use strict';

const M = require('../js/merge.js');

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  -> ' + detail : ''}`);
}
const J = JSON.stringify;

function takeoff() {
  return {
    id: 'tko-1', updatedAt: '2026-10-07T10:00:00.000Z',
    products: [
      { id: 'p1', type: 'Guardrail', totalLF: 10, groups: [
        { id: 'g1', name: 'Rails', items: [{ id: 'i1', qty: 1 }, { id: 'i2', qty: 2 }],
          grid: { columns: [{ key: 'c1', label: 'Top' }], rows: [{ ref: '1', values: { c1: 5 } }] } }
      ] },
      { id: 'p2', type: 'Stair', totalLF: 20, groups: [] }
    ]
  };
}

// Unchanged on one side takes the other.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  theirs.products[0].totalLF = 99;
  const r = M.merge3(base, mine, theirs);
  check('an edit only they made is taken', r.value.products[0].totalLF === 99);
  check('with no clash', r.conflicts.length === 0, J(r.conflicts));
}

// Edits to different products both survive.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  mine.products[0].totalLF = 11;
  theirs.products[1].totalLF = 22;
  mine.updatedAt = '2026-10-07T10:00:05.000Z';
  theirs.updatedAt = '2026-10-07T10:00:09.000Z';
  const r = M.merge3(base, mine, theirs);
  check('my edit to product 1 survives', r.value.products[0].totalLF === 11);
  check('their edit to product 2 survives', r.value.products[1].totalLF === 22);
  check('the later timestamp wins without a clash', r.value.updatedAt === theirs.updatedAt && !r.conflicts.length,
    J(r.conflicts));
}

// Both add a product.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  mine.products.push({ id: 'pm', type: 'Mine', groups: [] });
  theirs.products.push({ id: 'pt', type: 'Theirs', groups: [] });
  const r = M.merge3(base, mine, theirs);
  check('both new products are kept', r.value.products.map(p => p.id).join() === 'p1,p2,pt,pm',
    r.value.products.map(p => p.id).join());
}

// Add on one side, delete on the other.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  mine.products.splice(1, 1);                 // I removed p2
  theirs.products[0].groups[0].items.push({ id: 'i3', qty: 3 });   // they added an item
  const r = M.merge3(base, mine, theirs);
  check('my deletion holds', r.value.products.length === 1 && r.value.products[0].id === 'p1');
  check('their added item is there', r.value.products[0].groups[0].items.length === 3);
}

// Their reorder plus my insertion.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  theirs.products.reverse();
  mine.products.splice(1, 0, { id: 'pm', type: 'Mine', groups: [] });   // after p1
  const r = M.merge3(base, mine, theirs);
  check('their order is kept and my insert follows its predecessor',
    r.value.products.map(p => p.id).join() === 'p2,p1,pm', r.value.products.map(p => p.id).join());
}

// My reorder survives their unrelated edit.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  mine.products.reverse();
  theirs.products[0].totalLF = 50;
  const r = M.merge3(base, mine, theirs);
  check('my reorder survives', r.value.products.map(p => p.id).join() === 'p2,p1');
  check('and so does their edit', r.value.products[1].totalLF === 50);
}

// Drawing rows: both add a row, and edit different cells of the same row.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  const gm = mine.products[0].groups[0].grid, gt = theirs.products[0].groups[0].grid;
  gm.rows.push({ ref: '2', values: { c1: 7 } });
  gt.rows.push({ ref: '3', values: { c1: 9 } });
  gm.rows[0].ref = '1A';
  gt.rows[0].values.c1 = 6;
  const r = M.merge3(base, mine, theirs);
  const rows = r.value.products[0].groups[0].grid.rows;
  check('rows added on both sides are all kept', rows.map(x => x.ref).join() === '1A,3,2',
    rows.map(x => x.ref).join());
  check('edits to different cells of one row both land', rows[0].ref === '1A' && rows[0].values.c1 === 6);
}

// Drawing rows with ids: both add one, one deletes a row the other edits.
{
  const withIds = () => {
    const t = takeoff();
    t.products[0].groups[0].grid.rows = [{ id: 'r1', ref: '1', values: {} }, { id: 'r2', ref: '2', values: {} }];
    return t;
  };
  const base = withIds(), mine = withIds(), theirs = withIds();
  const gm = mine.products[0].groups[0].grid, gt = theirs.products[0].groups[0].grid;
  gm.rows.push({ id: 'rm', ref: 'mine', values: {} });
  gt.rows.push({ id: 'rt', ref: 'theirs', values: {} });
  gm.rows[1].ref = '2 edited here';         // r2, which they delete
  gt.rows.splice(1, 1);
  gm.rows[0].values = { c1: 3 };           // r1, which they also touch elsewhere
  gt.rows[0].ref = '1 edited there';
  const r = M.merge3(base, mine, theirs);
  const rows = r.value.products[0].groups[0].grid.rows;
  check('rows with ids: both new rows are kept', rows.some(x => x.id === 'rm') && rows.some(x => x.id === 'rt'),
    rows.map(x => x.id).join());
  check('a row deleted there stays deleted', !rows.some(x => x.id === 'r2'));
  check('two edits to different fields of one row both land',
    rows[0].ref === '1 edited there' && rows[0].values.c1 === 3, J(rows[0]));
}

// A real clash: the local value wins and is reported.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  mine.products[0].groups[0].items[0].qty = 4;
  theirs.products[0].groups[0].items[0].qty = 8;
  const r = M.merge3(base, mine, theirs);
  check('the value typed here wins a clash', r.value.products[0].groups[0].items[0].qty === 4);
  check('and the clash is reported', r.conflicts.length === 1 && M.describe(r.conflicts[0]) === 'qty',
    J(r.conflicts));
}

// String lists merge as sets.
{
  const r = M.merge3(['A', 'B'], ['A', 'B', 'C'], ['B', 'D']);
  check('a name list keeps both additions and their removal', J(r.value) === J(['B', 'D', 'C']), J(r.value));
}

// The result is a fresh object.
{
  const base = takeoff(), mine = takeoff(), theirs = takeoff();
  const r = M.merge3(base, mine, theirs);
  check('the merged value is not one of the inputs', r.value !== mine && r.value !== theirs);
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll merge checks passed.');
process.exit(failures ? 1 : 0);
