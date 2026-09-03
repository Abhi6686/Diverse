/* End-to-end smoke test in a real DOM.
   Boots the actual HTML file with jsdom, then drives the app the way a user
   would: create a takeoff, type a part, save, check the catalog learned it,
   generate a proposal, and confirm the printed total.
   Run with:  node tests/smoke.js
   Needs:     npm install jsdom fake-indexeddb --no-save */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'Bid_Proposal_Manager_2026.html');

let failures = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) { failures++; errors.push(label); }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  -> ' + detail : ''}`);
}

const vc = new VirtualConsole();
vc.on('jsdomError', e => { failures++; errors.push('jsdomError: ' + e.message); console.log('FAIL  page error: ' + e.message); });
vc.on('error', (...a) => { failures++; errors.push('console.error'); console.log('FAIL  console.error: ' + a.join(' ')); });

// Strip the CDN tags: no network in the test, and the app must not depend on
// them for anything but styling/charts/xlsx.
let html = fs.readFileSync(HTML, 'utf8')
  .replace(/<script src="https:[^"]*"><\/script>/g, '')
  .replace(/<link href="https:[^"]*"[^>]*>/g, '');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'file://' + HTML.replace(/\\/g, '/'),
  virtualConsole: vc,
  beforeParse(win) {
    // jsdom has no localStorage under file://, and no execCommand.
    const store = {};
    Object.defineProperty(win, 'localStorage', {
      value: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
      }
    });
    // Real IndexedDB semantics, in memory - the app's primary storage path.
    win.indexedDB = new FDBFactory();
    win.IDBKeyRange = FDBKeyRange;
    win.document.execCommand = () => true;
    win.print = () => {};
    win.alert = m => { console.log('    (alert) ' + m); };
    win.confirm = () => true;
    win.prompt = () => 'x';
    win.URL.createObjectURL = () => 'blob:test';
    win.URL.revokeObjectURL = () => {};
  }
});

// Resolve the local <script src="js/*.js"> tags by hand: jsdom will not fetch
// them from file:// reliably across platforms.
const win = dom.window;
const localScripts = ['js/seed.js', 'js/references.seed.js', 'js/catalog.seed.js', 'js/proposal.styles.js',
  'js/proposal.defaults.js', 'js/util.js', 'js/auth.js', 'js/store.js', 'js/nav.js', 'js/rates.js', 'js/catalog.js',
  'js/bidgrid.js', 'js/references.js', 'js/ratespanel.js', 'js/takeoff.model.js', 'js/takeoff.js',
  'js/proposal.paginate.js', 'js/proposal.js', 'js/ratelib.js', 'js/bids.js', 'js/assignments.js', 'js/project.js',
  'js/settings.js', 'js/sparks.js', 'js/app.js'];

// Wait until parsing has finished, otherwise app.js correctly defers its boot to
// DOMContentLoaded and the assertions below would run against an empty page.
new Promise(resolve => {
  if (win.document.readyState === 'complete') return resolve();
  win.addEventListener('load', resolve);
}).then(() => {
  localScripts.forEach(f => {
    const el = win.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, f), 'utf8');
    win.document.body.appendChild(el);
  });
  // Boot is async now (IndexedDB). Wait for the store to be in memory and the
  // first render to have happened, rather than asserting against a blank page.
  return waitFor(() => win.Store && win.Store.db && win.U.$('kpiTotal').textContent !== '0',
    'app to finish booting');
}).then(run).catch(e => {
  console.log('FAIL  harness: ' + e.message);
  console.log(e.stack);
  process.exit(1);
});

function waitFor(cond, what, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let ok = false;
      try { ok = cond(); } catch (e) { /* not ready */ }
      if (ok) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for ' + what));
      setTimeout(poll, 10);
    })();
  });
}

/* Read the persisted state straight out of IndexedDB, bypassing the app. */
function readState() {
  return new Promise((resolve, reject) => {
    const req = win.indexedDB.open('diverse-bid');
    req.onsuccess = () => {
      const d = req.result;
      const r = d.transaction('state', 'readonly').objectStore('state').get('db');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/* The bids table is rendered entirely by js/bidgrid.js into #bidsGridHost. */
function gridEl() { return win.document.querySelector('#bidsGridHost table'); }
function gridHTML() { const t = gridEl(); return t ? t.tBodies[0].innerHTML : ''; }
function gridHead() { const t = gridEl(); return t ? t.tHead.innerHTML : ''; }
function gridHeadCells() { const t = gridEl(); return t ? t.tHead.querySelectorAll('th') : []; }
function gridRows() {
  const t = gridEl();
  if (!t) return [];
  // The "no bids match" placeholder is one row with a colspan; not a data row.
  return [...t.tBodies[0].querySelectorAll('tr')].filter(r => r.querySelectorAll('td').length > 1);
}

async function run() {
const { Store, Bids, Takeoff, Proposal, RateLib, Catalog, App, Nav, BidGrid,
        Project, Settings, Assign, Rates, TakeoffModel: M, U } = win;

console.log('--- boot ---');
check('store initialised', !!Store.db);
check('seed bids loaded (93)', Store.db.bids.length === 93, String(Store.db.bids.length));
check('catalog seeded (60 parts)', Catalog.all().length === 60, String(Catalog.all().length));
check('9 proposal styles present', Object.keys(win.PROPOSAL_STYLES).length === 9);
check('KPI total rendered', U.$('kpiTotal').textContent === '93', U.$('kpiTotal').textContent);
check('active bid rows rendered', gridRows().length > 0);
check('month grid rendered', U.$('monthGrid').children.length === 12);

console.log('\n--- search null-safety ---');
// A record with fields entirely absent (not just empty strings) is what the old
// bare .toLowerCase() calls would have thrown on.
Store.db.bids.push({ id: 99001, sr: 999, project: 'Sparse Record', portal: 'Other', status: 'In Progress', month: 6 });
U.$('searchActive').value = 'walmart';
let threw = null;
try { Bids.filterTable(); } catch (e) { threw = e; }
check('search over a record with missing fields does not throw', !threw, threw && threw.message);
check('search returns matches', gridRows().length > 0);
U.$('searchActive').value = '';
threw = null;
try { ['all', 'active', 'awarded'].forEach(v => Bids.setView(v)); } catch (e) { threw = e; }
check('all three views render a sparse record', !threw, threw && threw.message);
Bids.setView('active');
Store.db.bids = Store.db.bids.filter(b => b.id !== 99001);
Bids.refresh();

console.log('\n--- regions ---');
const before = Store.db.regions.slice();
Bids.populateRegionSelects();
Bids.populateRegionSelects();
check('populateRegionSelects does not mutate the source array',
  JSON.stringify(before) === JSON.stringify(Store.db.regions));

console.log('\n--- takeoff ---');
const bid = Store.db.bids[0];
Takeoff.openForBid(bid.id);
check('takeoff created and linked to the bid', !!bid.takeoffId && !!Store.db.takeoffs[bid.takeoffId]);
App.switchTab('takeoff');
check('takeoff tab renders', U.$('section-takeoff').innerHTML.length > 500);

Takeoff.addProduct('Steel Guardrail');
const t = Store.db.takeoffs[bid.takeoffId];
const prod = t.products[0];
check('product seeded with its group', prod.groups.length === 1);
check('grid columns seeded from the template', prod.groups[0].grid.columns.length === 15,
  String(prod.groups[0].grid.columns.length));

Takeoff.setTotalLF(442.43);
check('engineering hours auto-filled (442.43*0.3+16)',
  Math.abs(prod.labour.engineering.hrs - 148.729) < 0.001, String(prod.labour.engineering.hrs));
check('finish qty auto-filled from LF', prod.finish.qty === 442.43);

console.log('\n--- override behaviour ---');
Takeoff.setCost('labour.installation.hrs', 200);
check('typed value marks the field overridden', prod.overrides['labour.installation.hrs'] === true);
Takeoff.setTotalLF(500);
check('overridden field holds its value when LF changes', prod.labour.installation.hrs === 200,
  String(prod.labour.installation.hrs));
check('non-overridden field follows the formula',
  Math.abs(prod.labour.engineering.hrs - 166) < 0.001, String(prod.labour.engineering.hrs));
Takeoff.clearOverride('labour.installation.hrs');
check('clearing the override restores the formula value', prod.labour.installation.hrs === 250,
  String(prod.labour.installation.hrs));
Takeoff.setTotalLF(442.43);

console.log('\n--- catalog autofill + learning ---');
Takeoff.addItem();
const item = prod.groups[0].items[0];
const hits = Catalog.suggest('12801400', 'Steel Guardrail', 8);
check('seeded part is suggested by part number', hits.length > 0 && hits[0].item.partNo === '12801400',
  hits.length ? hits[0].item.partNo : 'no hits');
check('suggestion is flagged as used on this product type', hits[0].onType === true);
// Same call the combobox makes when you pick a suggestion.
Takeoff.applyCatalogItem(item.id, hits[0].item.id);
check('autofill populated vendor', item.vendor === 'Alro', item.vendor);
check('autofill populated part number', item.partNo === '12801400', item.partNo);
check('autofill populated grade', item.grade === 'ASTM A500', item.grade);
check('autofill populated unit cost', Math.abs(item.unitCost - 162.6957) < 0.001, String(item.unitCost));
check('autofill linked the row back to the catalog entry', item.catalogId === hits[0].item.id);

win.Takeoff.setItem(item.id, 'qty', 23);
check('row total = qty x unit cost',
  Math.abs(M.itemTotal(item, prod.groups[0]) - 3742) < 0.5,
  String(M.itemTotal(item, prod.groups[0])));

// A brand-new part the library has never seen.
Takeoff.addItem();
const fresh = prod.groups[0].items[1];
win.Takeoff.setItem(fresh.id, 'vendor', 'Acme Fasteners');
win.Takeoff.setItem(fresh.id, 'partNo', 'AF-9001');
win.Takeoff.setItem(fresh.id, 'description', 'Stainless carriage bolt 3/8" x 2"');
win.Takeoff.setItem(fresh.id, 'qty', 40);
win.Takeoff.setItem(fresh.id, 'unitCost', 1.25);

const catBefore = Catalog.all().length;
Takeoff.commit();
check('new part was learned into the rate library', Catalog.all().length === catBefore + 1,
  `${catBefore} -> ${Catalog.all().length}`);
const learned = Catalog.all().filter(c => c.partNo === 'AF-9001')[0];
check('learned part is marked as learned', learned && learned.source === 'learned');
check('learned part is tagged with the product type',
  learned && learned.sowTags.indexOf('Steel Guardrail') >= 0);
check('learned part is now suggested', Catalog.suggest('AF-9001', 'Steel Guardrail', 5).length > 0);

console.log('\n--- price versioning ---');
win.Takeoff.setItem(fresh.id, 'unitCost', 1.60);
Takeoff.commit();
const reLearned = Catalog.all().filter(c => c.partNo === 'AF-9001')[0];
check('price history recorded both prices', reLearned.priceHistory.length === 2,
  String(reLearned.priceHistory.length));
check('catalog holds the newest price', reLearned.unitCost === 1.60, String(reLearned.unitCost));
check('use count incremented', reLearned.useCount === 2, String(reLearned.useCount));

console.log('\n--- write-back to the bid ---');
const roll = M.computeTakeoff(t);
check('bid price updated from the takeoff', bid.price === Math.round(roll.total),
  `${bid.price} vs ${Math.round(roll.total)}`);
check('bid LF updated from the takeoff', Math.abs(bid.lf - 442.43) < 0.01, String(bid.lf));
bid.priceLocked = true;
const lockedPrice = bid.price = 999999;
Takeoff.commit();
check('locked price is not overwritten', bid.price === lockedPrice, String(bid.price));
bid.priceLocked = false;

console.log('\n--- drawing grid ---');
Takeoff.setTab('grid');
Takeoff.addRow();
const colKey = prod.groups[0].grid.columns[0].key;
Takeoff.setCellValue(0, colKey, 442.43);
check('grid subtotal computed', M.gridSubtotals(prod.groups[0])[colKey] === 442.43);
check('"use as total" is gone', typeof Takeoff.useAsTotal !== 'function');
check('grid header no longer renders the "use as total" control',
  !/use as total/.test(U.$('section-takeoff').innerHTML));

// fx quantity referencing the grid, exactly as Excel does it.
win.Takeoff.setTab('materials');
win.Takeoff.toggleQtyMode(item.id);
win.Takeoff.setItem(item.id, 'qtyExpr',
  'ROUNDUP(TK("' + prod.groups[0].grid.columns[0].label.replace(/"/g, '\\"') + '")/21,0)+1');
check('fx quantity evaluates like the workbook',
  M.itemQty(item, prod.groups[0]) === 23, String(M.itemQty(item, prod.groups[0])));
win.Takeoff.toggleQtyMode(item.id);

console.log('\n--- cost rows: hide, rename, proposal checkbox ---');
Takeoff.setTab('cost');
const costBefore = M.computeProduct(prod).total;
const forkTotal = M.computeProduct(prod).forkTotal;

// The checkbox must not touch money. This is the assertion that matters most:
// a test that only checked the proposal text would pass while cost broke.
Takeoff.setRowOnProposal('supervisor', false);
check('unticking a row leaves the cost untouched',
  Math.abs(M.computeProduct(prod).total - costBefore) < 0.0001,
  `${M.computeProduct(prod).total} vs ${costBefore}`);
check('unticked row is recorded', M.isRowOnProposal(prod, 'supervisor') === false);
Takeoff.setRowOnProposal('supervisor', true);
check('reticking restores it', M.isRowOnProposal(prod, 'supervisor') === true);
check('and still leaves the cost untouched',
  Math.abs(M.computeProduct(prod).total - costBefore) < 0.0001);

// Hiding, by contrast, must change the money.
prod.hiddenRows.forklift = true;
const afterHide = M.computeProduct(prod);
check('hiding a row removes it from the subtotal',
  Math.abs((costBefore - afterHide.total) - forkTotal * 1.45) < 0.01,
  `removed ${costBefore - afterHide.total}, row is ${forkTotal} x 1.45`);
check('the hidden row keeps its own computed value', afterHide.forkTotal === forkTotal);
check('hidden count reported', afterHide.hiddenCount === 1);
check('a hidden row can never be on the proposal',
  M.isRowOnProposal(prod, 'forklift') === false);
delete prod.hiddenRows.forklift;
check('restoring brings the value straight back',
  Math.abs(M.computeProduct(prod).total - costBefore) < 0.0001,
  `${M.computeProduct(prod).total} vs ${costBefore}`);

// Every standard row hidden leaves material cost (plus markup) only.
M.COST_ROWS.forEach(d => { prod.hiddenRows[d.id] = true; });
const bare = M.computeProduct(prod);
check('hiding every row leaves material + extras only',
  Math.abs(bare.subtotal - (bare.materialCost + bare.extrasTotal)) < 0.0001,
  `${bare.subtotal} vs ${bare.materialCost + bare.extrasTotal}`);
prod.hiddenRows = {};

console.log('\n--- cost row labels ---');
check('default label used when nothing is set',
  M.rowLabel(prod, 'engineering') === 'Engineering cost', M.rowLabel(prod, 'engineering'));
Takeoff.setRowLabel('engineering', 'Detailing & shop drawings');
check('custom label applied', M.rowLabel(prod, 'engineering') === 'Detailing & shop drawings');
check('finish label is the fixed prefix plus the product\'s wording',
  M.defaultRowLabel(prod, 'finish') === M.FINISH_PREFIX + prod.finish.label,
  M.defaultRowLabel(prod, 'finish'));
// A second product must not inherit the first one's rename.
Takeoff.addProduct('Bollard');
const other = t.products[t.products.length - 1];
check('a rename does not leak to another product',
  M.rowLabel(other, 'engineering') === 'Engineering cost', M.rowLabel(other, 'engineering'));
Takeoff.selectProduct(prod.id);
Takeoff.setRowLabel('engineering', '');
check('blank label falls back to the default',
  M.rowLabel(prod, 'engineering') === 'Engineering cost');
Takeoff.setRowLabel('engineering', 'Detailing & shop drawings');
Takeoff.resetRowLabel('engineering');
check('reset restores the default',
  M.rowLabel(prod, 'engineering') === 'Engineering cost' &&
  prod.rowLabels.engineering === undefined);
// Drop the extra Bollard so later product-count assertions stay meaningful.
t.products = t.products.filter(x => x.id !== other.id);
Takeoff.selectProduct(prod.id);

console.log('\n--- the locked "Finish - " prefix ---');
check('every seeded product type gets the prefix',
  Rates.TYPES.every(ty => M.rowLabel(M.newProduct(ty), 'finish').indexOf(M.FINISH_PREFIX) === 0),
  Rates.TYPES.map(ty => M.rowLabel(M.newProduct(ty), 'finish')).join(' | '));
Takeoff.setRowLabel('finish', 'Anodized Exterior');
check('the estimator supplies only the part after the prefix',
  M.rowLabel(prod, 'finish') === 'Finish - Anodized Exterior' &&
  prod.finish.label === 'Anodized Exterior', M.rowLabel(prod, 'finish'));
check('the prefix survives an empty description',
  (Takeoff.setRowLabel('finish', ''), M.rowLabel(prod, 'finish') === 'Finish'),
  M.rowLabel(prod, 'finish'));
Takeoff.setRowLabel('finish', 'Painted');
check('the finish row cannot be renamed through rowLabels', (() => {
  prod.rowLabels.finish = 'Sneaky rename with no prefix';
  const got = M.rowLabel(prod, 'finish');
  delete prod.rowLabels.finish;
  return got === 'Finish - Painted';
})());
Takeoff.resetRowLabel('finish');
check('reset restores the product type\'s own finish wording',
  M.rowLabel(prod, 'finish') === M.FINISH_PREFIX + Rates.template(prod.type).finishLabel,
  M.rowLabel(prod, 'finish'));

// The migration must not double the prefix on data written before it existed.
{
  const legacy = {
    schemaVersion: 6, bids: [], proposals: {},
    takeoffs: { t1: { products: [
      { finish: { label: 'Finish: Painted' }, rowLabels: {} },
      { finish: { label: 'Hot Dip Galvanized' }, rowLabels: {} },
      { finish: { label: 'Painted' }, rowLabels: { finish: 'Finish - Powder coated' } }
    ] } }
  };
  const once = Store.migrate(JSON.parse(JSON.stringify(legacy)));
  const p = once.takeoffs.t1.products;
  check('a stored "Finish:" lead-in is stripped, not doubled',
    p[0].finish.label === 'Painted', p[0].finish.label);
  check('wording without a lead-in is left alone',
    p[1].finish.label === 'Hot Dip Galvanized', p[1].finish.label);
  check('a rowLabels rename moves into finish.label and is stripped',
    p[2].finish.label === 'Powder coated' && p[2].rowLabels.finish === undefined,
    p[2].finish.label);
  const twice = Store.migrate(JSON.parse(JSON.stringify(once)));
  check('the migration is idempotent',
    twice.takeoffs.t1.products[0].finish.label === 'Painted');
}

console.log('\n--- project rates ---');
{
  const shopFab = Rates.forType('Steel Guardrail').fabricationRate;
  Takeoff.setProjectRate('fabricationRate', shopFab + 15);
  check('a project override applies inside that project',
    Rates.forType('Steel Guardrail', t).fabricationRate === shopFab + 15);
  check('it does not touch the shop default',
    Rates.forType('Steel Guardrail').fabricationRate === shopFab);
  check('an explicit project rate beats the workbook per-type quirk',
    Rates.forType('Wall Mount Handrail', t).fabricationRate === shopFab + 15,
    String(Rates.forType('Wall Mount Handrail', t).fabricationRate));

  // Hour factors feed the formulas, so they land immediately...
  const hrsBefore = prod.labour.fabrication.hrs;
  Takeoff.setProjectRate('fabFactor', Rates.forType(prod.type, t).fabFactor + 1);
  check('a factor override recalculates derived hours at once',
    prod.labour.fabrication.hrs !== hrsBefore,
    hrsBefore + ' -> ' + prod.labour.fabrication.hrs);

  // ...while a unit rate stored on the product waits to be applied.
  check('a unit rate override does not silently rewrite existing products',
    prod.labour.fabrication.rate === shopFab, String(prod.labour.fabrication.rate));
  Takeoff.applyRateToProducts('fabricationRate');
  check('Apply writes the project rate onto the products',
    prod.labour.fabrication.rate === shopFab + 15, String(prod.labour.fabrication.rate));

  Takeoff.clearProjectRate('fabricationRate');
  check('clearing an override returns the project to the shop default',
    Rates.forType('Steel Guardrail', t).fabricationRate === shopFab);
  check('clearing restores the workbook per-type quirk too',
    Rates.forType('Wall Mount Handrail', t).fabricationRate ===
    Rates.forType('Wall Mount Handrail').fabricationRate);
  Takeoff.clearProjectRate('fabFactor');
  check('an untouched project still tracks a later shop change', (() => {
    const other = M.newTakeoff(null);
    const was = Rates.ensure(Store.db).global.supervisorRate;
    Rates.ensure(Store.db).global.supervisorRate = was + 7;
    const got = Rates.forType('Stair', other).supervisorRate;
    Rates.ensure(Store.db).global.supervisorRate = was;
    return got === was + 7;
  })());
  check('the project rates page renders',
    (Takeoff.setView('rates'), /Project Rates/.test(U.$('section-takeoff').innerHTML)));
  Takeoff.setView('estimate');

  // Put the product back as it was: Apply deliberately wrote onto it, and the
  // proposal assertions further down compare against the workbook figures.
  prod.labour.fabrication.rate = shopFab;
  M.applyDerived(prod, t);
  Store.save();
}

console.log('\n--- the materials table and the workbook it exports ---');
{
  Takeoff.setView('estimate');
  Takeoff.setTab('materials');
  Takeoff.render();
  const table = U.$('section-takeoff').querySelector('#matBody').closest('table');
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  // The Options column held an abbreviated restatement of the Description.
  check('the materials table has no Options column',
    !heads.some(h => /^Options$/i.test(h)), heads.join('|'));
  check('but still has Features and Description',
    heads.includes('Features') && heads.includes('Description'), heads.join('|'));
  // A mismatch here silently shifts every value one column to the left.
  const bodyCells = table.querySelector('#matBody tr').querySelectorAll('td').length;
  check('every heading has a cell under it', bodyCells === heads.length,
    `${bodyCells} cells vs ${heads.length} headings`);
  const footCells = [...table.querySelectorAll('tfoot td')]
    .reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0);
  check('and the footer spans the same width', footCells === heads.length,
    `${footCells} vs ${heads.length}`);

  const sheet = Takeoff.productSheet(prod);
  check('the exported sheet drops Options too', !sheet[0].includes('Options'), sheet[0].join('|'));
  // The drawing grid further down the sheet has its own width, so only the
  // material rows are compared against the header.
  const anItem = prod.groups[0].items[0];
  const itemRow = sheet.find(r => r[3] === anItem.description);
  check('a material row is as wide as the header and starts with the feature',
    !!itemRow && itemRow.length === sheet[0].length && itemRow[0] === anItem.feature,
    JSON.stringify(itemRow));
  check('and its description is not displaced by the removed column',
    itemRow[sheet[0].indexOf('Desription')] === anItem.description,
    JSON.stringify(itemRow));
  // The labour lines pad by hand to the header width; if that drifts, the rate
  // and total land under the wrong headings.
  const eng = sheet.find(r => r[0] === 'Engineering cost');
  check('a labour line puts its total in the last column',
    eng.length === sheet[0].length && eng[eng.length - 1] > 0,
    JSON.stringify(eng));

  // Excel refuses a duplicate sheet name, and throws rather than renaming.
  const names = [];
  const XLSX = { utils: {
    book_new: () => ({}),
    aoa_to_sheet: a => a,
    book_append_sheet: (wb, s, name) => names.push(name)
  }, writeFile: () => {} };
  const realXLSX = win.XLSX;
  win.XLSX = XLSX;
  const realType = t.products[0].type;
  if (t.products.length > 1) t.products[1].type = realType;   // force a clash
  Takeoff.exportWorkbook();
  if (t.products.length > 1) t.products[1].type = realType + ' B';
  win.XLSX = realXLSX;
  check('the workbook leads with a summary sheet', names[0] === 'Summary', names.join(','));
  check('then one sheet per product',
    names.length === t.products.length + 1, names.join(','));
  check('and no two sheets share a name',
    new Set(names.map(n => n.toLowerCase())).size === names.length, names.join(','));
  check('no sheet name is longer than Excel allows',
    names.every(n => n.length <= 31), names.join(','));
}

console.log('\n--- material row proposal checkboxes ---');
const matBefore = M.computeProduct(prod).materialCost;
const firstItem = prod.groups[0].items[0];
Takeoff.setItemOnProposal(firstItem.id, false);
check('unticking a material row leaves Material Cost unchanged',
  Math.abs(M.computeProduct(prod).materialCost - matBefore) < 0.0001,
  `${M.computeProduct(prod).materialCost} vs ${matBefore}`);
check('unticked material row is recorded', M.isItemOnProposal(firstItem) === false);
Takeoff.setAllItemsOnProposal(false);
check('select-all-off unticks every row in the group',
  prod.groups[0].items.every(i => !M.isItemOnProposal(i)));
Takeoff.setAllItemsOnProposal(true);
check('select-all-on reticks every row',
  prod.groups[0].items.every(i => M.isItemOnProposal(i)));
check('and Material Cost is still unchanged throughout',
  Math.abs(M.computeProduct(prod).materialCost - matBefore) < 0.0001);

console.log('\n--- proposal ---');
Proposal.generateFromTakeoff(t.id);
const prop = Store.db.proposals[Proposal.currentId()];
check('proposal created and linked to the bid', !!prop && bid.proposalId === prop.id);
check('one scope item per product type',
  prop.scopeItems.filter(s => s.sourceType).length === t.products.length);
const scope0 = prop.scopeItems[0];
check('scope details carry the product Total Linear Feet',
  /Total Linear Feet: 442\.43 LF/.test(scope0.details), scope0.details);

console.log('\n--- what reaches the proposal ---');
check('ticked cost rows are described on the proposal',
  /Engineering cost/.test(scope0.details) && /Installation cost/.test(scope0.details),
  scope0.details);
check('no amounts leak into the bullet list',
  !/\$[\d,]/.test(scope0.details), scope0.details);
check('the scope item is worded the way the printed proposal words it',
  /^Supply and Installation of /.test(scope0.description), scope0.description);

/* The spec bullet is the feature and the full description - what the printed
   proposal carries - rather than the abbreviated Options value it used to use. */
{
  const withSpec = t.products.flatMap(p => p.groups.flatMap(g => g.items))
    .find(i => i.feature && i.description);
  const inDetails = prop.scopeItems.map(s => s.details).join(' ');
  check('a spec bullet reads feature then full description',
    inDetails.includes(`${withSpec.feature} - ${withSpec.description}`),
    `${withSpec.feature} - ${withSpec.description}`);
  check('and never the abbreviated Options value on its own',
    !withSpec.option || !inDetails.includes(`${withSpec.feature} - ${withSpec.option}<`),
    withSpec.option);
}

// Untick Supervisor and a material row; bullets shrink, price must not move.
const priceBefore = prop.scopeItems.filter(s => s.sourceType)[0].cost;
Takeoff.setRowOnProposal('supervisor', false);
Takeoff.setItemOnProposal(prod.groups[0].items[0].id, false);
Proposal.generateFromTakeoff(t.id);
const p2 = Store.db.proposals[Proposal.currentId()];
const s2 = p2.scopeItems.filter(s => s.sourceType)[0];
check('unticked cost row drops off the proposal',
  !/Supervisor/.test(s2.details), s2.details);
check('the price did not move when bullets were removed',
  Math.abs(s2.cost - priceBefore) < 0.01, `${s2.cost} vs ${priceBefore}`);
check('Total Linear Feet survives regardless',
  /Total Linear Feet/.test(s2.details));

// A renamed row shows under its new wording.
Takeoff.setRowOnProposal('supervisor', true);
Takeoff.setRowLabel('supervisor', 'Site supervision');
Proposal.generateFromTakeoff(t.id);
const s3 = Store.db.proposals[Proposal.currentId()].scopeItems.filter(s => s.sourceType)[0];
check('renamed row appears under its new description',
  /Site supervision/.test(s3.details) && !/>Supervisor</.test(s3.details), s3.details);

// A hidden row must vanish from the proposal as well as the cost.
prod.hiddenRows.truck = true;
Proposal.generateFromTakeoff(t.id);
const s4 = Store.db.proposals[Proposal.currentId()].scopeItems.filter(s => s.sourceType)[0];
check('a hidden row is absent from the proposal too',
  !/Truck for Transport/.test(s4.details), s4.details);
delete prod.hiddenRows.truck;

// No six-item truncation: every ticked spec must be listed.
Takeoff.setAllItemsOnProposal(true);
Takeoff.setRowLabel('supervisor', '');
Proposal.generateFromTakeoff(t.id);
const s5 = Store.db.proposals[Proposal.currentId()].scopeItems.filter(s => s.sourceType)[0];
const specCount = (() => {
  const seen = new Set();
  prod.groups.forEach(g => g.items.forEach(it => {
    const s = [it.feature, it.option].filter(Boolean).join(' - ');
    if (s) seen.add(s);
  }));
  return seen.size;
})();
const bulletCount = (s5.details.match(/<li>/g) || []).length;
check('every ticked material spec is listed (no cap at six)',
  bulletCount >= specCount, `${bulletCount} bullets for ${specCount} specs`);
Store.save();
const propTotal = prop.scopeItems.reduce((s, i) => s + U.n(i.cost), 0);
check('proposal total matches the takeoff Total Bid Cost',
  Math.abs(propTotal - roll.total) < 1, `${propTotal} vs ${roll.total}`);

console.log('\n--- miscellaneous folded into product prices ---');
check('no Miscellaneous line in the scope items',
  !prop.scopeItems.some(s => /miscellaneous/i.test(s.description)),
  prop.scopeItems.map(s => s.description).join(' | '));
check('no Miscellaneous line in the printed document',
  !/[Mm]iscellaneous/.test(U.$('proposalDoc').innerHTML));
// Named as the printed proposal names them, and the tax line carries its rate
// so the client can check the arithmetic.
check('tax is still shown as its own line, with the rate on it',
  prop.scopeItems.some(s => /^Tax( \([\d.]+%\))?$/.test(s.description)),
  prop.scopeItems.map(s => s.description).join(' | '));
check('and delivery is named the way the proposal prints it',
  prop.scopeItems.some(s => s.description === 'Delivery and Freight Charges') ||
  !roll.freight,
  prop.scopeItems.map(s => s.description).join(' | '));

check('no Roundoff line either - it is folded into the products',
  !prop.scopeItems.some(s => /roundoff/i.test(s.description)));

// Single product: the whole misc amount plus the rounding uplift lands on it.
const oneProd = prop.scopeItems.filter(s => s.sourceType);
check('single product carries the entire misc + roundoff amount',
  oneProd.length === 1 &&
  Math.abs(oneProd[0].cost - (roll.products[0].calc.total + roll.misc + roll.roundoff)) < 0.01,
  `${oneProd[0].cost} vs ${roll.products[0].calc.total + roll.misc + roll.roundoff}`);
check('proposal total lands exactly on the rounded takeoff total',
  Math.abs(prop.scopeItems.reduce((s, i) => s + U.n(i.cost), 0) - roll.total) < 0.01,
  `${prop.scopeItems.reduce((s, i) => s + U.n(i.cost), 0)} vs ${roll.total}`);
check('that total is a whole multiple of 10', Math.round(roll.total) % 10 === 0, String(roll.total));

console.log('\n--- proposal freshness ---');
check('generating stamps the proposal', !!prop.generatedAt);
check('a freshly generated proposal is not stale', Proposal.isStale(prop) === false);
// Any takeoff edit stamps it, which is what makes the amber strip possible.
Takeoff.setTotalLF(t.products[0].totalLF);
check('editing the takeoff marks the proposal stale',
  Proposal.isStale(prop) === true,
  `updated ${t.updatedAt} vs generated ${prop.generatedAt}`);
App.switchTab('proposal');
check('the stale warning is on screen',
  /takeoff has changed/i.test(U.$('section-proposal').innerHTML));
check('the warning offers a Regenerate button',
  /Regenerate/.test(U.$('section-proposal').innerHTML));
Proposal.generateFromTakeoff(t.id);
check('regenerating clears the stale state', Proposal.isStale(prop) === false);

console.log('\n--- proposal button in the Actions column ---');
App.switchTab('active');
Bids.filterTable();
{
  const withProposal = Store.db.bids.find(b => b.proposalId && Store.db.proposals[b.proposalId]);
  check('a bid with a proposal offers to open it',
    /Proposal\.open\(/.test(Bids.actionCell(withProposal)), 'no open call');
  const noTakeoff = { id: 99002, project: 'No takeoff', status: 'In Progress' };
  const cell = Bids.actionCell(noTakeoff);
  check('a bid with neither shows a disabled proposal control',
    /cursor-not-allowed/.test(cell) && !/Proposal\./.test(cell));
  check('a bid with a takeoff but no proposal offers to generate one', (() => {
    const b = Store.db.bids.find(x => x.takeoffId && !x.proposalId);
    return !b || /generateFromTakeoff/.test(Bids.actionCell(b));
  })());
}

// Several products: equal split, and the pennies must still reconcile.
['Wall Mount Handrail', 'Bollard', 'Stair'].forEach(ty => Takeoff.addProduct(ty));
Takeoff.selectProduct(t.products[0].id);
t.products.forEach((pr, i) => {
  if (i === 0) return;
  pr.totalLF = 100 * (i + 1);
  M.applyDerived(pr);
  pr.groups[0].items.push(M.newItem({ qty: 10 + i, unitCost: 33.33 }));
});
Store.save();
Proposal.generateFromTakeoff(t.id);
const multi = Store.db.proposals[Proposal.currentId()];
const roll2 = M.computeTakeoff(t);
const prodItems = multi.scopeItems.filter(s => s.sourceType);
check('one scope line per product, misc still hidden',
  prodItems.length === 4 && !multi.scopeItems.some(s => /miscellaneous/i.test(s.description)),
  String(prodItems.length));

const uplifts = prodItems.map((s, i) =>
  Math.round((s.cost - roll2.products[i].calc.total) * 100));
const foldedCents = Math.round((roll2.misc + roll2.roundoff) * 100);
check('misc + roundoff split across all four products',
  uplifts.reduce((a, b) => a + b, 0) === foldedCents,
  `${uplifts.reduce((a, b) => a + b, 0)} vs ${foldedCents}`);
check('each share is equal to within one cent',
  Math.max(...uplifts) - Math.min(...uplifts) <= 1, uplifts.join(','));
const multiTotal = multi.scopeItems.reduce((s, i) => s + U.n(i.cost), 0);
check('total still equals the takeoff Total Bid Cost',
  Math.abs(multiTotal - roll2.total) < 0.05, `${multiTotal} vs ${roll2.total}`);

// Awkward remainders: 0.01 over 4 products, and a value that never divides.
check('an amount smaller than the product count still reconciles', (function () {
  t.rollup.miscPct = 0;
  const saveFreight = t.rollup.freight;
  t.rollup.freight = 0;
  Store.save();
  Proposal.generateFromTakeoff(t.id);
  const q = Store.db.proposals[Proposal.currentId()];
  const r = M.computeTakeoff(t);
  const tot = q.scopeItems.reduce((s, i) => s + U.n(i.cost), 0);
  t.rollup.miscPct = 5;
  t.rollup.freight = saveFreight;
  Store.save();
  return Math.abs(tot - r.total) < 0.05;
})());

// With the breakdown switched off, nothing may go missing.
Proposal.generateFromTakeoff(t.id);
Proposal.set('showRollupLines', false);
Proposal.generateFromTakeoff(t.id);
const folded = Store.db.proposals[Proposal.currentId()];
const roll3 = M.computeTakeoff(t);
check('no freight/tax lines when the breakdown is off',
  !folded.scopeItems.some(s => !s.sourceType), folded.scopeItems.length + ' items');
check('folded proposal still totals the full bid',
  Math.abs(folded.scopeItems.reduce((s, i) => s + U.n(i.cost), 0) - roll3.total) < 0.05,
  `${folded.scopeItems.reduce((s, i) => s + U.n(i.cost), 0)} vs ${roll3.total}`);
Proposal.set('showRollupLines', true);
Proposal.generateFromTakeoff(t.id);

App.switchTab('proposal');
const doc = U.$('proposalDoc');
check('document rendered', doc && doc.innerHTML.length > 1000);
check('proposal date editors are MM-DD-YYYY text fields',
  U.$('pd-proposalData-submittedDate').type === 'text' &&
  U.$('pd-proposalData-submittedDate').placeholder === 'MM-DD-YYYY');
check('proposal date editor shows MM-DD-YYYY',
  /^\d{2}-\d{2}-\d{4}$/.test(U.$('pd-proposalData-submittedDate').value),
  U.$('pd-proposalData-submittedDate').value);
Proposal.setDate('proposalData.submittedDate', 'pd-proposalData-submittedDate');
check('proposal date round-trips to ISO in the record',
  /^\d{4}-\d{2}-\d{2}$/.test(Store.db.proposals[Proposal.currentId()].proposalData.submittedDate),
  Store.db.proposals[Proposal.currentId()].proposalData.submittedDate);
check('printed document shows MM-DD-YYYY',
  /SUBMITTED DATE[\s\S]{0,200}?\d{2}-\d{2}-\d{4}/.test(U.$('proposalDoc').innerHTML));
check('document shows the scope heading', /SCOPE OF WORK AND BIDDING PRICE/.test(doc.innerHTML));
check('document shows TOTAL BID PRICE', /TOTAL BID PRICE/.test(doc.innerHTML));
check('document shows the linear-feet line', /Total Linear Feet/.test(doc.innerHTML));
check('terms boilerplate present (20 clauses)',
  (prop.proposalData.terms.match(/<li>/g) || []).length === 20);

console.log('\n--- all 9 styles render ---');
let styleOK = true;
for (let i = 1; i <= 9; i++) {
  Proposal.set('selectedStyle', i);
  const h = U.$('proposalDoc').innerHTML;
  if (!h || h.length < 800 || /undefined/.test(h)) {
    styleOK = false;
    console.log('    style ' + i + ' produced ' + (h ? h.length : 0) + ' chars' +
      (/undefined/.test(h) ? ' and contains "undefined"' : ''));
  }
}
check('every style renders without "undefined" class strings', styleOK);
Proposal.set('selectedStyle', 1);

console.log('\n--- scope lock survives regeneration ---');
Proposal.setEditing('scope');
Proposal.setScope(0, 'description', 'Custom hand-written wording');
Proposal.toggleLock(0);
Proposal.generateFromTakeoff(t.id);
const after = Store.db.proposals[Proposal.currentId()].scopeItems[0];
check('locked scope item kept its wording',
  after.description === 'Custom hand-written wording', after.description);

console.log('\n--- html sanitiser ---');
check('script tags stripped from rich text',
  !/script/i.test(U.sanitizeHTML('<ul><li>ok</li></ul><script>alert(1)</script>')));
check('event handler attributes stripped',
  !/onerror/i.test(U.sanitizeHTML('<p onerror="x">hi</p>')));
check('allowed markup preserved',
  /<li>/.test(U.sanitizeHTML('<ul><li>keep me</li></ul>')));

console.log('\n--- persistence round trip (IndexedDB) ---');
check('IndexedDB is the active backend', Store.backend === 'indexeddb', Store.backend);
check('document storage reports available', Store.docs.available());
await Store.flush();
const saved = await readState();
check('state written to IndexedDB', !!saved);
check('takeoffs persisted', Object.keys(saved.takeoffs).length >= 1);
check('proposals persisted', Object.keys(saved.proposals).length >= 1);
check('learned catalog persisted', saved.catalog.length === Catalog.all().length);
check('schema version stamped', saved.schemaVersion === Store.SCHEMA_VERSION);
const migrated = Store.migrate(JSON.parse(JSON.stringify(saved)));
check('migrate is idempotent on a current file',
  migrated.bids.length === saved.bids.length && migrated.schemaVersion === Store.SCHEMA_VERSION);

console.log('\n--- legacy file migration ---');
const legacy = { bids: [{ id: 1, project: 'X', region: 'In Region', county: 'Butler County',
  railing: 'Galvanized guardrail', scopeHrs: 4.5, estHrs: 2, bidHrs: 1, status: 'Submitted' }] };
const fixed = Store.migrate(legacy);
check('legacy region/county collapsed', fixed.bids[0].region === 'Butler County');
check('legacy inRegion flag derived', fixed.bids[0].inRegion === true);
check('legacy county field removed', fixed.bids[0].county === undefined);
check('railing became a products array',
  Array.isArray(fixed.bids[0].products) &&
  fixed.bids[0].products[0] === 'Galvanized guardrail' &&
  fixed.bids[0].railing === undefined && fixed.bids[0].productType === undefined,
  JSON.stringify(fixed.bids[0].products));
check('scopeHrs renamed to assignedHrs',
  fixed.bids[0].assignedHrs === 4.5 && fixed.bids[0].scopeHrs === undefined);
check('engineer field backfilled', fixed.bids[0].engineer === '');
check('the old "Submitted" status was reworded',
  fixed.bids[0].status === 'Submitted to review', fixed.bids[0].status);
check('a bid that predates promotion is treated as already active',
  fixed.bids[0].active === true);
check('and gains an empty proposal number', fixed.bids[0].proposalNo === '');
check('bidHrs preserved on historical records', fixed.bids[0].bidHrs === 1);
check('product type list seeded on migration',
  JSON.stringify(fixed.productTypes) ===
  JSON.stringify(['Railing', 'Metal Platform', 'Bollard', 'Metal Stairs']),
  JSON.stringify(fixed.productTypes));
check('migration is idempotent', (function () {
  const twice = Store.migrate(Store.migrate(JSON.parse(JSON.stringify(legacy))));
  return twice.bids[0].products.length === 1 &&
    twice.bids[0].products[0] === 'Galvanized guardrail' && twice.bids[0].assignedHrs === 4.5;
})());
check('a bid with no product migrates to an empty array', (function () {
  const m = Store.migrate({ bids: [{ id: 2, project: 'No product' }] });
  return Array.isArray(m.bids[0].products) && m.bids[0].products.length === 0;
})());

console.log('\n--- add/edit bid form ---');
check('Total LF field removed from the form', U.$('mLF') === null);
check('Bid Doc Hrs field removed from the form', U.$('mBidHrs') === null);
check('Product control replaces the Railing Type text box',
  !!U.$('mProductAdd') && !!U.$('mProductChips') &&
  U.$('mRailing') === null && U.$('mProductType') === null);
check('Assigned Hrs replaces Scope Prep Hrs', !!U.$('mAssignedHrs') && U.$('mScopeHrs') === null);
check('Engineer field present', !!U.$('mEngineer'));

console.log('\n--- MM-DD-YYYY dates ---');
check('display format is MM-DD-YYYY', U.date('2026-08-24') === '08-24-2026', U.date('2026-08-24'));
check('single-digit month and day are padded',
  U.date('2026-01-05') === '01-05-2026', U.date('2026-01-05'));
check('empty date shows a dash', U.date('') === '-' && U.date(null) === '-');
// new Date('2026-08-24') is UTC midnight, which renders as the 23rd anywhere
// west of Greenwich. parseDate must not do that.
check('no timezone off-by-one on ISO dates',
  U.date('2026-01-01') === '01-01-2026', U.date('2026-01-01'));
check('today() is local, not UTC-shifted', (function () {
  const n = new Date();
  const want = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') +
    '-' + String(n.getDate()).padStart(2, '0');
  return U.today() === want;
})(), U.today());

check('MM-DD-YYYY parses back to ISO', U.inputToDate('08-24-2026') === '2026-08-24');
check('slashes accepted too', U.inputToDate('8/24/2026') === '2026-08-24');
check('empty input yields empty string', U.inputToDate('  ') === '');
check('impossible month rejected', U.inputToDate('13-01-2026') === null);
check('impossible day rejected', U.inputToDate('02-30-2026') === null);
check('day 31 in a 30-day month rejected', U.inputToDate('04-31-2026') === null);
check('leap day accepted in a leap year', U.inputToDate('02-29-2028') === '2028-02-29');
check('leap day rejected in a common year', U.inputToDate('02-29-2027') === null);
check('garbage rejected', U.inputToDate('not a date') === null);
check('round trip is stable', U.inputToDate(U.dateToInput('2026-12-31')) === '2026-12-31');

console.log('\n--- due date field ---');
check('Due Date is a text field, not a native date input',
  U.$('mDueDate').type === 'text', U.$('mDueDate').type);
check('Due Date placeholder states the format',
  U.$('mDueDate').placeholder === 'MM-DD-YYYY');
check('calendar picker companion exists', !!U.$('mDueDate__picker'));

Bids.edit(Store.db.bids.filter(b => b.dueDate)[0].id);
check('editing shows the due date as MM-DD-YYYY',
  /^\d{2}-\d{2}-\d{4}$/.test(U.$('mDueDate').value), U.$('mDueDate').value);
Bids.closeModal();

check('table renders due dates as MM-DD-YYYY',
  /\d{2}-\d{2}-\d{4}/.test(gridHTML()));

console.log('\n--- product multi-select ---');
Bids.openAdd();
const psel = U.$('mProductAdd');
const addProduct = v => { psel.value = v; Bids.onProductChange(psel); };
check('add-dropdown present', !!psel && psel.tagName === 'SELECT');
check('chip container present', !!U.$('mProductChips'));
const opts = [...psel.options].map(o => o.value);
check('offers the four product types',
  ['Railing', 'Metal Platform', 'Bollard', 'Metal Stairs'].every(p => opts.includes(p)),
  opts.join(','));
check('offers "+ Add new product..."', opts[opts.length - 1] === '__add');
check('starts with nothing selected', Bids.selectedProducts().length === 0);
check('empty state message shown', /No products selected/.test(U.$('mProductChips').innerHTML));

addProduct('Railing');
addProduct('Bollard');
check('two products selected',
  JSON.stringify(Bids.selectedProducts()) === JSON.stringify(['Railing', 'Bollard']),
  JSON.stringify(Bids.selectedProducts()));
check('both render as chips',
  /Railing/.test(U.$('mProductChips').innerHTML) && /Bollard/.test(U.$('mProductChips').innerHTML));
check('dropdown resets to the prompt after adding', psel.value === '');
check('already-selected products drop out of the dropdown',
  ![...psel.options].map(o => o.value).includes('Railing'));

addProduct('Railing');   // not offered any more, but guard the path anyway
check('adding a duplicate is a no-op', Bids.selectedProducts().length === 2);

Bids.removeProduct(0);
check('removing a chip drops it',
  JSON.stringify(Bids.selectedProducts()) === JSON.stringify(['Bollard']));
check('removed product returns to the dropdown',
  [...psel.options].map(o => o.value).includes('Railing'));

// Adding a brand-new type via the sentinel selects it too.
win.prompt = () => 'Cable Railing';
addProduct('__add');
check('new product added to the master list', Store.db.productTypes.includes('Cable Railing'));
check('new product auto-selected', Bids.selectedProducts().includes('Cable Railing'));

const countBefore = Store.db.productTypes.length;
win.prompt = () => 'metal stairs';
addProduct('__add');
check('case-insensitive duplicate not added to the list',
  Store.db.productTypes.length === countBefore, Store.db.productTypes.join(','));
check('existing match is selected instead',
  Bids.selectedProducts().includes('Metal Stairs'), JSON.stringify(Bids.selectedProducts()));

win.prompt = () => null;
const selBefore = JSON.stringify(Bids.selectedProducts());
addProduct('__add');
check('cancelling "add new" changes nothing',
  JSON.stringify(Bids.selectedProducts()) === selBefore);
check('sentinel never sticks in the dropdown', psel.value === '');
win.prompt = () => 'x';

Bids.openAdd();
check('opening the form clears the previous selection', Bids.selectedProducts().length === 0);
U.$('mProject').value = 'Engineer Column Test';
U.$('mPortal').value = 'PlanHub';
U.$('mRegion').value = Store.db.regions[0];
addProduct('Railing');
addProduct('Metal Stairs');
U.$('mEngineer').value = 'AF';
U.$('mAssignedHrs').value = '6';
U.$('mEstHrs').value = '4';
U.$('mStatus').value = 'In Progress';
U.$('mDueDate').value = '09-15-2026';
Bids.save({ preventDefault() {} });
const created = Store.db.bids.filter(b => b.project === 'Engineer Column Test')[0];
check('new bid saved with engineer initials', created && created.engineer === 'AF');
// Add Bid is intake, not a decision to work the bid: it lands in All Bids and
// reaches Active Bids only when somebody picks it up.
check('a newly entered bid starts as intake, not active', created.active === false);
Bids.addToActive(created.id);
check('and promotion puts it on Active Bids', created.active === true);
check('new bid saved with both products',
  JSON.stringify(created.products) === JSON.stringify(['Railing', 'Metal Stairs']),
  JSON.stringify(created.products));
check('both products render in the Active Bids row',
  /Railing/.test(gridHTML()) && /Metal Stairs/.test(gridHTML()));
check('new bid saved with assignedHrs', created.assignedHrs === 6);
// Estm and Asgn measure the same work two ways, so nothing adds them any more.
check('no combined hours figure is invented', created.totalHrs === undefined,
  String(created.totalHrs));
check('lf defaults to null (now takeoff-driven)', created.lf === null);
check('typed MM-DD-YYYY stored as ISO', created.dueDate === '2026-09-15', created.dueDate);
check('month derived from the due date (September = 8)', created.month === 8, String(created.month));

// A date that cannot exist must block the save rather than silently storing ''.
Bids.edit(created.id);
U.$('mDueDate').value = '02-30-2026';
Bids.save({ preventDefault() {} });
check('invalid date blocks the save', created.dueDate === '2026-09-15', created.dueDate);
check('invalid date field is flagged',
  /border-red-400/.test(U.$('mDueDate').className), U.$('mDueDate').className);
U.$('mDueDate').value = '09-15-2026';
Bids.save({ preventDefault() {} });
check('correcting the date lets the save through', created.dueDate === '2026-09-15');

// Clearing the field is legitimate and must not be treated as invalid.
Bids.edit(created.id);
U.$('mDueDate').value = '';
Bids.save({ preventDefault() {} });
check('an empty due date saves as empty', created.dueDate === '', JSON.stringify(created.dueDate));
Bids.edit(created.id);
U.$('mDueDate').value = '09-15-2026';
Bids.save({ preventDefault() {} });
// The intake engineer is an All Bids column now; Active Bids shows the team.
Bids.setView('all');
check('engineer initials appear in the All Bids table',
  />AF</.test(gridHTML()));
Bids.setView('active');
const headLabels = () => [...gridHeadCells()].map(th => th.textContent.trim());
check('engineer column header present', headLabels().includes('Engineer'), headLabels().join('|'));
check('Product column header replaces Railing Type',
  headLabels().includes('Product') && !headLabels().some(l => /Railing Type/.test(l)),
  headLabels().join('|'));
check('header column count matches body cell count', (function () {
  const heads = gridHeadCells().length;
  const cells = gridRows()[0].querySelectorAll('td').length;
  return heads === cells;
})(), 'header vs body cells');

U.$('searchActive').value = 'af';
Bids.filterTable();
check('search matches on engineer initials',
  /Engineer Column Test/.test(gridHTML()));
U.$('searchActive').value = '';
Bids.filterTable();

Bids.edit(created.id);
check('edit form reloads engineer', U.$('mEngineer').value === 'AF');
check('edit form reloads assigned hrs', U.$('mAssignedHrs').value === '6');
check('edit form reloads both products',
  JSON.stringify(Bids.selectedProducts()) === JSON.stringify(['Railing', 'Metal Stairs']),
  JSON.stringify(Bids.selectedProducts()));
Bids.closeModal();

console.log('\n--- engineers register ---');
check('typing unknown initials offers to add them', (function () {
  Bids.openAdd();
  U.$('mEngineer').value = 'ZZ';
  Bids.onEngineerChange(U.$('mEngineer'));
  return /Add "ZZ" to engineers/.test(U.$('engineerHint').innerHTML);
})(), U.$('engineerHint').innerHTML);

Bids.addEngineerFromForm();
check('added to the register', !!Store.db.engineers.filter(e => e.initials === 'ZZ')[0]);
check('now offered in the datalist', /value="ZZ"/.test(U.$('engineerOptions').innerHTML));

const zz = Store.db.engineers.filter(e => e.initials === 'ZZ')[0];
Bids.updateEngineer(zz.id, 'name', 'Zoe Zhang');
check('full name stored', Store.db.engineers.filter(e => e.id === zz.id)[0].name === 'Zoe Zhang');
U.$('mEngineer').value = 'zz';
Bids.onEngineerChange(U.$('mEngineer'));
check('known initials normalise their casing', U.$('mEngineer').value === 'ZZ');
check('known initials show the full name', /Zoe Zhang/.test(U.$('engineerHint').innerHTML));

// The register lives on the Settings page now, not in a modal.
Bids.closeModal();
App.switchTab('engineers');
check('engineers panel renders on the Settings page',
  !!U.$('engineerList') && /ZZ/.test(U.$('engineerList').innerHTML));
check('duplicate initials are rejected', (function () {
  const before = Store.db.engineers.length;
  U.$('newEngineerInitials').value = 'zz';
  Bids.addEngineerFromModal();
  return Store.db.engineers.length === before;
})(), String(Store.db.engineers.length));
App.switchTab('active');

// Renaming initials must follow the bids, or they lose their engineer.
Bids.edit(created.id);
U.$('mEngineer').value = 'ZZ';
Bids.save({ preventDefault() {} });
check('bid assigned to ZZ', created.engineer === 'ZZ');
Bids.updateEngineer(zz.id, 'initials', 'ZQ');
check('renaming initials carries onto the bids', created.engineer === 'ZQ', created.engineer);
Bids.setView('all');
check('table shows the new initials', />ZQ</.test(gridHTML()));
Bids.setView('active');

Bids.removeEngineer(zz.id);
check('removing from the register leaves the bid initials intact',
  created.engineer === 'ZQ' && !Store.db.engineers.some(e => e.id === zz.id));
Bids.edit(created.id);
U.$('mEngineer').value = 'AF';
Bids.save({ preventDefault() {} });

console.log('\n--- legacy free-text products survive the multi-select ---');
// Seeded bids carry long free-text descriptions that predate the managed list.
const legacyProd = Store.db.bids.filter(b =>
  b.products.length && !Store.db.productTypes.includes(b.products[0]))[0];
const legacyValue = legacyProd.products[0];
Bids.edit(legacyProd.id);
check('legacy value loads as a selected chip',
  Bids.selectedProducts()[0] === legacyValue, JSON.stringify(Bids.selectedProducts()));
check('legacy chip is styled as a one-off',
  /amber/.test(U.$('mProductChips').innerHTML));
check('legacy value did not pollute the shared list',
  !Store.db.productTypes.includes(legacyValue));
Bids.save({ preventDefault() {} });
check('saving an untouched legacy bid preserves its product',
  legacyProd.products[0] === legacyValue, JSON.stringify(legacyProd.products));

// A legacy bid can gain a managed product alongside its old free-text one.
Bids.edit(legacyProd.id);
addProduct('Bollard');
Bids.save({ preventDefault() {} });
check('legacy and managed products coexist on one bid',
  legacyProd.products.length === 2 && legacyProd.products.includes('Bollard') &&
  legacyProd.products.includes(legacyValue), JSON.stringify(legacyProd.products));

// The "+ Add new" sentinel must never reach a saved record.
Bids.edit(created.id);
check('no product record ever contains the sentinel',
  !Store.db.bids.some(b => (b.products || []).includes('__add')));

// A legacy bid carries totalHrs and bidHrs from an older build. Editing it must
// leave both alone rather than recomputing a figure nothing shows any more.
const legacyBid = Store.db.bids.filter(b => U.n(b.bidHrs) > 0)[0];
const legacyTotal = legacyBid.totalHrs;
const legacyBidHrs = U.n(legacyBid.bidHrs);
Bids.edit(legacyBid.id);
U.$('mAssignedHrs').value = '10';
U.$('mEstHrs').value = '5';
Bids.save({ preventDefault() {} });
check('editing a legacy bid stores the two figures it was given',
  legacyBid.assignedHrs === 10 && legacyBid.estHrs === 5,
  `${legacyBid.assignedHrs} / ${legacyBid.estHrs}`);
check('and leaves its historical totalHrs untouched rather than recomputing it',
  legacyBid.totalHrs === legacyTotal && U.n(legacyBid.bidHrs) === legacyBidHrs,
  `${legacyBid.totalHrs} vs ${legacyTotal}`);

console.log('\n--- bids grid: sort, filter, columns ---');
App.switchTab('active');
Bids.refresh();
const BG = win.BidGrid;
const colIndex = key => BG.activeColumns().findIndex(c => c.key === key);
const cellText = (row, key) => row.querySelectorAll('td')[colIndex(key)].textContent.trim();

check('grid renders a header per visible column',
  gridHeadCells().length === BG.activeColumns().length,
  `${gridHeadCells().length} vs ${BG.activeColumns().length}`);
check('header and body cell counts match',
  gridRows()[0].querySelectorAll('td').length === gridHeadCells().length);

// Sorting cycles asc -> desc -> none, and must be type-aware.
BG.toggleSort('price');
let prices = gridRows().map(r => U.n(cellText(r, 'price').replace(/[^0-9.]/g, '')))
  .filter(v => v > 0);
check('ascending numeric sort orders prices',
  prices.every((v, i) => i === 0 || prices[i - 1] <= v), prices.slice(0, 5).join(','));
BG.toggleSort('price');
prices = gridRows().map(r => U.n(cellText(r, 'price').replace(/[^0-9.]/g, ''))).filter(v => v > 0);
check('descending numeric sort reverses them',
  prices.every((v, i) => i === 0 || prices[i - 1] >= v), prices.slice(0, 5).join(','));
BG.toggleSort('price');
check('a third click clears the sort', BG.cfg().sort === null);

// Dates must sort chronologically, not as the MM-DD-YYYY text they display.
BG.toggleSort('dueDate');
const dates = gridRows().map(r => cellText(r, 'dueDate')).filter(d => /\d{2}-\d{2}-\d{4}/.test(d));
const iso = d => d.slice(6) + d.slice(0, 2) + d.slice(3, 5);
check('dates sort chronologically, not lexically',
  dates.every((d, i) => i === 0 || iso(dates[i - 1]) <= iso(d)), dates.slice(0, 4).join(' '));
BG.toggleSort('dueDate'); BG.toggleSort('dueDate');

// Filters: enum values, contains, and two combining with AND.
const totalRows = gridRows().length;
BG.cfg().filters = { portal: { values: ['PlanHub'] } };
Bids.filterTable();
check('enum filter narrows to the chosen value',
  gridRows().length < totalRows && gridRows().every(r => cellText(r, 'portal') === 'PlanHub'),
  `${gridRows().length} of ${totalRows}`);
const planhubOnly = gridRows().length;

BG.cfg().filters.status = { values: ['Submitted to review'] };
Bids.filterTable();
check('two filters combine with AND',
  gridRows().length > 0 && gridRows().length <= planhubOnly &&
  gridRows().every(r => cellText(r, 'portal') === 'PlanHub' && /SUBMITTED/i.test(cellText(r, 'status'))),
  `${gridRows().length} of ${planhubOnly}`);
check('active filter count reported', BG.filterCount() === 2, String(BG.filterCount()));

BG.clearFilter('status');
check('clearing one filter leaves the other', BG.filterCount() === 1 && gridRows().length === planhubOnly);
BG.clearFilters();
check('clear all restores every row', gridRows().length === totalRows);

BG.cfg().filters = { project: { contains: 'walmart' } };
Bids.filterTable();
check('contains filter matches on text',
  gridRows().length > 0 && gridRows().every(r => /walmart/i.test(cellText(r, 'project'))),
  String(gridRows().length));
BG.clearFilters();

// Filtering to nothing must show the placeholder, not a broken table.
BG.cfg().filters = { project: { contains: 'zzzz-no-such-project' } };
Bids.filterTable();
check('no matches shows the empty placeholder', gridRows().length === 0 &&
  /No bids match/.test(gridEl().tBodies[0].innerHTML));
BG.clearFilters();

// Column selector. Hiding a column must keep header and body in step - a
// mismatch here was a real bug in an earlier round.
const beforeCols = gridHeadCells().length;
BG.toggleColumn('material');
check('hiding a column removes its header', gridHeadCells().length === beforeCols - 1);
check('header and body still match after hiding',
  gridRows()[0].querySelectorAll('td').length === gridHeadCells().length);
check('the hidden column is gone from the body', colIndex('material') === -1);
BG.toggleColumn('material');
check('showing it again restores both', gridHeadCells().length === beforeCols &&
  gridRows()[0].querySelectorAll('td').length === beforeCols);

BG.toggleColumn('project');
check('the locked Project column cannot be hidden', colIndex('project') >= 0);

const order0 = BG.cfg().order.slice();
BG.moveColumn(BG.cfg().order[2], -1);
check('a column can be reordered',
  BG.cfg().order[1] === order0[2] && BG.cfg().order[2] === order0[1],
  BG.cfg().order.slice(0, 4).join(','));
check('reordering is reflected in the header',
  [...gridHeadCells()].map(th => th.textContent.trim())[1] ===
  BG.activeColumns()[1].label);

// Layout must survive a reload.
await Store.flush();
const persisted = await readState();
const view0 = Bids.currentView();
check('grid layout persisted, per view',
  !!persisted.ui.grids && !!persisted.ui.grids[view0] &&
  JSON.stringify(persisted.ui.grids[view0].order) === JSON.stringify(BG.cfg().order),
  JSON.stringify(persisted.ui.grids && Object.keys(persisted.ui.grids)));

BG.resetColumns();
check('reset restores the default column order',
  JSON.stringify(BG.cfg().order) === JSON.stringify(order0), BG.cfg().order.join(','));
Bids.filterTable();

console.log('\n--- hours split into two columns ---');
// The intake pair lives on All Bids; Active Bids shows the team's, summed from
// the assignments. Same two headings either way, different numbers underneath.
Bids.setView('all');
const hrsBid = Store.db.bids[0];
hrsBid.estHrs = 10; hrsBid.assignedHrs = 4; hrsBid.totalHrs = 14;
Bids.filterTable();
const hdr = [...gridHeadCells()].map(th => th.textContent.trim());
check('Est Hrs and Assigned Hrs are separate columns',
  hdr.some(h => /Estm Hrs/.test(h)) && hdr.some(h => /Asgn Hrs/.test(h)), hdr.join('|'));
check('the combined Hrs column is not shown by default',
  !hdr.some(h => /^Total Hrs/.test(h)), hdr.join('|'));
const hrsRow = () => [...gridRows()].find(r => /Murray|Christ|CVS|Washington/.test(r.textContent))
  || gridRows()[0];
check('the two columns render their own values, not the sum', (() => {
  const iE = hdr.findIndex(h => /Estm Hrs/.test(h));
  const iA = hdr.findIndex(h => /Asgn Hrs/.test(h));
  const row = [...gridRows()].find(r => r.textContent.includes(hrsBid.project));
  const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
  return cells[iE] === '10' && cells[iA] === '4';
})());
check('there is no combined Hrs column to choose at all',
  !BidGrid.COLUMNS.some(c => c.key === 'totalHrs' || c.key === 'activeTotalHrs'),
  BidGrid.COLUMNS.map(c => c.key).join(','));
check('the intake and team hours are different columns',
  BidGrid.COLUMNS.some(c => c.key === 'estHrs') &&
  BidGrid.COLUMNS.some(c => c.key === 'activeEstHrs'));
check('and the column selector tells them apart',
  BidGrid.COLUMNS.filter(c => /Estm Hrs/.test(c.label))
    .every(c => c.panelLabel && c.panelLabel !== c.label));
Bids.setView('active');

console.log('\n--- the three bid views ---');
const counts = {};
['all', 'active', 'awarded'].forEach(v => { Bids.setView(v); counts[v] = Bids.baseList().length; });
check('All Bids is the widest view',
  counts.all >= counts.active && counts.all >= counts.awarded,
  JSON.stringify(counts));
check('Active excludes decided bids',
  Bids.baseList !== null && (Bids.setView('active'), Bids.baseList()
    .every(b => b.status !== 'Awarded' && b.status !== 'Lost')));
Bids.setView('awarded');
check('Awarded shows only decided bids',
  Bids.baseList().every(b => b.status === 'Awarded' || b.status === 'Lost'));
check('Awarded shows the Result column by default',
  BidGrid.activeColumns().some(c => c.key === 'result'));
Bids.setView('active');
check('Active does not show the Result column',
  !BidGrid.activeColumns().some(c => c.key === 'result'));

// Layouts are per view: hiding a column on one must not take it off another.
Bids.setView('awarded');
BidGrid.toggleColumn('portal');
const goneOnAwarded = !BidGrid.activeColumns().some(c => c.key === 'portal');
Bids.setView('active');
check('a column hidden on Awarded is still visible on Active',
  goneOnAwarded && BidGrid.activeColumns().some(c => c.key === 'portal'));
Bids.setView('awarded'); BidGrid.toggleColumn('portal'); Bids.setView('active');

console.log('\n--- grid layout migration (v6 -> v8) ---');
{
  // BidGrid.cfg() heals an unknown layout by APPENDING missing keys, so without
  // the migration the two new columns would land past Actions for anyone who
  // had ever touched the column selector.
  const legacy = {
    schemaVersion: 6, bids: [], takeoffs: {}, proposals: {},
    ui: { bidsGrid: { order: ['sr', 'project', 'totalHrs', 'status', 'actions'],
                      visible: ['sr', 'project', 'totalHrs', 'status', 'actions'],
                      sort: { key: 'project', dir: 'asc' }, filters: { portal: { values: ['PlanHub'] } } } }
  };
  const out = Store.migrate(JSON.parse(JSON.stringify(legacy)));
  const g = out.ui.grids.active;
  check('the two new columns take the old Hrs position, not the end',
    g.order.indexOf('estHrs') === 4 && g.order.indexOf('assignedHrs') === 6,
    g.order.join(','));
  // v10: each team column lands directly behind the intake one it mirrors.
  check('the team hours sit beside their intake twins',
    g.order.indexOf('activeEstHrs') === g.order.indexOf('estHrs') + 1 &&
    g.order.indexOf('activeAsgnHrs') === g.order.indexOf('assignedHrs') + 1,
    g.order.join(','));
  check('Active shows the team hours and not the intake pair',
    g.visible.indexOf('activeEstHrs') >= 0 && g.visible.indexOf('estHrs') < 0,
    g.visible.join(','));
  check('All Bids shows the intake pair and not the team',
    out.ui.grids.all.visible.indexOf('estHrs') >= 0 &&
    out.ui.grids.all.visible.indexOf('activeEstHrs') < 0,
    out.ui.grids.all.visible.join(','));
  // v11: the ordinal is a Sr. No. counted at render time, and the typed
  // Project No. is gone - Proposal No. carries the identity now.
  check('Sr. No. takes the ordinal position, not the end',
    g.order.indexOf('sr') === 0 && g.order.indexOf('projectNo') < 0, g.order.join(','));
  check('Proposal No. sits beside it',
    g.order.indexOf('proposalNo') === 1, g.order.join(','));
  check('and is shown on Active',
    g.visible.indexOf('proposalNo') >= 0, g.visible.join(','));
  check('Job No. is offered but off on Active',
    g.order.indexOf('awardNo') === 2 && g.visible.indexOf('awardNo') < 0, g.visible.join(','));
  check('Awarded shows the Job No.',
    out.ui.grids.awarded.visible.indexOf('awardNo') >= 0,
    out.ui.grids.awarded.visible.join(','));
  // Every view is numbered, because Sr. No. is only the row's position.
  check('Sr. No. is on all three views',
    ['all', 'active', 'awarded'].every(v => out.ui.grids[v].visible.indexOf('sr') >= 0),
    ['all', 'active', 'awarded'].map(v => v + ':' + out.ui.grids[v].visible.join('/')).join(' '));
  check('All Bids carries no job number',
    out.ui.grids.all.visible.indexOf('awardNo') < 0,
    out.ui.grids.all.visible.join(','));
  // The layout chain has to take it back out again: BidGrid.cfg() would
  // otherwise ask for a column definition that no longer exists.
  check('Total Hrs is stripped from the migrated layout entirely',
    g.order.indexOf('totalHrs') < 0 && g.visible.indexOf('totalHrs') < 0,
    g.order.join(','));
  check('the old single layout is gone', out.ui.bidsGrid === undefined);
  check('all three views exist after migration',
    !!out.ui.grids.all && !!out.ui.grids.active && !!out.ui.grids.awarded);
  check('the saved sort and filters land on Active only',
    out.ui.grids.active.sort.key === 'project' && out.ui.grids.all.sort === null &&
    Object.keys(out.ui.grids.awarded.filters).length === 0);
}

console.log('\n--- the layout chain reaches a layout that never saw the database ---');
{
  /* Since accounts arrived a signed-in person's layout lives in the server's
     user_prefs table and is attached to db.ui after Store.migrate has finished.
     A migration gated on schemaVersion therefore never sees it - which is why
     the layout steps have their own version and their own entry point. */
  const fromServer = {
    grids: {
      active: {
        order: ['sr', 'project', 'activeEstHrs', 'activeTotalHrs', 'status', 'actions'],
        visible: ['sr', 'project', 'activeTotalHrs', 'status', 'actions'],
        sort: { key: 'activeTotalHrs', dir: 'desc' },
        filters: { activeTotalHrs: { values: ['4'] }, portal: { values: ['PlanHub'] } }
      }
    }
  };
  const healed = Store.migrateUI(JSON.parse(JSON.stringify(fromServer)));
  const g = healed.grids.active;
  check('a prefs layout with no version is brought up to date',
    healed.version === Store.UI_VERSION, String(healed.version));
  check('the dead column is gone from the order and the visible list',
    g.order.indexOf('activeTotalHrs') < 0 && g.visible.indexOf('activeTotalHrs') < 0,
    g.order.join(','));
  // A sort on a column with no definition would reorder the table by nothing;
  // a filter on one would narrow it to nothing.
  check('a sort on it is cleared rather than left dangling', g.sort === null,
    JSON.stringify(g.sort));
  check('and so is a filter', g.filters.activeTotalHrs === undefined,
    JSON.stringify(g.filters));
  check('a filter on a column that still exists is left alone',
    !!g.filters.portal, JSON.stringify(g.filters));
  check('columns that still exist are untouched',
    g.order.indexOf('activeEstHrs') >= 0 && g.visible.indexOf('sr') === 0,
    g.order.join(','));

  const twice = Store.migrateUI(Store.migrateUI({ grids: {} }));
  check('running the chain twice changes nothing the second time',
    twice.version === Store.UI_VERSION);
  check('a fresh layout is stamped with the current version',
    Store.migrate({ schemaVersion: Store.SCHEMA_VERSION, bids: [] }).ui.version === Store.UI_VERSION);
}

console.log('\n--- project numbers and the awarded job number ---');
{
  Bids.setView('active');
  const a = Store.db.bids.filter(b => b.status !== 'Awarded' && b.status !== 'Lost')[0];
  const b2 = Store.db.bids.filter(x =>
    x.id !== a.id && x.status !== 'Awarded' && x.status !== 'Lost')[0];

  // The typed Project No. is gone from the record entirely.
  check('no bid carries a projectNo any more',
    Store.db.bids.every(x => x.projectNo === undefined),
    JSON.stringify(Store.db.bids.filter(x => x.projectNo !== undefined).slice(0, 2)));
  check('and no Job No. until they are awarded',
    Store.db.bids.filter(x => x.status !== 'Awarded').every(x => !x.awardNo));

  // Clear any award numbers the seed may carry so the sequence starts clean.
  Store.db.bids.forEach(x => { x.awardNo = null; x.awardedAt = null; });

  const first = Bids.applyAward(a, '2026-03-04');
  check('the first award of the year is 0001', first === 'DIS-26-0001', first);
  check('it also sets the status and the award date',
    a.status === 'Awarded' && a.awardedAt === '2026-03-04');
  const second = Bids.applyAward(b2, '2026-11-30');
  check('the next award increments', second === 'DIS-26-0002', second);

  // A number that has been on paper must never move or be handed out twice.
  check('re-awarding keeps the original number',
    Bids.applyAward(a) === 'DIS-26-0001', a.awardNo);
  a.status = 'Submitted';
  check('moving out of Awarded does not clear the number', a.awardNo === 'DIS-26-0001');
  check('and re-awarding still does not renumber it',
    Bids.applyAward(a) === 'DIS-26-0001', a.awardNo);

  check('the sequence restarts each year',
    Bids.nextAwardNo('2027-01-05') === 'DIS-27-0001', Bids.nextAwardNo('2027-01-05'));
  // Deleting the highest-numbered job must not free its number for reuse.
  const held = b2.awardNo;
  b2.awardNo = null; b2.status = 'Submitted';
  check('a gap left by a deleted job is not refilled',
    Bids.nextAwardNo('2026-06-01') === 'DIS-26-0002', Bids.nextAwardNo('2026-06-01'));
  b2.awardNo = held; b2.status = 'Awarded';

  // Awarded and Lost are outcomes of the decision, not values you can type.
  const viaForm = Store.db.bids.filter(x =>
    Bids.bucketOf(x) === 'open' && !x.awardNo)[0];
  Bids.edit(viaForm.id);
  const offered = [...U.$('mStatus').options].map(o => o.value);
  check('the form does not offer Awarded or Lost',
    !offered.includes('Awarded') && !offered.includes('Lost'), offered.join('|'));
  check('but it does offer the new statuses',
    offered.includes('Submitted to review') && offered.includes('No Scope'), offered.join('|'));
  U.$('mProposalNo').value = 'PROP-9001';
  Bids.save({ preventDefault() {} });
  check('the typed proposal number is kept',
    viaForm.proposalNo === 'PROP-9001', viaForm.proposalNo);

  // An awarded bid must keep its status through an edit, or opening one and
  // pressing Save would silently demote it.
  const decided = Store.db.bids.filter(x => x.status === 'Awarded')[0];
  Bids.edit(decided.id);
  check('editing an awarded bid keeps Awarded selected',
    U.$('mStatus').value === 'Awarded', U.$('mStatus').value);
  Bids.save({ preventDefault() {} });
  check('and saving does not demote it', decided.status === 'Awarded', decided.status);

  // The confirmation names the number before it is issued.
  const target = Store.db.bids.filter(x => Bids.bucketOf(x) === 'open')[0];
  const expected = Bids.nextAwardNo();
  Bids.promptDecision(target.id, 'Awarded');
  check('the confirmation is shown rather than awarding straight away',
    !U.$('decisionModal').classList.contains('hidden') && target.status !== 'Awarded');
  check('and it names the number about to be issued',
    U.$('decisionNumber').textContent === expected, U.$('decisionNumber').textContent);
  Bids.closeDecisionModal();
  check('cancelling leaves the bid alone',
    target.status !== 'Awarded' && !target.awardNo);
  Bids.promptDecision(target.id, 'Awarded');
  Bids.confirmDecision();
  check('confirming awards it', target.status === 'Awarded' && !!target.awardNo);

  Bids.setView('active');
  check('an awarded bid drops off Active Bids',
    !Bids.baseList().some(x => x.id === target.id));
  Bids.setView('awarded');
  check('and appears on Awarded Bids with its number',
    Bids.baseList().some(x => x.id === target.id) &&
    new RegExp(target.awardNo).test(gridHTML()));
  check('Awarded leads with Sr. No. then Job No.',
    BidGrid.activeColumns()[0].key === 'sr' &&
    BidGrid.activeColumns()[1].key === 'awardNo',
    BidGrid.activeColumns().map(c => c.key).join(','));
  Bids.setView('active');
  check('Active leads with Sr. No. then Proposal No., no Job No.',
    BidGrid.activeColumns()[0].key === 'sr' &&
    BidGrid.activeColumns()[1].key === 'proposalNo' &&
    !BidGrid.activeColumns().some(c => c.key === 'awardNo'),
    BidGrid.activeColumns().map(c => c.key).join(','));
}

console.log('\n--- Sr. No. is a row counter; Proposal No. is the identity ---');
{
  Bids.setView('active');
  Bids.filterTable();
  const srIndex = BidGrid.activeColumns().findIndex(c => c.key === 'sr');
  const srCells = [...gridRows()].map(r => r.querySelectorAll('td')[srIndex].textContent.trim());
  check('Sr. No. runs 1..N with no gaps',
    srCells.every((v, i) => Number(v) === i + 1), srCells.slice(0, 6).join(','));

  // A stored ordinal went out of sequence every time a bid was deleted. A
  // counter cannot: it is the position, so it renumbers itself.
  const before = srCells.length;
  const doomed = Bids.baseList()[1];
  Bids.promptDelete(doomed.id);
  Bids.confirmDelete();
  Bids.setView('active');
  Bids.filterTable();
  const after = [...gridRows()].map(r => r.querySelectorAll('td')[srIndex].textContent.trim());
  check('and closes up after a deletion',
    after.length === before - 1 && after.every((v, i) => Number(v) === i + 1),
    after.slice(0, 6).join(','));

  // Sorting is what the counter counts, so it never carries a stale number.
  BidGrid.toggleSort('price');
  const sorted = [...gridRows()].map(r => r.querySelectorAll('td')[srIndex].textContent.trim());
  check('it follows the sort rather than travelling with the row',
    sorted.every((v, i) => Number(v) === i + 1), sorted.slice(0, 6).join(','));
  BidGrid.toggleSort('price'); BidGrid.toggleSort('price');

  // Proposal No. is the number that identifies a project, so it cannot repeat.
  const one = Bids.baseList()[0], two = Bids.baseList()[1];
  Bids.edit(one.id);
  U.$('mProposalNo').value = 'DIS-P-UNIQ';
  Bids.save({ preventDefault() {} });
  check('a proposal number saves', one.proposalNo === 'DIS-P-UNIQ');

  Bids.edit(two.id);
  U.$('mProposalNo').value = '  dis-p-uniq ';        // same number, sloppier
  Bids.save({ preventDefault() {} });
  check('a duplicate is refused regardless of case or spacing',
    two.proposalNo !== 'dis-p-uniq' && two.proposalNo !== '  dis-p-uniq ',
    String(two.proposalNo));
  check('and the form stays open on the offending field',
    !U.$('bidModal').classList.contains('hidden') &&
    U.$('mProposalNo').classList.contains('border-red-400'));

  U.$('mProposalNo').value = 'DIS-P-OTHER';
  Bids.save({ preventDefault() {} });
  check('a different number saves', two.proposalNo === 'DIS-P-OTHER');

  // Re-saving a bid must not collide with itself.
  Bids.edit(one.id);
  Bids.save({ preventDefault() {} });
  check('re-saving a bid keeps its own number', one.proposalNo === 'DIS-P-UNIQ');

  // Blank is not a duplicate - most bids have no number yet.
  const blanks = Store.db.bids.filter(b => !b.proposalNo).length;
  check('blank proposal numbers do not clash', blanks > 1, String(blanks));
}

console.log('\n--- Proposal No. is an active-stage field ---');
{
  const shown = () => !U.$('proposalNoBlock').classList.contains('hidden');

  // A bid that has just arrived is identified by its name and its place in the
  // list. Asking for a proposal number before there is going to be a proposal
  // invites one being invented and then changed.
  Bids.openAdd();
  check('Add New Bid does not ask for a Proposal No.', shown() === false);
  Bids.closeModal();

  // The migration marks every pre-existing bid active, so make one intake.
  const intake = Store.db.bids[Store.db.bids.length - 1];
  intake.active = false;
  Bids.edit(intake.id);
  check('nor does editing a bid still in All Bids', shown() === false);
  Bids.closeModal();

  const live = Store.db.bids.filter(b => b.active)[0];
  live.proposalNo = 'DIS-P-STAGE';
  Bids.edit(live.id);
  check('but an active bid gets the field, filled in',
    shown() === true && U.$('mProposalNo').value === 'DIS-P-STAGE',
    U.$('mProposalNo').value);
  Bids.closeModal();

  // Opening Add straight after editing an active bid must not carry the number
  // over into the new record.
  Bids.openAdd();
  check('a new bid does not inherit the last one\'s number',
    U.$('mProposalNo').value === '' && shown() === false,
    JSON.stringify(U.$('mProposalNo').value));
  U.$('mProject').value = 'Intake Stage Test Bid';
  U.$('mRegion').value = Store.db.regions[0];
  Bids.save({ preventDefault() {} });
  const made = Store.db.bids.filter(b => b.project === 'Intake Stage Test Bid')[0];
  check('and saves as intake with no proposal number',
    made && made.proposalNo === '' && made.active === false,
    JSON.stringify(made && made.proposalNo) + '/' + (made && made.active));

  // Hidden must mean preserved, not wiped: a bid can hold a number from an
  // older file even while it sits in All Bids.
  intake.proposalNo = 'DIS-P-LEGACY';
  Bids.edit(intake.id);
  check('a hidden number is not wiped by editing', shown() === false);
  Bids.save({ preventDefault() {} });
  check('and survives the save', intake.proposalNo === 'DIS-P-LEGACY', intake.proposalNo);
  intake.proposalNo = '';
}

console.log('\n--- tab badges count what each tab holds ---');
{
  const shown = () => ['all', 'active', 'awarded'].map(k => {
    const el = U.$('badge-' + k);
    return el ? Number(el.textContent.trim()) : null;
  });
  const real = () => ['all', 'active', 'awarded'].map(k => Bids.viewCount(k));

  App.switchTab('active');
  check('badges match the lists at boot',
    JSON.stringify(shown()) === JSON.stringify(real()),
    shown().join(',') + ' vs ' + real().join(','));
  check('and they are not all zero', shown().every(n => n !== null) && shown()[0] > 0,
    shown().join(','));

  // The sub-menu is re-rendered on every navigation. Patching the numbers in
  // afterwards meant they were wiped the moment you changed tabs.
  App.switchTab('all');
  check('badges survive a tab change',
    JSON.stringify(shown()) === JSON.stringify(real()), shown().join(','));
  App.switchTab('dashboard');
  App.switchTab('active');
  check('and a round trip through another module',
    JSON.stringify(shown()) === JSON.stringify(real()), shown().join(','));

  // A mutation must move them without needing a navigation.
  const before = Bids.viewCount('active');
  const moved = Bids.baseList()[0];
  Bids.promptDecision(moved.id, 'Awarded');
  Bids.confirmDecision();
  check('awarding moves a bid between the badges',
    Bids.viewCount('active') === before - 1 &&
    JSON.stringify(shown()) === JSON.stringify(real()),
    shown().join(',') + ' vs ' + real().join(','));

  // The badge counts the tab, not the search box.
  U.$('searchActive').value = 'zzzz-no-such-bid';
  Bids.filterTable();
  check('filtering the table does not change the badge',
    Number(U.$('badge-active').textContent) === Bids.viewCount('active'),
    U.$('badge-active').textContent);
  U.$('searchActive').value = '';
  Bids.filterTable();
}

console.log('\n--- promoting a bid whose project name already exists ---');
{
  // Two seeded bids are called "Duke Petroleum" - a genuine rebid, which is
  // exactly the case worth a warning rather than a rule.
  const pair = Store.db.bids.filter(b =>
    /^duke petroleum$/.test((b.project || '').trim().toLowerCase()));
  check('the seed data really does contain a repeated project name',
    pair.length === 2, String(pair.length));
  pair.forEach(b => { b.active = false; });
  const target = pair[0];

  check('the duplicate is found', Bids.duplicateProjects(target).length === 1);

  Bids.addToActive(target.id);
  check('promotion stops to warn rather than going ahead',
    !U.$('duplicateModal').classList.contains('hidden') && target.active === false);
  check('and the warning names the bid already on file',
    /Duke Petroleum/.test(U.$('duplicateList').innerHTML),
    U.$('duplicateList').innerHTML.slice(0, 120));

  Bids.cancelAddToActive();
  check('saying no takes no action at all',
    target.active === false && U.$('duplicateModal').classList.contains('hidden'));
  Bids.setView('active');
  check('so it is not on Active Bids', !Bids.baseList().some(b => b.id === target.id));

  Bids.addToActive(target.id);
  Bids.confirmAddToActive();
  check('saying yes adds it as a separate project', target.active === true);
  Bids.setView('active');
  check('and it appears on Active Bids', Bids.baseList().some(b => b.id === target.id));
  check('the one already on file is untouched', pair[1].active === false);

  // The check must not fire on a name nobody else is using.
  const solo = Store.db.bids.filter(b => Bids.duplicateProjects(b).length === 0)[0];
  solo.active = false;
  Bids.addToActive(solo.id);
  check('a unique project name is promoted without asking',
    solo.active === true && U.$('duplicateModal').classList.contains('hidden'));

  // Both routes into Active Bids go through the same gate.
  const viaPage = pair[1];
  Bids.setView('all');
  Project.open(viaPage.id);
  Project.addToActive();
  check('the project page asks too, rather than bypassing the check',
    !U.$('duplicateModal').classList.contains('hidden') && viaPage.active === false);
  Bids.cancelAddToActive();
  check('and cancelling there leaves the page where it was',
    viaPage.active === false && Project.mode() === 'all');
  App.switchTab('active');
}

console.log('\n--- the three stages: intake, active, decided ---');
{
  // Active is "promoted AND still open" - two independent facts, so they cannot
  // disagree about whether a bid belongs on the list.
  const intake = Store.db.bids.filter(b => Bids.bucketOf(b) === 'open')[0];
  intake.active = false;
  Bids.setView('active');
  check('an unpromoted bid is not on Active Bids',
    !Bids.baseList().some(b => b.id === intake.id));
  Bids.setView('all');
  check('but it is on All Bids', Bids.baseList().some(b => b.id === intake.id));
  Bids.addToActive(intake.id);
  Bids.setView('active');
  check('promoting puts it on Active Bids',
    Bids.baseList().some(b => b.id === intake.id));

  // A lost bid stays on Active Bids: the work went into it, and hiding it hides
  // that history from the list the estimators actually read.
  const loser = Store.db.bids.filter(b => b.active && Bids.bucketOf(b) === 'open')[1];
  Bids.promptDecision(loser.id, 'Lost');
  check('the Lost confirmation names no job number',
    U.$('decisionNumberRow').classList.contains('hidden') &&
    /lost/i.test(U.$('decisionTitle').textContent), U.$('decisionTitle').textContent);
  Bids.confirmDecision();
  check('a lost bid issues no job number', loser.status === 'Lost' && !loser.awardNo);
  check('its promotion flag is untouched', loser.active === true);
  Bids.setView('active');
  check('and it STAYS on Active Bids', Bids.baseList().some(b => b.id === loser.id));
  Bids.filterTable();
  check('shown muted rather than as live work', /row-decided/.test(gridHTML()));
  check('Lost is offered in the Active status filter',
    [...U.$('filterStatus').options].some(o => o.value === 'Lost'));
  Bids.setView('awarded');
  check('but it is NOT in Awarded Bids', !Bids.baseList().some(b => b.id === loser.id));
  Bids.setView('all');
  check('a lost bid is also in All Bids', Bids.baseList().some(b => b.id === loser.id));
  // A lost job that comes back must be awardable from where it sits.
  Bids.promptDecision(loser.id, 'Awarded');
  Bids.confirmDecision();
  check('a lost bid can still be awarded', loser.status === 'Awarded' && !!loser.awardNo);
  loser.status = 'Lost'; loser.awardNo = null;

  // No Scope closes a bid the same way, but is a status you can type.
  const noScope = Store.db.bids.filter(b => b.active && Bids.bucketOf(b) === 'open')[0];
  Bids.edit(noScope.id);
  U.$('mStatus').value = 'No Scope';
  Bids.save({ preventDefault() {} });
  check('No Scope is settable from the form', noScope.status === 'No Scope');
  Bids.setView('active');
  check('and it closes the bid', !Bids.baseList().some(b => b.id === noScope.id));
  Bids.setView('all');
  check('a No Scope bid stays in All Bids', Bids.baseList().some(b => b.id === noScope.id));

  check('No Scope is not offered in the Active status filter',
    (Bids.setView('active'),
     ![...U.$('filterStatus').options].some(o => o.value === 'No Scope')));

  // Promoting resets only a status Active cannot hold. No Scope is one of
  // those; Lost is not, so promoting a lost bid must not erase the outcome.
  Bids.addToActive(noScope.id);
  check('promoting a No Scope bid reopens it', noScope.status === 'Not Started');
  Bids.setView('active');
  check('and it is back on Active Bids', Bids.baseList().some(b => b.id === noScope.id));
  check('promoting a Lost bid leaves its status alone',
    (Bids.promoteBid(loser) === false && loser.status === 'Lost'), loser.status);

  check('every status the app can hold has a badge',
    Bids.STATUSES.every(s => /^status-/.test(s.badge)));
  check('Awarded Bids is awarded only',
    (Bids.setView('awarded'), Bids.baseList().every(b => b.status === 'Awarded')));
  Bids.setView('active');
}

console.log('\n--- team sheet: hours per engineer per task ---');
{
  const b = Store.db.bids.filter(x => x.active && Bids.bucketOf(x) === 'open')[0];
  b.assignments = [];
  // The intake figures must survive everything the team sheet does to them.
  b.estHrs = 3; b.assignedHrs = 1; b.totalHrs = 4;

  check('a promoted bid starts with no team hours',
    Assign.totals(b).est === 0 && Assign.totals(b).asgn === 0 && Assign.rows(b).length === 0);

  Bids.setView('active');
  Project.open(b.id);
  check('the project page carries a Team & Hours card',
    /Team &amp; Hours/.test(U.$('section-project').innerHTML));

  Assign.add(b.id);
  Assign.add(b.id);
  const [r1, r2] = Assign.rows(b);
  Assign.set(b.id, r1.id, 'engineer', 'af');       // lower case on purpose
  Assign.set(b.id, r1.id, 'taskType', 'Shop drawings');
  Assign.set(b.id, r1.id, 'estHrs', '12');
  Assign.set(b.id, r1.id, 'asgnHrs', '4');
  Assign.set(b.id, r2.id, 'engineer', 'AF');       // same person, second task
  Assign.set(b.id, r2.id, 'taskType', 'Site measure');
  Assign.set(b.id, r2.id, 'estHrs', '6.5');
  Assign.set(b.id, r2.id, 'asgnHrs', '2');

  check('initials normalise to the register\'s casing', r1.engineer === 'AF', r1.engineer);
  const t = Assign.totals(b);
  check('each column totals down its own rows',
    t.est === 18.5 && t.asgn === 6, `${t.est}/${t.asgn}`);
  // The two measure the same work from opposite sides, so nothing adds them.
  check('and nothing adds the two together', t.total === undefined, String(t.total));
  check('one engineer on two tasks counts once in the team',
    Assign.engineerList(b).length === 1, Assign.engineerList(b).join(','));

  // The two stages are separate numbers - that is the whole point of the split.
  check('the intake hours are untouched by team edits',
    b.estHrs === 3 && b.assignedHrs === 1, `${b.estHrs}/${b.assignedHrs}`);
  Bids.edit(b.id);
  U.$('mEstHrs').value = '9';
  Bids.save({ preventDefault() {} });
  check('and editing the intake hours does not touch the team',
    b.estHrs === 9 && Assign.totals(b).est === 18.5,
    `${b.estHrs}/${Assign.totals(b).est}`);

  Bids.setView('active');
  Bids.filterTable();
  const hdrA = [...gridHeadCells()].map(th => th.textContent.trim());
  const rowA = [...gridRows()].find(r => r.textContent.includes(b.project));
  const cellA = k => [...rowA.querySelectorAll('td')][hdrA.findIndex(h => new RegExp(k).test(h))]
    .textContent.trim();
  check('Active Bids shows the team hours, not the intake ones',
    cellA('Estm Hrs') === '18.5' && cellA('Asgn Hrs') === '6',
    cellA('Estm Hrs') + '/' + cellA('Asgn Hrs'));
  check('and the team initials in the Engineer column', /AF/.test(cellA('Engineer')));

  Bids.setView('all');
  Bids.filterTable();
  const hdrI = [...gridHeadCells()].map(th => th.textContent.trim());
  const rowI = [...gridRows()].find(r => r.textContent.includes(b.project));
  const cellI = k => [...rowI.querySelectorAll('td')][hdrI.findIndex(h => new RegExp(k).test(h))]
    .textContent.trim();
  check('All Bids still shows the intake hours', cellI('Estm Hrs') === '9', cellI('Estm Hrs'));
  Bids.setView('active');

  // Removing an empty row must not stop to ask.
  Assign.add(b.id);
  const empty = Assign.rows(b)[2];
  Assign.remove(b.id, empty.id);
  check('an empty row is removed without a prompt', Assign.rows(b).length === 2);
  Assign.remove(b.id, r2.id);
  check('and removing a row with hours takes them off the total',
    Assign.totals(b).est === 12 && Assign.rows(b).length === 1,
    String(Assign.totals(b).est));
}

console.log('\n--- task types ---');
{
  check('a starting list ships', Store.db.taskTypes.length > 3);
  App.switchTab('tasktypes');
  check('the Task Types panel renders',
    !!U.$('taskTypeList') && U.$('taskTypeList').innerHTML.length > 50);
  check('the rail lists it', /Task Types/.test(U.$('settingsRail').innerHTML));

  const before = Store.db.taskTypes.length;
  U.$('newTaskType').value = 'Weld inspection';
  Settings.addTaskType();
  check('a task type can be added', Store.db.taskTypes.length === before + 1 &&
    Store.db.taskTypes.includes('Weld inspection'));
  U.$('newTaskType').value = 'weld inspection';
  Settings.addTaskType();
  check('duplicates are rejected regardless of case',
    Store.db.taskTypes.length === before + 1, String(Store.db.taskTypes.length));

  // A rename has to follow the rows using it, like engineer initials do.
  const b = Store.db.bids.filter(x => Assign.rows(x).some(r => r.taskType === 'Shop drawings'))[0];
  const i = Store.db.taskTypes.indexOf('Shop drawings');
  Settings.renameTaskType(i, 'Shop drawings & details');
  check('renaming carries onto the assignment rows',
    Assign.rows(b).some(r => r.taskType === 'Shop drawings & details') &&
    !Assign.rows(b).some(r => r.taskType === 'Shop drawings'),
    JSON.stringify(Assign.rows(b).map(r => r.taskType)));
  check('and the count of rows using it is reported',
    Assign.countTaskType('Shop drawings & details') >= 1);

  // Deleting leaves the value on rows that carry it - they are a record of work.
  const j = Store.db.taskTypes.indexOf('Shop drawings & details');
  Settings.removeTaskType(j);
  check('deleting takes it off the list',
    !Store.db.taskTypes.includes('Shop drawings & details'));
  check('but the rows keep the value',
    Assign.rows(b).some(r => r.taskType === 'Shop drawings & details'));

  App.switchTab('active');
}

console.log('\n--- Proposal No. flows from the bid ---');
{
  const b = Store.db.bids.filter(x => x.active && Bids.bucketOf(x) === 'open' && !x.takeoffId)[0];
  Bids.edit(b.id);
  U.$('mProposalNo').value = 'DIS-P-7788';
  Bids.save({ preventDefault() {} });
  check('the number is stored on the bid', b.proposalNo === 'DIS-P-7788');

  Takeoff.openForBid(b.id);
  check('a new takeoff picks it up',
    Store.db.takeoffs[b.takeoffId].project.proposalNo === 'DIS-P-7788',
    Store.db.takeoffs[b.takeoffId].project.proposalNo);

  Takeoff.addProduct('Steel Guardrail');
  Proposal.generateFromTakeoff(b.takeoffId);
  check('and the generated proposal prints it',
    Store.db.proposals[b.proposalId].proposalData.proposalNo === 'DIS-P-7788',
    Store.db.proposals[b.proposalId].proposalData.proposalNo);

  // Editing it on the bid must not leave the old number on a document that has
  // already been generated.
  Bids.edit(b.id);
  U.$('mProposalNo').value = 'DIS-P-7799';
  Bids.save({ preventDefault() {} });
  check('changing it on the bid updates the proposal',
    Store.db.proposals[b.proposalId].proposalData.proposalNo === 'DIS-P-7799',
    Store.db.proposals[b.proposalId].proposalData.proposalNo);
  check('and the takeoff too',
    Store.db.takeoffs[b.takeoffId].project.proposalNo === 'DIS-P-7799');

  Bids.setView('active');
  Bids.filterTable();
  check('Active Bids shows the Proposal No. column',
    BidGrid.activeColumns().some(c => c.key === 'proposalNo') &&
    /DIS-P-7799/.test(gridHTML()));
  Bids.setView('all');
  // The proposal number identifies the project from the moment it is entered,
  // so it is on the intake register too. The job number is not - that only
  // exists once the bid is won.
  check('All Bids shows the Proposal No. but not the Job No.',
    BidGrid.activeColumns().some(c => c.key === 'proposalNo') &&
    !BidGrid.activeColumns().some(c => c.key === 'awardNo'),
    BidGrid.activeColumns().map(c => c.key).join(','));
  Bids.setView('active');
}

console.log('\n--- the full-screen project view ---');
{
  const bid = Store.db.bids[0];
  Bids.setView('active');
  Bids.filterTable();
  check('a bid row opens the project page when clicked',
    /Project\.open\(/.test(gridHTML()));
  check('the Actions cell stops the row click reaching the page',
    /onclick="event\.stopPropagation\(\)"/.test(gridHTML()));

  Project.open(bid.id);
  check('the project page is the visible one',
    Nav.current.section === 'project' &&
    !U.$('section-project').classList.contains('hidden'));
  check('and the shell is immersive', win.document.body.classList.contains('projectview'));
  check('it knows which project it is on', Project.currentBid().id === bid.id);
  const page = U.$('section-project').innerHTML;
  check('the overview shows the project details', /Project Details/.test(page));
  check('with its estimate', /Estimate/.test(page));
  check('and its proposal', /Proposal/.test(page));

  const head = U.$('projectHeader').innerHTML;
  check('the project bar names the project', new RegExp(bid.project.slice(0, 12)).test(head));
  check('and carries the three tabs',
    /Overview/.test(head) && /TakeOff/.test(head) && /Proposal/.test(head));

  App.switchTab('takeoff');
  check('TakeOff stays inside the project view',
    Nav.current.module === 'project' &&
    win.document.body.classList.contains('projectview'));
  check('and the project bar still names the same project',
    Project.currentBid().id === bid.id);

  Project.close();
  check('Back returns to the bid list it came from',
    Nav.current.section === 'active' &&
    !win.document.body.classList.contains('projectview'));
  // The project bar carries its own #saveIndicator; left in place it would
  // shadow the footer's, which is the one on screen now.
  check('leaving the project view does not shadow the footer save indicator',
    U.$('projectHeader').innerHTML === '' &&
    U.$('saveIndicator').closest('footer') !== null);

  // Opening a takeoff by any other route must still show the right header.
  const withTakeoff = Store.db.bids.filter(b => b.takeoffId)[0];
  Takeoff.openForBid(withTakeoff.id);
  check('opening a takeoff directly derives its project',
    Project.currentBid().id === withTakeoff.id, String(Project.currentBid().id));
  App.switchTab('active');
}

console.log('\n--- the project page in the intake stage ---');
{
  // Opened from All Bids the page is a record card: there is no estimate and no
  // proposal until somebody picks the bid up.
  const bid = Store.db.bids.filter(b => Bids.bucketOf(b) === 'open')[0];
  bid.active = false;
  bid.awardNo = 'DIS-26-9999';        // even a bid that has one must not show it
  Bids.setView('all');
  Project.open(bid.id);
  check('opening from All Bids is the intake mode', Project.mode() === 'all');

  const page = U.$('section-project').innerHTML;
  check('no Estimate card', !/Total Bid Cost/.test(page) && !/Start takeoff/.test(page));
  check('no Proposal card', !/Proposal Total/.test(page) && !/Scope Items/.test(page));
  check('no Job No. on the details card', !/Job No\./.test(page));
  check('the Proposal No. takes its place', /Proposal No\./.test(page));
  check('and it offers to pick the bid up', /Add to Active bid/.test(page));

  const head = U.$('projectHeader').innerHTML;
  check('the bar offers no TakeOff or Proposal tab',
    !/TakeOff/.test(head) && !/switchTab\('proposal'\)/.test(head), head.slice(0, 200));
  check('nor the Award decision', !/Award/.test(head));
  check('and does not show the job number', !/DIS-26-9999/.test(head));

  // A stale ?section=takeoff must not land on a page the bar cannot leave.
  App.switchTab('takeoff');
  check('TakeOff is not reachable in the intake stage',
    Nav.current.section === 'project', Nav.current.section);

  Project.addToActive();
  check('promoting from the page moves it to Active Bids', bid.active === true);
  check('and switches the page into the working mode', Project.mode() === 'active');
  const after = U.$('section-project').innerHTML;
  check('which brings back the Estimate and Proposal cards',
    /Estimate/.test(after) && /Proposal/.test(after));
  check('and the Award decision', /Award/.test(U.$('projectHeader').innerHTML));

  // An already-active bid opened from All Bids offers the way across instead.
  Bids.setView('all');
  Project.open(bid.id);
  check('an active bid seen from All Bids offers the crossing, not promotion',
    /Open in Active Bids/.test(U.$('section-project').innerHTML) &&
    !/Add to Active bid/.test(U.$('section-project').innerHTML));
  Project.openInActive();
  check('and taking it lands in the working mode', Project.mode() === 'active');

  bid.awardNo = null;
  App.switchTab('active');
  App.switchTab('active');
}

console.log('\n--- the settings page ---');
{
  App.openSettings();
  check('Settings opens on a settings panel', Nav.current.module === 'settings');
  check('the settings shell is on screen',
    !U.$('settingsShell').classList.contains('hidden'));
  check('the sub-menu strip stays out of the way',
    U.$('subMenuBar').classList.contains('hidden'));
  check('the rail lists every panel',
    ['Rate Library', 'References', 'Regions', 'Engineers', 'Company']
      .every(l => U.$('settingsRail').innerHTML.includes(l)),
    U.$('settingsRail').innerHTML.slice(0, 200));

  App.switchTab('regions');
  check('the regions panel renders its list',
    !!U.$('regionList') && U.$('regionList').innerHTML.length > 100);
  const regionsBefore = Store.db.regions.length;
  U.$('newRegionName').value = 'Test County';
  Bids.addRegion();
  check('a region can be added from the panel',
    Store.db.regions.length === regionsBefore + 1 &&
    Store.db.regions.includes('Test County'));
  Bids.removeRegion('Test County');
  check('and removed again', Store.db.regions.length === regionsBefore);

  App.switchTab('company');
  Settings.setCompany('phone', '(555) 010-0100');
  check('company details save', Store.db.company.phone === '(555) 010-0100');

  App.switchTab('ratelib');
  check('Rate Library still renders, inside the settings shell',
    U.$('section-ratelib').innerHTML.length > 1000 &&
    !U.$('settingsShell').classList.contains('hidden'));
  check('Settings remembers the panel you left it on',
    Store.db.ui.settingsSection === 'ratelib', Store.db.ui.settingsSection);

  App.switchTab('active');
  check('leaving Settings hides its shell',
    U.$('settingsShell').classList.contains('hidden'));
}

console.log('\n--- rate library tab ---');
App.switchTab('ratelib');
check('rate library renders', U.$('section-ratelib').innerHTML.length > 1000);
check('rate library lists parts', /Alro/.test(U.$('section-ratelib').innerHTML));
check('labour rate panel present', /Fabrication \/ hr/.test(U.$('section-ratelib').innerHTML));

console.log('\n--- references: editable, never deletable ---');
App.switchTab('references');
const Refs = win.References;
const refHost = U.$('section-references');
check('references render from the database', Store.db.references.length === 5,
  String(Store.db.references.length));
check('all five tables on screen',
  (refHost.innerHTML.match(/<table/g) || []).length === 5);
check('a known rate is shown', /0\.15 - 0\.25/.test(refHost.innerHTML));

check('read mode has no inputs', refHost.querySelectorAll('input').length === 0);
Refs.toggleEdit();
check('edit mode exposes inputs', refHost.querySelectorAll('input').length > 0);
check('no delete control anywhere in the references tab',
  !/fa-trash|fa-times|Delete/i.test(refHost.innerHTML));

const engTable = Refs.table('engineering-hours-hr-lf');
const origRate = engTable.rows[0][1];
const origLabel = engTable.rows[0][0];
Refs.setCell(0, 0, 1, '0.12 - 0.18');
check('a rate can be edited', Refs.table('engineering-hours-hr-lf').rows[0][1] === '0.12 - 0.18');
Refs.setCell(0, 0, 0, 'Simple Handrail (Wall Mtd)');
check('a row name can be edited',
  Refs.table('engineering-hours-hr-lf').rows[0][0] === 'Simple Handrail (Wall Mtd)');
Refs.setTitle(0, 'Engineering Hours per LF');
check('a table heading can be edited', Store.db.references[0].title === 'Engineering Hours per LF');
Refs.setColumn(0, 1, 'Hrs / LF');
check('a column heading can be edited', Store.db.references[0].columns[1].label === 'Hrs / LF');

// Blanking a heading would leave an unlabelled table, so it is refused.
Refs.setTitle(0, '   ');
check('a blank table heading is refused', Store.db.references[0].title === 'Engineering Hours per LF');
Refs.setColumn(0, 1, '');
check('a blank column heading is refused', Store.db.references[0].columns[1].label === 'Hrs / LF');

Refs.toggleEdit();
check('edits show in read mode', /0\.12 - 0\.18/.test(U.$('section-references').innerHTML));

await Store.flush();
const refState = await readState();
check('reference edits persist',
  refState.references[0].rows[0][1] === '0.12 - 0.18' &&
  refState.references[0].title === 'Engineering Hours per LF');

Refs.restore(0);
check('restore defaults puts the table back',
  Refs.table('engineering-hours-hr-lf').rows[0][1] === origRate &&
  Refs.table('engineering-hours-hr-lf').rows[0][0] === origLabel &&
  Store.db.references[0].title === 'Engineering Hours (hr/LF)',
  JSON.stringify(Store.db.references[0].rows[0]));
check('restoring one table leaves the others alone',
  Store.db.references.length === 5 && Store.db.references[3].rows.length === 5);

console.log('\n--- dashboard ---');
App.switchTab('dashboard');   // Chart.js is absent here; must degrade, not throw
check('dashboard switch survives without Chart.js', true);
check('dashboard is the visible page',
  !U.$('section-dashboard').classList.contains('hidden') &&
  U.$('section-bidlist').classList.contains('hidden'));

console.log('\n--- navigation shell ---');
App.switchTab('active');
check('every menu section has a matching DOM page',
  Nav.domIds().every(id => !!U.$(id)), Nav.domIds().filter(id => !U.$(id)).join(','));
check('switchTab on a Bid Management page activates that module',
  Nav.current.module === 'bids' && Nav.current.section === 'active');
App.switchTab('proposal');
check('Proposal belongs to the Project module now', Nav.current.module === 'project');
check('and the project view is immersive',
  win.document.body.classList.contains('projectview'));
App.switchTab('active');
check('leaving the project view drops the immersive class',
  !win.document.body.classList.contains('projectview'));
App.switchTab('production');
check('a placeholder module opens its own page',
  Nav.current.module === 'production' &&
  !U.$('section-production').classList.contains('hidden'));
check('the placeholder says it is not built yet',
  /Not built yet/.test(U.$('section-production').innerHTML));
check('the sub-menu strip is hidden for a placeholder module',
  U.$('subMenuBar').classList.contains('hidden'));
App.switchTab('active');
check('the sub-menu strip comes back for Bid Management',
  !U.$('subMenuBar').classList.contains('hidden'));
check('the module bar lists all six modules',
  Nav.MENU.filter(m => !m.hidden).length === 6,
  Nav.MENU.filter(m => !m.hidden).map(m => m.key).join(','));
check('Project and Settings are reached another way, not from the module bar',
  Nav.MENU.filter(m => m.hidden).map(m => m.key).sort().join(',') === 'project,settings');

// The month grid moved to the Dashboard, so clicking a month has to carry you
// to the list it filters or the interaction is lost.
App.switchTab('dashboard');
Bids.selectMonth(6);
check('picking a month on the Dashboard lands on All Bids',
  Nav.current.section === 'all', Nav.current.section);
check('and applies that month as a filter', U.$('filterMonth').value === '6',
  U.$('filterMonth').value);
check('every listed bid is in that month',
  Bids.baseList().every(b => b.month === 6));
Bids.showAll();
check('View All clears the month filter', U.$('filterMonth').value === '');
App.switchTab('active');

console.log('\n--- pop-out ---');
// The window itself looks right either way; what a popout must NOT do is
// persist its own location, or the main window jumps there on its next boot.
check('the main window persists where it is',
  Store.db.ui.section === 'active' && Store.db.ui.module === 'bids',
  Store.db.ui.module + '/' + Store.db.ui.section);
const realIsPopout = Nav.isPopout;
Nav.isPopout = () => true;
try {
  App.switchTab('takeoff');
  check('a popout renders the page it was addressed to',
    Nav.current.section === 'takeoff' &&
    !U.$('section-takeoff').classList.contains('hidden'));
  check('a popout does NOT persist its location over the main window\'s',
    Store.db.ui.section === 'active' && Store.db.ui.module === 'bids',
    'ui is now ' + Store.db.ui.module + '/' + Store.db.ui.section);
} finally { Nav.isPopout = realIsPopout; }
App.switchTab('active');
check('the main window persists again once it is not a popout',
  Store.db.ui.section === 'active');
check('pop-out is offered when IndexedDB is the backend',
  Nav.canPopout() === (Store.backend === 'indexeddb'));

console.log('\n--- the proposal is dealt into numbered pages ---');
{
  /* jsdom has no layout engine, so nothing here has a height and the real
     measuring cannot run. The arithmetic can: Paginate takes its measurer as an
     argument for exactly this reason, and the page-breaking is the half with
     the interesting mistakes in it. Heights below are in arbitrary units.

     Every page is 100 tall except the first, which has 120 because it carries
     no running header. */
  const P = win.Paginate;
  const measurer = (heights, itemHeights) => ({
    firstFit: 120,
    restFit: 100,
    blockHeights: () => heights,
    listParts: html => {
      const d = win.document.createElement('div');
      d.innerHTML = html;
      const list = d.querySelector('ul, ol');
      const items = [...list.children];
      return {
        items,
        heights: itemHeights.slice(0, items.length),
        overhead: 0,
        // The real one rebuilds the wrapping chain around each run; for the
        // arithmetic under test a bare list is enough.
        mount: run => {
          const w = list.cloneNode(false);
          run.forEach(i => w.appendChild(i.cloneNode(true)));
          return { node: w, list: w };
        }
      };
    }
  });

  const pageCount = html => (html.match(/class="doc-page/g) || []).length;
  const bodies = html => [...html.matchAll(/<div class="doc-body">([\s\S]*?)<\/div><div class="doc-foot">/g)]
    .map(m => m[1]);

  let out = P.flow({
    blocks: [{ html: '<p>a</p>' }, { html: '<p>b</p>' }],
    measurer: measurer([50, 50], [])
  });
  check('a short document is one page', pageCount(out) === 1, String(pageCount(out)));
  check('and that page is marked as the last one', /doc-page-last/.test(out));

  out = P.flow({
    blocks: [{ html: '<p>a</p>' }, { html: '<p>b</p>' }, { html: '<p>c</p>' }],
    measurer: measurer([100, 60, 30], []),
    footer: (no, count) => `${no}/${count}`
  });
  check('a block that will not fit starts a new page', pageCount(out) === 2, String(pageCount(out)));
  check('page one takes what fits in its taller body',
    bodies(out)[0] === '<p>a</p>', bodies(out)[0]);
  check('and the overleaf page keeps filling up',
    bodies(out)[1] === '<p>b</p><p>c</p>', bodies(out)[1]);
  check('the pages are numbered from one', /1\/2/.test(out) && /2\/2/.test(out));
  check('only the final page is marked last',
    (out.match(/doc-page-last/g) || []).length === 1);

  // Page one's letterhead is its header; every page after it gives up the
  // height of the running strip.
  out = P.flow({
    blocks: [{ html: '<p>a</p>' }],
    measurer: measurer([10], []),
    header: () => '<em>running</em>'
  });
  check('page one carries no running header', !/running/.test(out), out.slice(0, 120));
  out = P.flow({
    blocks: [{ html: '<p>a</p>' }, { html: '<p>b</p>' }],
    measurer: measurer([120, 10], []),
    header: no => `<em>page ${no}</em>`
  });
  check('but every page after it does', /page 2/.test(out) && !/page 1/.test(out));

  // A heading stranded at the foot of a page reads as a heading for nothing.
  out = P.flow({
    blocks: [{ html: '<p>filler</p>' }, { html: '<h2>Terms</h2>', keepWithNext: true },
             { html: '<p>body</p>' }],
    measurer: measurer([100, 15, 60], [])
  });
  check('a heading is not left alone at the foot of a page',
    !/filler<\/p><h2>/.test(bodies(out)[0]) && /<h2>Terms<\/h2>/.test(bodies(out)[1]),
    bodies(out).join(' || '));

  // Terms & Conditions runs across a page break in the reference proposal.
  out = P.flow({
    blocks: [{ html: '<p>x</p>' },
             { html: '<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>', splitAt: 'li' }],
    measurer: measurer([100, 200], [50, 50, 50, 50])
  });
  check('a long list is broken between its items, not shunted whole',
    pageCount(out) === 3 && bodies(out).filter(b => /<li>/.test(b)).length === 2,
    bodies(out).join(' || '));
  // 20 units of room left and a 50-unit item: cramming it in would hang it off
  // the bottom of the page, so the list starts overleaf instead.
  check('and does not start in a gap too small for its first item',
    !/<li>/.test(bodies(out)[0]), bodies(out)[0]);
  check('each run is a complete list so the bullets survive the break',
    bodies(out).every(b => !/<li>/.test(b) || /<ul>[\s\S]*<\/ul>/.test(b)),
    bodies(out).join(' || '));
  check('no item is lost or duplicated across the break',
    (out.match(/<li>/g) || []).length === 4, out);

  check('an empty document still produces one numbered page',
    pageCount(P.flow({ blocks: [], measurer: measurer([], []) })) === 1);

  /* The real blocks are not bare lists: Terms is a styled wrapper around one,
     and a continuation run that loses the wrapper loses its styling and its
     indentation halfway down the page. This is what Chrome caught. */
  {
    const domParts = html => {
      // Exercise the shipped measurer's list-finding, with heights faked.
      const d = win.document.createElement('div');
      d.innerHTML = html;
      return d;
    };
    const wrapped = '<div class="prose-doc text-[10.5px] pb-4"><ul><li>1</li><li>2</li>' +
      '<li>3</li><li>4</li></ul></div>';
    const out2 = P.flow({
      blocks: [{ html: '<p>x</p>' }, { html: wrapped, splitAt: 'li' }],
      measurer: (() => {
        const m = measurer([100, 200], [50, 50, 50, 50]);
        // Use the real chain-cloning rather than the simplified fake, so the
        // thing that broke is the thing under test.
        const real = { listParts: null };
        m.listParts = html => {
          const root = domParts(html).firstElementChild;
          const list = root.querySelector('ul');
          const items = [...list.children];
          return {
            items, heights: [50, 50, 50, 50], overhead: 0,
            mount: run => {
              const l = list.cloneNode(false);
              run.forEach(i => l.appendChild(i.cloneNode(true)));
              const w = root.cloneNode(false);
              w.appendChild(l);
              return { node: w, list: l };
            }
          };
        };
        return m;
      })()
    });
    const pieces = bodies(out2).join('');
    check('a wrapped list keeps its wrapper on every run',
      (pieces.match(/class="prose-doc/g) || []).length === 2, pieces);
    check('and every run is still a real list',
      (pieces.match(/<ul>/g) || []).length === 2, pieces);
    check('with all four items intact', (pieces.match(/<li>/g) || []).length === 4, pieces);
  }
}

console.log('\n' + (failures === 0
  ? 'All smoke checks passed.'
  : failures + ' CHECK(S) FAILED: ' + errors.join(', ')));
process.exit(failures === 0 ? 0 : 1);
}
