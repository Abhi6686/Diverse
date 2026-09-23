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
    // jsdom has neither storage under file:// - the origin is opaque, and
    // touching sessionStorage throws rather than returning null - nor
    // execCommand. Both are stood up here, so the app is exercised on the same
    // path a browser takes rather than on its private-mode fallbacks.
    function shim(name) {
      const store = {};
      Object.defineProperty(win, name, {
        value: {
          getItem: k => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: k => { delete store[k]; },
          clear: () => { Object.keys(store).forEach(k => { delete store[k]; }); }
        }
      });
    }
    shim('localStorage');
    shim('sessionStorage');
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
  'js/proposal.defaults.js', 'js/util.js', 'js/ui.js', 'js/datepicker.js', 'js/sparks.js', 'js/intro.js', 'js/guide.js', 'js/auth.js', 'js/store.js', 'js/nav.js', 'js/rates.js', 'js/catalog.js',
  'js/bidgrid.js', 'js/references.js', 'js/ratespanel.js', 'js/takeoff.model.js',
  'js/xlsx.zip.js', 'js/estimate.template.js', 'js/estimate.xlsx.js',
  'js/report.xlsx.js', 'js/takeoff.js',
  'js/proposal.paginate.js', 'js/proposal.js', 'js/ratelib.js', 'js/bids.js', 'js/bids.report.js', 'js/assignments.js', 'js/products.js', 'js/history.js', 'js/schedule.js', 'js/presence.js', 'js/project.js',
  'js/settings.js', 'js/app.js'];

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

/* An .xlsx the app just built, opened again. The exporter writes stored
   entries, so there is nothing to inflate - this walks the central directory
   the way any unzip tool would, which is the point: a header the writer got
   wrong fails here and not in Excel. tests/estimate-xlsx.js does the thorough
   version; this is enough to look at a sheet. */
function unzipMem(bytes) {
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('the exported workbook is not a zip');
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(p + 28);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    const lho = b.readUInt32LE(p + 42);
    const size = b.readUInt32LE(p + 20);
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    out[name] = b.toString('utf8', start, start + size);
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return out;
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
/* On the Employee view the last row is the shop's totals, which has as many
   cells as a bid row and is not one. Bid rows carry .sched-row. */
function schedRows() {
  const t = gridEl();
  return t ? [...t.tBodies[0].querySelectorAll('tr.sched-row')] : [];
}

async function run() {
const { Store, Bids, Takeoff, Proposal, RateLib, Catalog, App, Nav, BidGrid,
        Project, Settings, Assign, Products, History, Schedule, Rates, TakeoffModel: M, UI, U,
        Report, BidsReport } = win;

console.log('--- boot ---');
check('store initialised', !!Store.db);
check('seed bids loaded (93)', Store.db.bids.length === 93, String(Store.db.bids.length));
check('catalog seeded (60 parts)', Catalog.all().length === 60, String(Catalog.all().length));
check('13 proposal styles present', Object.keys(win.PROPOSAL_STYLES).length === 13,
  String(Object.keys(win.PROPOSAL_STYLES).length));
// The original nine are what proposals already sent to clients were printed
// under. They are frozen: no typeface key, so they render exactly as before.
check('the original nine are untouched by the typeset themes',
  [1, 2, 3, 4, 5, 6, 7, 8, 9].every(i => win.PROPOSAL_STYLES[i].docFont === undefined),
  [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(i => win.PROPOSAL_STYLES[i].docFont).join(','));
check('and the four typeset ones each name a typeface',
  [10, 11, 12, 13].every(i => !!win.PROPOSAL_STYLES[i].docFont),
  [10, 11, 12, 13].map(i => win.PROPOSAL_STYLES[i].docFont).join(','));
check('KPI total rendered', U.$('kpiTotal').textContent === '93', U.$('kpiTotal').textContent);

/* A FRESH DATABASE HAS NOTHING ON ACTIVE BIDS, and that is correct: the seed is
   an intake register, and a bid reaches the working list when somebody picks it
   up (see the schema 15 note in js/store.js). Most of what follows exercises the
   working list, so the fixture puts the register on it - the flag directly,
   rather than through Bids.addToActive, which would issue ninety-three proposal
   numbers and write ninety-three history entries that the later tests would then
   have to read around. Promotion itself is tested where it belongs. */
check('a fresh database lists nothing as active - nobody has picked anything up',
  Store.db.bids.every(b => !b.active));
Store.db.bids.forEach(b => { b.active = true; });
Bids.filterTable();
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
/* The template supplies the group and nothing inside it. A product used to
   arrive with its whole workbook sheet laid out - fifteen columns on Steel
   Guardrail - of which a job uses three or four, so the estimator's first act
   was deleting eleven. Every column is typed now. */
check('but its drawing grid starts empty', prod.groups[0].grid.columns.length === 0,
  String(prod.groups[0].grid.columns.length));

// Built the way the office builds it, through the same entry point the form
// uses. The inch marks matter: the TK("...") escaping below is tested on them.
Takeoff.setTab('grid');
Takeoff.addCol('Top Rail_1-1/2" Pipe', 'LF');
check('a typed column lands on the grid',
  prod.groups[0].grid.columns.length === 1 &&
  prod.groups[0].grid.columns[0].label === 'Top Rail_1-1/2" Pipe' &&
  prod.groups[0].grid.columns[0].um === 'LF',
  JSON.stringify(prod.groups[0].grid.columns[0]));
check('and the first one brings a drawing reference with it, to type into',
  prod.groups[0].grid.rows.length === 1, String(prod.groups[0].grid.rows.length));
// A heading pasted with its unit in it keeps the unit and loses the brackets.
Takeoff.addCol('Base Plate (EA)', 'LF');
check('a unit typed into the name wins over the picker',
  prod.groups[0].grid.columns[1].label === 'Base Plate' &&
  prod.groups[0].grid.columns[1].um === 'EA',
  JSON.stringify(prod.groups[0].grid.columns[1]));
check('a column with no name is refused',
  (Takeoff.addCol('   ', 'LF'), prod.groups[0].grid.columns.length === 2),
  String(prod.groups[0].grid.columns.length));
prod.groups[0].grid.columns.length = 1;      // back to the one the rest of this file uses
prod.groups[0].grid.rows = [];

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

/* ---- drawing scopes -> order quantities --------------------------------- *
 *
 * The arithmetic an estimator used to do on a calculator: what the drawings
 * came to, divided by what a vendor sells it in, rounded up to whole items.
 * Built on a product of its own so the Lancaster figures above are untouched.
 */
console.log('\n--- scopes, stock sizes and order quantities ---');
{
  const p2 = M.newProduct('Steel Guardrail', t);
  // The same scope measured in two groups. Two columns, one name, one order.
  p2.groups = [M.newGroup('Run A', ['Top Rail']), M.newGroup('Run B', ['Top Rail'])];
  p2.groups[0].grid.columns[0].um = 'LF';
  p2.groups[1].grid.columns[0].um = 'LF';
  p2.groups[0].grid.rows = [{ ref: '1/A', values: { [p2.groups[0].grid.columns[0].key]: 300 } }];
  p2.groups[1].grid.rows = [{ ref: '2/A', values: { [p2.groups[1].grid.columns[0].key]: 200 } }];

  const scopes = M.productScopes(p2);
  check('two columns of one name are one scope', scopes.length === 1, String(scopes.length));
  check('and it totals across every group of the product',
    M.scopeTotal(p2, scopes[0].key) === 500, String(M.scopeTotal(p2, scopes[0].key)));
  check('a scope on another product is not counted in',
    M.scopeTotal(prod, scopes[0].key) === null,
    String(M.scopeTotal(prod, scopes[0].key)));

  // Measuring something is asking to buy it.
  const added = M.syncScopeRows(p2);
  check('a measured scope gets a material row without being asked', added.length === 1,
    String(added.length));
  check('named after the scope, in the Features column', added[0].feature === 'Top Rail',
    added[0].feature);
  check('and running it again does not add a second',
    M.syncScopeRows(p2).length === 0);

  const stick = added[0];
  const grpA = p2.groups[0];
  check('with no stock size, the order is the measurement rounded up',
    M.orderQty(stick, grpA, p2) === 500, String(M.orderQty(stick, grpA, p2)));

  stick.packQty = 21; stick.packUm = 'LF'; stick.unitCost = 96.73;
  check('500 LF at 21 LF a stick is 24 sticks',
    M.orderQty(stick, grpA, p2) === 24, String(M.orderQty(stick, grpA, p2)));
  check('and the row is costed on what is bought, not what is needed',
    Math.abs(M.itemTotal(stick, grpA, p2) - 24 * 96.73) < 0.005,
    String(M.itemTotal(stick, grpA, p2)));

  // The other way a vendor quotes: by the foot rather than by the stick.
  stick.costBasis = 'unit';
  check('priced per unit, the cost follows what the job needs',
    Math.abs(M.itemTotal(stick, grpA, p2) - 500 * 96.73) < 0.005,
    String(M.itemTotal(stick, grpA, p2)));
  stick.costBasis = 'pack';

  // Packets, not lengths - the same division, a different word for it.
  const keyB = p2.groups[1].grid.columns[0].key;
  p2.groups[1].grid.rows[0].values[keyB] = null;          // 300 measured in all
  p2.groups[0].grid.rows[0].values[p2.groups[0].grid.columns[0].key] = 250;
  stick.packQty = 100;
  check('250 of something 100 to a packet is 3 packets',
    M.orderQty(stick, grpA, p2) === 3, String(M.orderQty(stick, grpA, p2)));
  p2.groups[0].grid.rows[0].values[p2.groups[0].grid.columns[0].key] = 300;
  p2.groups[1].grid.rows[0].values[keyB] = 200;
  stick.packQty = 21;

  check('a unit mismatch is reported',
    (stick.packUm = 'EA', !!M.unitMismatch(stick, grpA, p2)));
  check('but not enforced - the order quantity still comes out',
    M.orderQty(stick, grpA, p2) === 24);
  stick.packUm = 'LF';

  // Deleting the column must not delete the costed line it was feeding.
  p2.groups[1].grid.columns = [];
  check('a scope measured in one group still totals from the other',
    M.scopeTotal(p2, stick.scopeKey) === 300, String(M.scopeTotal(p2, stick.scopeKey)));
  p2.groups[0].grid.columns = [];
  check('and losing the last column leaves the row, not a silent zero',
    p2.groups[0].items.indexOf(stick) >= 0 &&
    M.orderQty(stick, grpA, p2) === null &&
    /scope/i.test(M.itemQtyError(stick, grpA, p2) || ''),
    M.itemQtyError(stick, grpA, p2));
}

/* ---- typing over the order quantity ------------------------------------- *
 *
 * The division is right and the answer is still sometimes wrong - a stick on
 * the shelf, a vendor minimum, two offcuts that will cover the run. The typed
 * figure has to win without the measurement behind it being thrown away.
 */
console.log('\n--- an order quantity typed over the calculation ---');
{
  /* Really in the takeoff, unlike the scope fixture above: the assertions here
     go through Takeoff.setOrderQty, which resolves the row from whatever the
     pane is currently showing. Taken out again at the end of the block so the
     proposal figures further down are the ones the workbook has. */
  const p3 = M.newProduct('Steel Guardrail', t);
  t.products.push(p3);
  p3.groups = [M.newGroup('Run', ['Top Rail'])];
  const gr = p3.groups[0];
  gr.grid.columns[0].um = 'LF';
  gr.grid.rows = [{ ref: '1/A', values: { [gr.grid.columns[0].key]: 76.9 } }];
  M.syncScopeRows(p3);
  const it3 = gr.items[0];
  it3.packQty = 21; it3.packUm = 'LF'; it3.unitCost = 100;

  check('the calculation stands until it is argued with',
    M.orderQty(it3, gr, p3) === 4 && it3.orderQtyOverride == null,
    String(M.orderQty(it3, gr, p3)));
  /* The no-migration claim, asserted: a row shaped the way every row already
     in the database is shaped - with no orderQtyOverride key at all - costs
     exactly what it did before this feature existed. */
  const legacy = { id: 'old', qty: 7, um: 'EA', unitCost: 10, qtyMode: 'manual' };
  check('a row with no override key at all behaves as it always did',
    !('orderQtyOverride' in legacy) &&
    M.orderQty(legacy, gr, p3) === 7 && M.itemTotal(legacy, gr, p3) === 70 &&
    M.orderQtyStale(legacy, gr, p3) === null,
    String(M.orderQty(legacy, gr, p3)));

  win.Takeoff.selectProduct(p3.id);
  win.Takeoff.selectGroup(p3.id, gr.id);
  win.Takeoff.setOrderQty(it3.id, '3');
  check('a typed quantity wins', M.orderQty(it3, gr, p3) === 3, String(M.orderQty(it3, gr, p3)));
  check('but the calculation is still there underneath',
    M.computedOrderQty(it3, gr, p3) === 4, String(M.computedOrderQty(it3, gr, p3)));
  check('and the row is costed on what was typed',
    M.itemTotal(it3, gr, p3) === 300, String(M.itemTotal(it3, gr, p3)));
  /* The distinction the stale flag turns on: a typed 3 differing from a
     calculated 4 is not staleness, it is the override doing its job. Saying so
     on every render would be the row reciting the decision back at whoever
     just made it. */
  check('typing over the calculation is not by itself reported as stale',
    M.orderQtyStale(it3, gr, p3) === null, JSON.stringify(M.orderQtyStale(it3, gr, p3)));
  check('a row nobody typed over is never stale',
    M.orderQtyStale(M.newItem({ qty: 2 }), gr, p3) === null);
  check('nor is one overridden before the app recorded what it computed at the time',
    M.orderQtyStale({ orderQtyOverride: 3, qtyMode: 'manual', qty: 1 }, gr, p3) === null);

  // Re-measure the drawing underneath the typed figure: 76.9 -> 97.9 LF, which
  // is 5 sticks where it was 4 when the 3 was typed.
  gr.grid.rows[0].values[gr.grid.columns[0].key] = 97.9;
  const stale = M.orderQtyStale(it3, gr, p3);
  check('re-measuring leaves the typed number alone', M.orderQty(it3, gr, p3) === 3);
  check('and reports that the ground moved, with both figures',
    stale && stale.typed === 3 && stale.was === 4 && stale.computes === 5, JSON.stringify(stale));

  // Retyping resets what the number was decided against, so an accepted figure
  // does not go on reporting the move that prompted it.
  win.Takeoff.setOrderQty(it3.id, '7');
  check('retyping the override takes the current calculation as its new baseline',
    it3.orderQtyBase === 5 && M.orderQtyStale(it3, gr, p3) === null,
    String(it3.orderQtyBase));

  win.Takeoff.setOrderQty(it3.id, '2.4');
  check('a fraction of a stick is rounded up, not ordered',
    it3.orderQtyOverride === 3, String(it3.orderQtyOverride));

  /* Blank means "go back to the calculation", never "order none of it". */
  win.Takeoff.setOrderQty(it3.id, '');
  check('blanking the box restores the calculation rather than ordering zero',
    it3.orderQtyOverride === undefined && M.orderQty(it3, gr, p3) === 5,
    JSON.stringify([it3.orderQtyOverride, M.orderQty(it3, gr, p3)]));

  win.Takeoff.setOrderQty(it3.id, '9');
  win.Takeoff.clearOrderQty(it3.id);
  check('and so does the undo arrow', M.orderQty(it3, gr, p3) === 5);

  win.Takeoff.setTab('materials');
  const matHtml = U.$('section-takeoff').innerHTML;
  check('the Order Qty is an editable field, not a label',
    new RegExp('<input[^>]*id="ord-' + it3.id + '"').test(matHtml), 'no ord- input found');
  win.Takeoff.setOrderQty(it3.id, '3');            // decided against a computed 5
  win.Takeoff.render();
  check('and once typed over it is marked as such, with a way back',
    /bg-warn-soft[^"]*border-warn/.test(U.$('section-takeoff').innerHTML) &&
    /Takeoff.clearOrderQty/.test(U.$('section-takeoff').innerHTML));
  check('with nothing said about the drawings while they have not moved',
    !/now computes/.test(U.$('section-takeoff').innerHTML));
  gr.grid.rows[0].values[gr.grid.columns[0].key] = 130;   // 130/21 -> 7
  win.Takeoff.render();
  check('and the note appearing only once they do',
    /now computes 7/.test(U.$('section-takeoff').innerHTML));

  // Put the takeoff back as it was - the proposal assertions below compare
  // against the workbook's own figures.
  t.products = t.products.filter(p => p !== p3);
  win.Takeoff.selectProduct(prod.id);
}

/* ---- documents, and the drawing references that open them ---------------- */
console.log('\n--- documents and drawing-reference links ---');
{
  check('https passes the URL guard', U.safeUrl('https://onedrive.live.com/x.pdf') ===
    'https://onedrive.live.com/x.pdf');
  check('so does http, and surrounding space is trimmed',
    U.safeUrl('  http://a.b/c  ') === 'http://a.b/c');
  // The whole reason the helper exists: escaping quotes does nothing to a
  // scheme, and every one of these would otherwise be a live href.
  [['javascript:alert(1)', 'javascript'], ['JaVaScRiPt:alert(1)', 'mixed case'],
   ['data:text/html,<script>x</script>', 'data:'], ['  javascript:alert(1)', 'padded'],
   ['java\nscript:alert(1)', 'newline-split'], ['mailto:a@b.c', 'mailto'],
   ['example.com', 'no scheme'], ['', 'blank'], [null, 'null'], ['https://', 'scheme only']]
    .forEach(([bad, what]) => {
      check(`${what} is refused as a link`, U.safeUrl(bad) === null, String(U.safeUrl(bad)));
    });

  const tk = M.newTakeoff(null);
  check('a takeoff has an empty document list on first read',
    Array.isArray(M.documents(tk)) && M.documents(tk).length === 0);

  const drawings = M.newDocument({ name: 'Shell Drawings', url: 'https://onedrive.live.com/d1' });
  const addendum = M.newDocument({ name: 'Addendum 2', url: 'https://onedrive.live.com/d2',
    category: 'Addendum' });
  M.documents(tk).push(drawings, addendum);
  tk.drawingDocId = drawings.id;

  const rowA = { ref: '1/A', values: {} };
  const rowB = { ref: '2/A', values: {}, docId: addendum.id };
  const rowC = { ref: '3/A', values: {}, docId: 'doc_gone' };
  tk.products = [{ id: 'p', type: 'X', groups: [{ id: 'g', items: [],
    grid: { columns: [], rows: [rowA, rowB, rowC] } }] }];

  check('a reference with no document of its own follows the drawing set',
    M.docForRow(tk, rowA) === drawings);
  check('one that names a document opens that instead',
    M.docForRow(tk, rowB) === addendum);
  check('and one naming a document that is gone resolves to nothing, not a broken link',
    M.docForRow(tk, rowC) === null);

  check('the drawing set counts the references that follow it',
    M.docRefCount(tk, drawings.id) === 1, String(M.docRefCount(tk, drawings.id)));
  check('and a document named outright counts its own',
    M.docRefCount(tk, addendum.id) === 1, String(M.docRefCount(tk, addendum.id)));

  // Unstarring must not leave references pointing at a document by accident.
  tk.drawingDocId = null;
  check('with nothing starred, a default-following reference resolves to nothing',
    M.docForRow(tk, rowA) === null);
  check('and the deleted-document row still does too', M.docForRow(tk, rowC) === null);
}

/* Nothing about a takeoff written before schema 16 may cost a penny more or
   less for having been opened. */
console.log('\n--- schema 16 leaves old takeoffs costing what they did ---');
{
  const old = {
    schemaVersion: 15,
    bids: [], catalog: [{ id: 'c1', vendor: 'Alro', partNo: 'X', um: 'EA', unitCost: 5 }],
    takeoffs: {
      t1: {
        id: 't1', project: {}, rollup: { miscPct: 5, taxPct: 7, roundMode: 'manual' },
        products: [{
          id: 'p1', type: 'Steel Guardrail', unit: 'LF', totalLF: 100,
          groups: [{
            id: 'g1', name: 'G',
            items: [{ id: 'i1', feature: 'Top Rail', qty: 7.5, um: 'EA',
                      unitCost: 12.5, qtyMode: 'manual' }],
            grid: { columns: [{ key: 'k1', label: 'Top Rail_1-1/2" Pipe (LF)' }],
                    rows: [{ ref: '1/A', values: { k1: 40 } }] }
          }],
          finish: { qty: null, unitCost: null, label: '' },
          labour: { engineering: { hrs: null, rate: null }, fabrication: { hrs: null, rate: null },
                    installation: { hrs: null, rate: null }, supervisor: { hrs: null, rate: null } },
          equipment: { forklift: { days: null, rate: null }, truck: { days: null, rate: null } },
          extras: [], markupPct: 25, overheadPct: 20, overrides: {},
          hiddenRows: {}, rowLabels: {}, rowUnits: {}, proposalRows: {}
        }]
      }
    }
  };
  const migrated = Store.migrate(JSON.parse(JSON.stringify(old)));
  const mp = migrated.takeoffs.t1.products[0];
  const mi = mp.groups[0].items[0];
  check('every material row gains the four new fields',
    mi.scopeKey === null && mi.packQty === null && mi.packUm === '' && mi.costBasis === 'pack',
    JSON.stringify({ s: mi.scopeKey, q: mi.packQty, u: mi.packUm, b: mi.costBasis }));
  check('the unit comes out of the column heading and into a field of its own',
    mp.groups[0].grid.columns[0].label === 'Top Rail_1-1/2" Pipe' &&
    mp.groups[0].grid.columns[0].um === 'LF',
    JSON.stringify(mp.groups[0].grid.columns[0]));
  check('a heading with no unit in it is left alone, and defaults to EA',
    (() => {
      const c = Store.splitColumnUnit('Base Plate (typ.)');
      return c.label === 'Base Plate (typ.)' && c.um === '';
    })());
  check('an old TK() formula still finds the column it was written against',
    M.gridSubtotals(mp.groups[0])['Top Rail_1-1/2" Pipe (LF)'] === 40,
    String(M.gridSubtotals(mp.groups[0])['Top Rail_1-1/2" Pipe (LF)']));
  check('a hand-typed quantity is NOT rounded up behind the estimator\'s back',
    M.orderQty(mi, mp.groups[0], mp) === 7.5, String(M.orderQty(mi, mp.groups[0], mp)));
  check('so the row costs exactly what it did before the upgrade',
    Math.abs(M.itemTotal(mi, mp.groups[0], mp) - 93.75) < 0.0001,
    String(M.itemTotal(mi, mp.groups[0], mp)));
  check('and every catalog part gains a stock-size field to fill in',
    migrated.catalog[0].packQty === null && migrated.catalog[0].packUm === '');
}

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
  /* Two header rows now: a band row grouping the three quantity pairs, then the
     headings themselves. The second is the one that has to line up with the
     cells, and reading both would count every heading twice. */
  const headRows = [...table.querySelectorAll('thead tr')];
  check('the quantity columns are banded, so the three U/M columns are told apart',
    headRows.length === 2 &&
    ['From Drawing Takeoff', 'Vendor Stock', 'Order']
      .every(b => headRows[0].textContent.includes(b)),
    headRows[0] ? headRows[0].textContent.trim() : 'no band row');
  const heads = [...headRows[headRows.length - 1].querySelectorAll('th')]
    .map(th => th.textContent.trim());
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

  /* The export itself is pulled apart in tests/estimate-xlsx.js, which unzips
     the workbook and reads its formulas. What matters here is that the wiring
     holds in a real browser: the template loaded with the page, the exporter
     found it, and the sheet the estimator sees on screen is the sheet that
     comes out of it. */
  check('the estimate template loaded with the page', !!win.ESTIMATE_TEMPLATE);
  const parts = unzipMem(win.Estimate.buildWorkbook(t));
  const guardrail = parts['xl/worksheets/sheet3.xml'];
  const cols = [...guardrail.matchAll(/<c r="[A-M]1"[^>]*><is><t[^>]*>([^<]*)</g)].map(m => m[1]);
  check('the exported sheet drops Options too', !cols.includes('Options'), cols.join('|'));
  /* The sheet's columns, stated rather than derived, because they are what
     every formula in productSheet addresses by letter - Qty is G and the line
     total is M, and a column inserted without moving those would write the
     arithmetic into the wrong cells.
     The workbook has always spelled the description heading "Desription". */
  check('and the exported sheet has the thirteen columns the formulas address',
    JSON.stringify(cols) === JSON.stringify(['Features', 'Vendor', 'Vendor Part No',
      'Desription', 'Length/PKT Qty', 'Stock U/M', 'Qty', 'U/M', 'Material', 'Grade',
      'Weight (lb)', 'Unit Cost', 'Total Cost']),
    cols.join('|'));
  /* The screen carries one pair the sheet does not: what the drawings measured.
     The sheet says that as the ROUNDUP formula in Qty, which points straight at
     the drawing grid's Sub Total - a column of its own would be the same number
     written twice. Everything else appears in both. */
  cols.filter(h => h !== 'Desription' && h !== 'Stock U/M').forEach(h => {
    check(`"${h}" is on the screen as well as in the workbook`, heads.includes(h),
      heads.join('|'));
  });
  check('and the screen adds the drawing-takeoff pair the sheet computes',
    heads.includes('Length/PKT Qty') &&
    heads.filter(h => h === 'U/M').length === 3, heads.join('|'));

  const anItem = prod.groups[0].items[0];
  check('a material description lands under the Desription heading',
    new RegExp('<c r="D\\d+"[^>]*><is><t[^>]*>' +
      anItem.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(guardrail),
    anItem.description);
  check('and a line total is a formula, not a frozen number',
    /<c r="M\d+"[^>]*><f>G\d+\*L\d+<\/f>/.test(guardrail));

  // Excel refuses a duplicate sheet name, and throws rather than renaming.
  const realType = t.products[0].type;
  if (t.products.length > 1) t.products[1].type = realType;   // force a clash
  const names = [...unzipMem(win.Estimate.buildWorkbook(t))['xl/workbook.xml']
    .matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1]);
  if (t.products.length > 1) t.products[1].type = realType + ' B';
  check('the workbook opens on the cost summary',
    names[1] === 'Project Cost Summary', names.join(','));
  check('a sheet per product, between the lookup sheets',
    names.length === t.products.length + 4, names.join(','));
  check('and no two sheets share a name',
    new Set(names.map(n => n.toLowerCase())).size === names.length, names.join(','));
  check('no sheet name is longer than Excel allows',
    names.every(n => n.length <= 31), names.join(','));

  // And the button itself, end to end: a builder nothing calls is not an
  // export. Store.downloadBlob is the last link, so it is watched rather than
  // replaced.
  const downloads = [];
  const realDownload = Store.downloadBlob;
  Store.downloadBlob = (blob, filename) => downloads.push({ blob, filename });
  Takeoff.exportWorkbook();
  Takeoff.exportProduct(prod.id);
  Store.downloadBlob = realDownload;
  check('Export XLSX hands a file to the browser',
    downloads.length === 2 && downloads.every(d => d.blob.size > 0),
    JSON.stringify(downloads.map(d => d.filename)));
  check('named for the project, and for the product on its own',
    /- Takeoff\.xlsx$/.test(downloads[0].filename) &&
    downloads[1].filename.includes(prod.type),
    downloads.map(d => d.filename).join(' | '));
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

console.log('\n--- what the logo sits on ---');
{
  /* A logo drawn on white needs a white card on a dark style; one drawn in
     white on transparent needs a dark card on a light one. Three answers, not
     the boolean this replaced. */
  Proposal.setLogoFrame('white');
  check('the choice is kept with the company details',
    prop.companyData.logoFrame === 'white', prop.companyData.logoFrame);
  check('and becomes the shop default, so the next proposal starts there',
    Store.db.company.logoFrame === 'white', String(Store.db.company.logoFrame));

  Proposal.setLogoFrame('black');
  check('black is a choice too', prop.companyData.logoFrame === 'black');
  Proposal.setLogoFrame('none');
  check('as is nothing at all', prop.companyData.logoFrame === 'none');
  check('a value that is not one of the three is refused',
    (Proposal.setLogoFrame('chartreuse'), prop.companyData.logoFrame === 'none'),
    prop.companyData.logoFrame);

  check('each one paints something different behind the logo',
    Proposal.LOGO_FRAMES.white.card !== Proposal.LOGO_FRAMES.black.card &&
    Proposal.LOGO_FRAMES.none.card === '' &&
    /bg-white/.test(Proposal.LOGO_FRAMES.white.card) &&
    /bg-slate-950/.test(Proposal.LOGO_FRAMES.black.card),
    JSON.stringify(Proposal.LOGO_FRAMES.black));

  // A document saved before this existed - or one written by the v3 app these
  // templates are shared with - carries only the boolean.
  delete prop.companyData.logoFrame;
  prop.frameLogo = true;
  check('an older proposal still frames its logo in white',
    Proposal.logoFrame(prop) === 'white', Proposal.logoFrame(prop));
  prop.frameLogo = false;
  check('and one saved without the frame still has none',
    Proposal.logoFrame(prop) === 'none', Proposal.logoFrame(prop));

  Proposal.setLogoFrame('black');
  check('the choice wins over the old boolean once it is made',
    Proposal.logoFrame(prop) === 'black', Proposal.logoFrame(prop));
  check('and the boolean is kept in step for anything still reading it',
    prop.frameLogo === true, String(prop.frameLogo));
  Proposal.setLogoFrame('white');
}

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

console.log('\n--- the proposal entry in the row menu ---');
App.switchTab('active');
Bids.filterTable();
{
  // The takeoff and proposal controls are menu entries now rather than icons
  // sitting on the row, so the menu is where they have to be looked for.
  const withProposal = Store.db.bids.find(b => b.proposalId && Store.db.proposals[b.proposalId]);
  check('a bid with a proposal offers to open it',
    /Proposal\.open\(/.test(Bids.rowMenu(withProposal)), 'no open call');
  const noTakeoff = { id: 99002, project: 'No takeoff', status: 'In Progress' };
  const menu = Bids.rowMenu(noTakeoff);
  check('a bid with neither is offered no proposal entry at all',
    !/Proposal\./.test(menu), menu);
  check('but it is still offered the takeoff that would produce one',
    /Takeoff\.openForBid/.test(menu), menu);
  check('a bid with a takeoff but no proposal offers to generate one', (() => {
    const b = Store.db.bids.find(x => x.takeoffId && !x.proposalId);
    return !b || /generateFromTakeoff/.test(Bids.rowMenu(b));
  })());
  check('and the row itself is just the one menu button',
    (Bids.actionCell(withProposal).match(/<button|<a /g) || []).length === 1,
    Bids.actionCell(withProposal));
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

console.log('\n--- all 13 styles render ---');
let styleOK = true;
for (let i = 1; i <= 13; i++) {
  Proposal.set('selectedStyle', i);
  const h = U.$('proposalDoc').innerHTML;
  if (!h || h.length < 800 || /undefined/.test(h)) {
    styleOK = false;
    console.log('    style ' + i + ' produced ' + (h ? h.length : 0) + ' chars' +
      (/undefined/.test(h) ? ' and contains "undefined"' : ''));
  }
}
check('every style renders without "undefined" class strings', styleOK);

/* THE PAGINATOR IS THE RISK WITH A NEW TYPEFACE.
   Page breaks are measured against a probe page, so the probe has to be set in
   the same face as the sheets - otherwise the breaks land in the wrong places
   and blocks go missing or get printed twice. This checks the invariant that
   matters on every theme: the same scope items come out the other side, once
   each, however the document is dealt into pages. */
{
  const expected = Store.db.proposals[Proposal.currentId()].scopeItems.length;
  let paginationOK = true;
  for (let i = 1; i <= 13; i++) {
    Proposal.set('selectedStyle', i);
    const doc = U.$('proposalDoc');
    const pages = doc.querySelectorAll('.doc-page:not(.doc-probe)');
    const rows = doc.querySelectorAll('.doc-page:not(.doc-probe) .scope-row');
    if (!pages.length || rows.length !== expected) {
      paginationOK = false;
      console.log('    style ' + i + ': ' + pages.length + ' page(s), ' +
        rows.length + ' scope rows, expected ' + expected);
    }
  }
  check('every style paginates without losing or duplicating a scope item',
    paginationOK);

  // And the typeset themes really do carry their class onto the sheets, which
  // is what makes the probe and the pages agree in the first place.
  Proposal.set('selectedStyle', 10);
  check('a typeset theme sets its typeface on every page',
    [...U.$('proposalDoc').querySelectorAll('.doc-page')]
      .every(el => el.classList.contains('doc-serif')),
    U.$('proposalDoc').querySelector('.doc-page').className);
  Proposal.set('selectedStyle', 1);
  check('and an original theme sets none',
    ![...U.$('proposalDoc').querySelectorAll('.doc-page')]
      .some(el => /doc-(serif|tech|modern|lancaster)/.test(el.className)));
}

/* THE LANCASTER THEME'S ONE RULE: Inter for structure, Segoe UI for everything
   a person reads, and the monospace for money only. Checked at the two places
   it went wrong - the letterhead used three faces in four lines, and the
   details grid set the proposal number in the monospace while the project name
   beside it was not.

   The two are fixed at different layers on purpose. The details grid is fixed
   in the markup, because nothing but this theme ever wanted that distinction.
   The letterhead email is fixed in the theme's CSS, because themes 1-12 print
   it monospaced and documents already sent to clients were printed under them:
   taking the class off the element would rewrite those too. jsdom does not
   apply the linked stylesheet, so that half is asserted against app.css. */
{
  Proposal.set('selectedStyle', 13);
  const doc = U.$('proposalDoc');
  const mono = el => el && /\bfont-mono\b/.test(el.className);
  const appCss = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');

  check('no details-grid value is set apart in the monospace',
    ![...doc.querySelectorAll('.meta-value')].some(mono),
    [...doc.querySelectorAll('.meta-value')].map(e => e.className).join(' / '));
  check('so the project name and the proposal number match',
    new Set([...doc.querySelectorAll('.meta-value')].map(e => e.className)).size === 1);

  check('the letterhead name is not pulled into the heading face',
    /\.doc-lancaster \.lh-name \{[^}]*font-family: inherit/.test(appCss));
  check('and the email is not left in the monospace',
    /\.doc-lancaster \.lh-email \{[^}]*font-family: inherit/.test(appCss));
  check('while the themes that print it monospaced keep the class',
    mono(doc.querySelector('.lh-email')));

  // Money keeps the monospace: a column of figures that lines up on the digit
  // is the one thing it is for.
  check('but the prices and the total are still monospaced',
    mono(doc.querySelector('.scope-price')) && mono(doc.querySelector('.total-amount')));
}

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
// Schema 9 marks it active so the tab does not empty on upgrade; schema 15
// takes it back off, because a bid with no proposal number was never picked up.
check('a bid that predates promotion does not stay on the working list',
  fixed.bids[0].active === false, String(fixed.bids[0].active));
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

console.log('\n--- bids nobody picked up come off the working list (schema 15) ---');
{
  /* Migration 9 marked every record active so Active Bids would not empty on
     upgrade. It put the whole intake register on the working list; this takes
     back off it everything that has no sign of ever having been picked up. */
  const before = { schemaVersion: 14, bids: [
    { id: 1, project: 'Never picked up', status: 'Not Started',
      active: true, activatedAt: null, proposalNo: '',
      assignments: [{ id: 'a1', engineer: 'AF', estHrs: 4, asgnHrs: 0, days: [] }],
      history: [{ id: 'h1', kind: 'edit' }] },
    { id: 2, project: 'Picked up', status: 'Not Started',
      active: true, activatedAt: '2026-09-01', proposalNo: 'DIS-26-0001' },
    { id: 3, project: 'Won', status: 'Awarded',
      active: true, activatedAt: null, proposalNo: '',
      awardNo: 'DIS-26-0009', awardedAt: '2026-08-01' },
    { id: 4, project: 'Stamped but never numbered', status: 'Not Started',
      active: true, activatedAt: '2026-09-02', proposalNo: '' },
    // An award that was applied and later reversed leaves the date behind. The
    // status is what says whether a bid has an outcome, so this one has not.
    { id: 5, project: 'Award reversed', status: 'Not Started',
      active: true, activatedAt: '2026-09-02', proposalNo: '',
      awardNo: null, awardedAt: '2026-09-02' },
    { id: 6, project: 'Lost one', status: 'Lost',
      active: true, activatedAt: null, proposalNo: '' }
  ] };
  const after = Store.migrate(JSON.parse(JSON.stringify(before)));
  const bid = n => after.bids.filter(b => b.id === n)[0];

  check('a bid with no proposal number comes off the working list',
    bid(1).active === false, String(bid(1).active));
  check('but keeps everything on it - nothing is deleted',
    bid(1).assignments.length === 1 && bid(1).assignments[0].estHrs === 4 &&
    bid(1).history.length === 1, JSON.stringify(bid(1).assignments));
  check('one that was picked up stays, with its date',
    bid(2).active === true && bid(2).activatedAt === '2026-09-01', String(bid(2).active));
  check('a decided bid is never quietly taken off a list',
    bid(3).active === true, String(bid(3).active));
  check('an activation date without a number is not enough on its own',
    bid(4).active === false, String(bid(4).active));
  check('and that date is cleared, so picking it up later is a fresh promotion',
    bid(4).activatedAt === null, String(bid(4).activatedAt));
  check('a stale award date does not count as an outcome - the status does',
    bid(5).active === false, String(bid(5).active));
  check('and a Lost bid stays, because Lost is an outcome',
    bid(6).active === true, String(bid(6).active));
  check('running it again does not put anything back',
    Store.migrate(JSON.parse(JSON.stringify(after))).bids
      .filter(b => b.active).map(b => b.id).join(',') === '2,3,6',
    Store.migrate(JSON.parse(JSON.stringify(after))).bids
      .filter(b => b.active).map(b => b.id).join(','));
}

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
// The hidden native <input type="date"> is gone: it was only ever there to
// borrow the browser's calendar, which renders in the browser's locale order
// and so disagreed with the field in front of it. See js/datepicker.js.
check('no native date input is left to disagree with the field',
  !U.$('mDueDate__picker') &&
  !win.document.querySelector('input[type="date"]'),
  String(win.document.querySelectorAll('input[type="date"]').length));

console.log('\n--- the calendar ---');
{
  const DP = win.DatePicker;

  // The arithmetic first: 42 cells, whole weeks, Sunday-first.
  const g = DP.grid('2026-02-10');
  check('a month is six whole weeks, so nothing jumps as you page',
    g.length === 42, String(g.length));
  check('starting on a Sunday',
    win.U.parseDate(g[0].date).getDay() === 0, g[0].date);
  check('February 2026 has 28 days of its own',
    g.filter(c => !c.outside).length === 28,
    String(g.filter(c => !c.outside).length));
  check('and February 2028 has 29 - a leap year is not special-cased anywhere',
    DP.grid('2028-02-10').filter(c => !c.outside).length === 29,
    String(DP.grid('2028-02-10').filter(c => !c.outside).length));
  check('the days past the end belong to the next month and say so',
    g[41].outside && !g[27].outside, g[27].date + ' / ' + g[41].date);
  // May 2026 starts on a Friday, so it has a leading run from April.
  const may = DP.grid('2026-05-10');
  check('and the days before the start belong to the previous one',
    may[0].outside && may[0].date === '2026-04-26', may[0].date);
  check('weekends are known', g[0].weekend && g[6].weekend && !g[1].weekend);

  // Paging a month off the 31st must not skip one.
  check('a month forward from the 31st lands in the next month, not the one after',
    DP.shiftMonths('2026-01-31', 1) === '2026-02-28',
    DP.shiftMonths('2026-01-31', 1));
  check('and a month back from the 31st does the same',
    DP.shiftMonths('2026-03-31', -1) === '2026-02-28',
    DP.shiftMonths('2026-03-31', -1));

  // Now against a real field.
  const field = U.$('mDueDate');
  field.value = '02-10-2026';
  U.openDatePicker('mDueDate');
  check('it opens', DP.isOpen());
  const pop = win.document.body.lastElementChild;
  check('with the month it is pointed at',
    /February 2026/.test(pop.textContent), pop.textContent.slice(0, 40));
  check('and a button per cell', pop.querySelectorAll('[data-date]').length === 42);
  check('the current value is the selected day',
    pop.querySelector('[data-date="2026-02-10"]').className.indexOf('bg-brand') >= 0);

  // Picking writes MM-DD-YYYY to the field and fires the change everything
  // else in the app already listens for.
  let fired = 0;
  field.addEventListener('change', () => { fired++; });
  pop.querySelector('[data-date="2026-02-18"]').click();
  check('picking a day fills the field the way round it reads',
    field.value === '02-18-2026', field.value);
  check('and fires change, so a typed date and a picked one arrive the same way',
    fired === 1, String(fired));
  check('and closes', !DP.isOpen());

  U.openDatePicker('mDueDate');
  win.document.body.lastElementChild.querySelector('[data-act="clear"]').click();
  check('Clear empties it', field.value === '', field.value);

  // Escape closes without touching the value.
  field.value = '03-03-2026';
  U.openDatePicker('mDueDate');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes and leaves the value alone',
    !DP.isOpen() && field.value === '03-03-2026', field.value);

  // The revised due date is chosen against the one it replaces.
  U.$('mDueDate').value = '03-03-2026';
  Bids.openRevisedDuePicker();
  const rev = win.document.body.lastElementChild;
  check('the revised-due calendar opens on the month it is moving from',
    /March 2026/.test(rev.textContent), rev.textContent.slice(0, 40));
  check('with the original date flagged, so the new one is chosen against it',
    !!rev.querySelector('[data-date="2026-03-03"] span'),
    rev.querySelector('[data-date="2026-03-03"]').innerHTML);
  DP.close();
  U.$('mDueDate').value = '';
  U.$('mRevisedDueDate').value = '';
}

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
  /border-danger/.test(U.$('mDueDate').className), U.$('mDueDate').className);
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

/* THE NAME OPENS THE PROJECT, AND NOTHING ELSE DOES. With the click on the
   whole row, every cell was a trapdoor: reading a figure or selecting a
   proposal number to copy threw the page away. */
{
  const row = gridRows()[0];
  check('the row itself is not a click target',
    !row.getAttribute('onclick'), String(row.getAttribute('onclick')));
  const opens = [...row.querySelectorAll('td')]
    .filter(td => /Project\.open/.test(td.getAttribute('onclick') || ''));
  check('exactly one cell opens the project', opens.length === 1, String(opens.length));
  check('and it is the one under the Project heading',
    [...row.querySelectorAll('td')].indexOf(opens[0]) === headLabels().indexOf('Project'),
    [...row.querySelectorAll('td')].indexOf(opens[0]) + ' vs ' + headLabels().indexOf('Project'));
  check('it is reachable and follows on Enter, like the link it is',
    opens[0].getAttribute('role') === 'link' && opens[0].tabIndex === 0 &&
    /openOnKey/.test(opens[0].getAttribute('onkeydown') || ''),
    opens[0].getAttribute('role') + '/' + opens[0].tabIndex);
}

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
  /warn/.test(U.$('mProductChips').innerHTML));
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

console.log('\n--- a popover can be scrolled ---');
{
  /* The dismiss-on-scroll listener is on the capture phase - it has to be, or a
     scroll inside the table body would never reach it - so it also saw scrolls
     inside the popover itself. Both scrollable lists in there are taller than
     their box, and reaching for the scrollbar closed the panel. */
  // The popover is body-mounted and is the last thing appended to it. Matching
  // on its classes alone would find one of the modals, which are also fixed and
  // z-50 and come first in the document.
  const popoverEl = () => {
    const last = win.document.body.lastElementChild;
    return last && last.classList.contains('z-50') && !last.id ? last : null;
  };
  const anchor = win.document.querySelector('[onclick="BidGrid.openColumns(event)"]');
  check('the column chooser has a control to open it', !!anchor);
  BidGrid.openColumns({ stopPropagation() {}, currentTarget: anchor });
  const panel = popoverEl();
  check('and it opens', !!panel && /Columns/.test(panel.textContent));

  const list = panel.querySelector('.overflow-y-auto');
  check('with a scrollable list of columns', !!list);
  list.dispatchEvent(new win.Event('scroll', { bubbles: true }));
  check('scrolling it leaves it open',
    !!popoverEl());

  win.document.body.dispatchEvent(new win.Event('scroll', { bubbles: true }));
  check('scrolling anything else still closes it',
    !popoverEl());
}

console.log('\n--- the page uses the whole screen ---');
{
  const html = fs.readFileSync(HTML, 'utf8');
  check('the shell is not capped at 1600px any more',
    !/max-w-\[1600px\]/.test(html));
  check('but keeps its edge padding, so nothing touches the window',
    (html.match(/px-4 sm:px-6 lg:px-8/g) || []).length === 4,
    String((html.match(/px-4 sm:px-6 lg:px-8/g) || []).length));
}

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
  // Job No. used to sit at index 2, so the Hrs pair has shifted left by one
  // now that it is gone. What matters is that they landed where Hrs was and
  // not appended after Actions, which is what BidGrid.cfg() would have done.
  check('the two new columns take the old Hrs position, not the end',
    g.order.indexOf('estHrs') === 3 && g.order.indexOf('assignedHrs') === 5,
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
  // v13: a project carries ONE number for its whole life, so the Job No.
  // column that used to sit here would have repeated Proposal No. exactly.
  // The layout chain has to take it out, or BidGrid.cfg() asks for a column
  // definition that no longer exists.
  check('Job No. is gone from every view',
    ['all', 'active', 'awarded'].every(v =>
      out.ui.grids[v].order.indexOf('awardNo') < 0 &&
      out.ui.grids[v].visible.indexOf('awardNo') < 0),
    ['all', 'active', 'awarded'].map(v => v + ':' + out.ui.grids[v].order.join('/')).join(' '));
  check('and so is LF, which was a takeoff figure on a bid register',
    ['all', 'active', 'awarded'].every(v =>
      out.ui.grids[v].order.indexOf('lf') < 0),
    out.ui.grids.active.order.join(','));
  // Every view is numbered, because Sr. No. is only the row's position.
  check('Sr. No. is on all three views',
    ['all', 'active', 'awarded'].every(v => out.ui.grids[v].visible.indexOf('sr') >= 0),
    ['all', 'active', 'awarded'].map(v => v + ':' + out.ui.grids[v].visible.join('/')).join(' '));

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
  // THE NUMBER IS ISSUED WHEN THE BID IS PICKED UP, NOT WHEN IT IS WON.
  // Start from a clean sequence: clear every number the run so far has handed
  // out, on both fields, or the assertions below chase a moving target.
  // `active` is deliberately left alone - the tests after this one read Active
  // Bids, and emptying it here would leave them with nothing to work on.
  Store.db.bids.forEach(x => {
    x.proposalNo = ''; x.awardNo = null; x.awardedAt = null;
  });

  check('a bid nobody has picked up has no number', !a.proposalNo, a.proposalNo);
  const first = Bids.issueProjectNo(a, '2026-03-04');
  check('the first project of the year is 0001', first === 'DIS-26-0001', first);
  check('and it is the proposal number, not a separate one',
    a.proposalNo === 'DIS-26-0001', a.proposalNo);
  const second = Bids.issueProjectNo(b2, '2026-11-30');
  check('the next project increments', second === 'DIS-26-0002', second);

  // A number that has been on paper must never move or be handed out twice.
  check('issuing again keeps the original number',
    Bids.issueProjectNo(a) === 'DIS-26-0001', a.proposalNo);

  // Awarding confirms the number the project already has; it does not mint one.
  check('awarding keeps the number the project was picked up under',
    Bids.applyAward(a, '2026-03-04') === 'DIS-26-0001', a.proposalNo);
  check('it also sets the status and the award date',
    a.status === 'Awarded' && a.awardedAt === '2026-03-04');
  a.status = 'Submitted';
  check('moving out of Awarded does not clear the number', a.proposalNo === 'DIS-26-0001');
  check('and re-awarding still does not renumber it',
    Bids.applyAward(a) === 'DIS-26-0001', a.proposalNo);

  check('the sequence restarts each year',
    Bids.nextProjectNo('2027-01-05') === 'DIS-27-0001', Bids.nextProjectNo('2027-01-05'));
  // Deleting the highest-numbered project must not free its number for reuse.
  const held = b2.proposalNo;
  b2.proposalNo = ''; b2.status = 'Submitted';
  check('a gap left by a deleted project is not refilled',
    Bids.nextProjectNo('2026-06-01') === 'DIS-26-0002', Bids.nextProjectNo('2026-06-01'));
  b2.proposalNo = held;

  // Numbers issued under the old scheme live in awardNo. Handing one of those
  // out again as a proposal number is the collision the rule exists to stop.
  const legacy = Store.db.bids.filter(x => x.id !== a.id && x.id !== b2.id)[0];
  legacy.awardNo = 'DIS-26-0009';
  check('a number already on paper as a job number is never reissued',
    Bids.nextProjectNo('2026-06-01') === 'DIS-26-0010', Bids.nextProjectNo('2026-06-01'));
  legacy.awardNo = null;

  // Picking a bid up is the one place a number is allocated. Put one back into
  // intake to do it with, and leave it active afterwards - which is where
  // addToActive itself ends up, so nothing downstream notices.
  const picked = Store.db.bids.filter(x =>
    !x.proposalNo && Bids.bucketOf(x) === 'open' && x.id !== a.id && x.id !== b2.id)[0];
  picked.active = false;
  picked.activatedAt = null;
  Bids.addToActive(picked.id);
  check('picking a bid up gives it its number',
    /^DIS-\d\d-\d{4}$/.test(picked.proposalNo), picked.proposalNo);
  const kept = picked.proposalNo;
  picked.active = false;
  Bids.addToActive(picked.id);
  check('and putting it back does not renumber it',
    picked.proposalNo === kept, picked.proposalNo);

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

  // The confirmation names the number the project is being won under. It is no
  // longer being issued here - the project has had it since it was picked up.
  const target = Store.db.bids.filter(x => Bids.bucketOf(x) === 'open')[0];
  const expected = target.proposalNo || Bids.nextProjectNo();
  Bids.promptDecision(target.id, 'Awarded');
  check('the confirmation is shown rather than awarding straight away',
    !U.$('decisionModal').classList.contains('hidden') && target.status !== 'Awarded');
  check('and it names the number it will be awarded under',
    U.$('decisionNumber').textContent === expected, U.$('decisionNumber').textContent);
  Bids.closeDecisionModal();
  check('cancelling leaves the bid alone',
    target.status !== 'Awarded' && !target.awardedAt);
  Bids.promptDecision(target.id, 'Awarded');
  Bids.confirmDecision();
  check('confirming awards it', target.status === 'Awarded' && !!target.proposalNo);
  check('under the number it already had, not a new one',
    target.proposalNo === expected, target.proposalNo);

  Bids.setView('active');
  check('an awarded bid drops off Active Bids',
    !Bids.baseList().some(x => x.id === target.id));
  Bids.setView('awarded');
  check('and appears on Awarded Bids with its number',
    Bids.baseList().some(x => x.id === target.id) &&
    new RegExp(target.proposalNo).test(gridHTML()));
  // Both working views are read by the project number, and it is the same
  // number on each - there is no separate job number any more.
  // Actions lead, frozen, so they are reachable without scrolling the
  // project name off the screen. The identity block follows.
  check('Awarded leads with Actions, Sr. No., then the project number',
    BidGrid.activeColumns().slice(0, 3).map(c => c.key).join(',') ===
      'actions,sr,proposalNo',
    BidGrid.activeColumns().map(c => c.key).join(','));
  Bids.setView('active');
  check('Active leads the same way',
    BidGrid.activeColumns().slice(0, 3).map(c => c.key).join(',') ===
      'actions,sr,proposalNo',
    BidGrid.activeColumns().map(c => c.key).join(','));
  check('and no view offers a Job No. column at all',
    !BidGrid.COLUMNS.some(c => c.key === 'awardNo'),
    BidGrid.COLUMNS.map(c => c.key).join(','));
}

console.log('\n--- a job the client brings back ---');
{
  Bids.setView('active');
  const job = Bids.baseList().filter(x => Bids.bucketOf(x) === 'open' && x.proposalNo)[0];

  /* ONLY A FINISHED JOB. Re-opening is for work that ran its course - we
     completed it, or we looked and found nothing in scope. A bid still being
     worked has nothing to re-open, and a decided one is not re-opened either:
     an Awarded job is a job, and a Lost one is a new enquiry. */
  job.status = 'In Progress';
  check('work in progress cannot be re-opened', !Bids.canReopen(job));
  job.status = 'Awarded';
  check('nor can a job we won', !Bids.canReopen(job));
  job.status = 'Lost';
  check('nor one we lost', !Bids.canReopen(job));
  job.status = 'Completed';
  check('a completed job can', Bids.canReopen(job));
  job.status = 'No Scope';
  check('and so can one we found no scope in', Bids.canReopen(job));
  job.status = 'Completed';

  // Two people on it, one of them finished, with hours booked and a takeoff.
  Assign.rows(job).slice().forEach(r => Assign.remove(job.id, r.id));
  Assign.add(job.id);
  const jr1 = Assign.rows(job).slice(-1)[0];
  Assign.set(job.id, jr1.id, 'engineer', 'AJP');
  Assign.set(job.id, jr1.id, 'taskType', 'Drawing Take-off');
  Assign.set(job.id, jr1.id, 'estHrs', '6');
  Assign.set(job.id, jr1.id, 'status', 'done');
  Assign.setDay(job.id, jr1.id, Assign.dayRows(jr1)[0].date, '9');
  Assign.add(job.id);
  const jr2 = Assign.rows(job).slice(-1)[0];
  Assign.set(job.id, jr2.id, 'engineer', 'SSJ');
  Assign.set(job.id, jr2.id, 'taskType', 'Estimating');

  const base = job.proposalNo;
  const wasPrice = job.price;
  const wasHistory = History.entries(job).length;
  job.takeoffId = job.takeoffId || 'some-takeoff';

  // The confirmation names the number before it issues it.
  Bids.promptDecision(job.id, 'ReOpen');
  check('the confirmation names the number the revision will carry',
    U.$('decisionNumber').textContent === base + '-R01',
    U.$('decisionNumber').textContent);
  Bids.closeDecisionModal();
  check('cancelling opens nothing', !job.reopenedInto &&
    !Store.db.bids.some(x => x.proposalNo === base + '-R01'));

  Bids.promptDecision(job.id, 'ReOpen');
  Bids.confirmDecision();
  const rev = Store.db.bids.filter(x => x.proposalNo === base + '-R01')[0];

  check('re-opening makes a second entry', !!rev && rev.id !== job.id);
  check('numbered off the original, not from the top of the sequence',
    rev.proposalNo === base + '-R01' && rev.revision === 1 && rev.revisionBase === base,
    rev.proposalNo + '/' + rev.revision);
  check('the first entry carries no revision number - it was just the job',
    !job.revision, String(job.revision));

  /* THE ORIGINAL IS THE RECORD OF WHAT WAS BID, AND IS LEFT ALONE. This is
     the whole reason for a second entry rather than an edit in place. */
  check('the finished entry keeps its status', job.status === 'Completed', job.status);
  check('and its price', job.price === wasPrice, String(job.price));
  check('and its takeoff', job.takeoffId === 'some-takeoff', String(job.takeoffId));
  check('and every task on it stays done',
    Assign.rows(job).some(r => Assign.isDone(r)));
  check('but it is marked as having been superseded',
    job.reopenedInto === rev.id, String(job.reopenedInto));

  /* THE NEW ENTRY: the same job and the same people, none of the work. */
  check('the revision opens today, on Active Bids',
    rev.activatedAt === U.today() && rev.active && rev.status === 'ReOpen',
    rev.activatedAt + '/' + rev.status);
  check('carrying the same project and products',
    rev.project === job.project &&
    JSON.stringify(rev.products) === JSON.stringify(job.products));
  check('and the same people on the same tasks',
    Assign.rows(rev).map(r => r.engineer + ':' + r.taskType).join(',') ===
      'AJP:Drawing Take-off,SSJ:Estimating',
    Assign.rows(rev).map(r => r.engineer + ':' + r.taskType).join(','));
  check('with the estimate of how long each takes',
    U.n(Assign.rows(rev)[0].estHrs) === 6, String(Assign.rows(rev)[0].estHrs));

  // WITHOUT ANY OF THE SCHEDULE. The old dates are weeks that have been and
  // gone; carrying them would book the new job into the past.
  check('nobody is booked any hours yet',
    Assign.rows(rev).every(r => U.n(r.asgnHrs) === 0),
    Assign.rows(rev).map(r => r.asgnHrs).join(','));
  check('and every task starts over, however finished it was last time',
    Assign.rows(rev).every(r => Assign.statusOf(r) === 'todo' && !r.completedAt),
    Assign.rows(rev).map(r => Assign.statusOf(r)).join(','));
  check('the days are fresh ones, not the ones already worked',
    Assign.rows(rev).every(r => Assign.dayRows(r).length === 3 &&
      Assign.dayRows(r).every(d => d.hrs == null && d.date >= U.today())),
    JSON.stringify(Assign.dayRows(Assign.rows(rev)[0])));

  // NOTHING PRICED AND NOTHING MEASURED - it is a re-bid.
  check('it starts unpriced rather than inheriting a figure nobody worked out',
    rev.price == null && !rev.priceLocked, String(rev.price));
  check('with no takeoff and no proposal of its own',
    !rev.takeoffId && !rev.proposalId);
  check('and no award carried across',
    !rev.awardNo && !rev.awardedAt && !rev.decidedAt);

  // BOTH ENDS OF THE CHAIN ARE WALKABLE.
  check('the revision knows what it came from',
    Bids.originalOf(rev) === job, String(rev.revisionOf));
  check('and the original knows what replaced it',
    Bids.reopenedOf(job) === rev, String(job.reopenedInto));

  // IT IS IN THE HISTORY, on both records.
  check('the original records that it was re-opened',
    History.entries(job).length === wasHistory + 1 &&
    History.entries(job).slice(-1)[0].to === 'reopened',
    History.entries(job).slice(-1)[0].to);
  check('naming the number it was re-opened as',
    /R01/.test(History.entries(job).slice(-1)[0].comment),
    History.entries(job).slice(-1)[0].comment);
  check('and the revision starts its own history rather than inheriting one',
    History.entries(rev).length === 1 && History.entries(rev)[0].kind === 'created',
    String(History.entries(rev).length));

  /* A RE-OPENED JOB CANNOT BE WALKED BACK A STAGE. There is a second record
     pointing at this one; moving it would leave that pointer aimed at a state
     the job never had. */
  check('the finished entry can no longer be reversed', !History.canReverse(job));

  // AND IT CANNOT BE RE-OPENED TWICE into two parallel Rev01s.
  check('nor re-opened a second time', !Bids.canReopen(job));
  Bids.promptDecision(job.id, 'ReOpen');
  check('asking again says so rather than opening another',
    U.$('decisionModal').classList.contains('hidden') &&
    Store.db.bids.filter(x => x.revisionBase === base).length === 1,
    String(Store.db.bids.filter(x => x.revisionBase === base).length));

  /* THE SECOND REVISION. Finish the Rev01 entry, re-open it, and it must
     become R02 - stripping its own suffix rather than stacking a second one. */
  rev.status = 'Completed';
  check('a finished revision can itself be re-opened', Bids.canReopen(rev));
  Bids.promptDecision(rev.id, 'ReOpen');
  Bids.confirmDecision();
  const rev2 = Store.db.bids.filter(x => x.proposalNo === base + '-R02')[0];
  check('the next time round is Rev02, not Rev01 again',
    !!rev2 && rev2.revision === 2, rev2 ? String(rev2.revision) : 'missing');
  check('numbered off the base rather than stacking suffixes',
    rev2.proposalNo === base + '-R02' && rev2.revisionBase === base,
    rev2.proposalNo);
  check('and the chain walks back one link at a time',
    Bids.originalOf(rev2) === rev && Bids.originalOf(rev) === job);

  // The number is the thing that tells the entries apart, so it is on the row.
  Bids.setView('active');
  Bids.filterTable();
  check('the table marks a revision so the two entries cannot be confused',
    /Rev02/.test(gridHTML()), 'no Rev02 in the grid');
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
    U.$('mProposalNo').classList.contains('border-danger'));

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
  Assign.set(b.id, r2.id, 'engineer', 'AF');       // same person, second task
  Assign.set(b.id, r2.id, 'taskType', 'Site measure');
  Assign.set(b.id, r2.id, 'estHrs', '6.5');

  // Assigned hours are booked against days now, and the row total is their
  // sum - so they go in through the day cells, not the total.
  const clearDays = r => Assign.dayRows(r).forEach(d =>
    Assign.setDay(b.id, r.id, d.date, ''));
  clearDays(r1); clearDays(r2);
  Assign.setDay(b.id, r1.id, Assign.dayRows(r1)[0].date, '4');
  Assign.setDay(b.id, r2.id, Assign.dayRows(r2)[0].date, '2');
  check('a row total is the sum of its day cells',
    r1.asgnHrs === 4 && r2.asgnHrs === 2, `${r1.asgnHrs}/${r2.asgnHrs}`);
  check('and the total cannot be written directly',
    (Assign.set(b.id, r1.id, 'asgnHrs', '99'), r1.asgnHrs === 4), String(r1.asgnHrs));

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
  // All Bids is an arrival register: nothing on it has been picked up, so
  // nothing on it has a number yet. It is read in the order things came in.
  check('All Bids shows Created where the number would be, not the number',
    BidGrid.activeColumns()[2].key === 'createdAt' &&
    !BidGrid.activeColumns().some(c => c.key === 'proposalNo'),
    BidGrid.activeColumns().map(c => c.key).join(','));
  check('and the working views show the number rather than Created',
    (Bids.setView('active'), BidGrid.activeColumns().some(c => c.key === 'proposalNo') &&
      !BidGrid.activeColumns().some(c => c.key === 'createdAt')),
    BidGrid.activeColumns().map(c => c.key).join(','));
  Bids.setView('all');
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
  check('the panel offers an editable field, not static text',
    U.$('regionList').innerHTML.includes('Bids.renameRegion'));

  /* A misspelled county is otherwise only fixable by deleting the entry, which
     strands the value on every bid already filed under it. */
  const filed = Store.db.bids[0];
  const wasRegion = filed.region;
  filed.region = 'Test County';
  Bids.renameRegion('Test County', 'Tested County');
  check('renaming a region updates the list',
    Store.db.regions.includes('Tested County') &&
    !Store.db.regions.includes('Test County'));
  check('and carries onto the bids filed under it',
    filed.region === 'Tested County', filed.region);
  check('without changing how many regions there are',
    Store.db.regions.length === regionsBefore + 1, String(Store.db.regions.length));

  // A case-only correction is the whole point - "beachwood, oh" to
  // "Beachwood, OH" - so it must not be refused as a duplicate of itself.
  Bids.renameRegion('Tested County', 'TESTED COUNTY');
  check('a case-only correction is accepted',
    Store.db.regions.includes('TESTED COUNTY'), JSON.stringify(
      Store.db.regions.filter(r => r.toLowerCase() === 'tested county')));
  check('and moves the bids with it, despite the casing',
    filed.region === 'TESTED COUNTY', filed.region);

  const clash = Store.db.regions.find(r => r !== 'TESTED COUNTY');
  Bids.renameRegion('TESTED COUNTY', clash.toLowerCase());
  check('renaming onto another region is refused',
    Store.db.regions.includes('TESTED COUNTY') &&
    Store.db.regions.filter(r => r.toLowerCase() === clash.toLowerCase()).length === 1);

  Bids.renameRegion('TESTED COUNTY', '   ');
  check('and clearing the field leaves the region alone',
    Store.db.regions.includes('TESTED COUNTY'));

  filed.region = wasRegion;
  Bids.removeRegion('TESTED COUNTY');
  check('and removed again', Store.db.regions.length === regionsBefore);

  App.switchTab('company');
  Settings.setCompany('phone', '(555) 010-0100');
  check('company details save', Store.db.company.phone === '(555) 010-0100');

  /* PORTALS: six <option> tags in the page until the office signed up to one
     that was not among them. A managed list now, like regions beside it. */
  App.switchTab('portals');
  check('the portals panel renders its list',
    !!U.$('portalList') && /PlanHub/.test(U.$('portalList').innerHTML));
  const portalsBefore = Store.db.portals.length;
  U.$('newPortal').value = 'Dodge';
  Settings.addPortal();
  check('a portal can be added', Store.db.portals.includes('Dodge') &&
    Store.db.portals.length === portalsBefore + 1);
  U.$('newPortal').value = 'dodge';
  Settings.addPortal();
  check('and a duplicate is refused whatever its casing',
    Store.db.portals.length === portalsBefore + 1, JSON.stringify(Store.db.portals));

  const pBid = Store.db.bids[0];
  const wasPortal = pBid.portal;
  pBid.portal = 'Dodge';
  Settings.renamePortal(Store.db.portals.indexOf('Dodge'), 'Dodge Construction');
  check('renaming a portal carries onto the bids filed under it',
    pBid.portal === 'Dodge Construction' &&
    Store.db.portals.includes('Dodge Construction'), pBid.portal);

  // The form reads the list rather than the markup.
  Bids.openAdd();
  const portalOpts = Array.from(U.$('mPortal').options).map(o => o.value);
  check('the bid form offers the list, not a hardcoded six',
    portalOpts.includes('Dodge Construction') && portalOpts.includes('PlanHub'),
    portalOpts.join(','));
  U.$('bidModal').classList.add('hidden');

  Settings.removePortal(Store.db.portals.indexOf('Dodge Construction'));
  check('removing a portal leaves the value on the bid that carries it',
    !Store.db.portals.includes('Dodge Construction') &&
    pBid.portal === 'Dodge Construction', pBid.portal);
  // A bid on a portal no longer in the list keeps it as an option of its own.
  Bids.edit(pBid.id);
  check('and that bid still shows its own portal on the form',
    U.$('mPortal').value === 'Dodge Construction', U.$('mPortal').value);
  U.$('bidModal').classList.add('hidden');
  pBid.portal = wasPortal;

  /* BID STATUSES: the seven the lifecycle is built on are facts; what a shop
     adds beside them is open work on Active Bids and nothing more. */
  App.switchTab('statuses');
  check('the statuses panel lists the built-ins as read-only',
    /built-in/.test(U.$('statusList').innerHTML) &&
    !/Settings.renameStatus/.test(U.$('statusList').innerHTML));
  U.$('newStatus').value = 'On Hold';
  Settings.pickTone('newStatusTone', 'warn');
  Settings.addStatus();
  const onHold = Store.db.statuses.filter(s => s.name === 'On Hold')[0];
  check('a status can be added, with its colour', !!onHold && onHold.tone === 'warn',
    JSON.stringify(Store.db.statuses));
  U.$('newStatus').value = 'completed';
  Settings.addStatus();
  check('and one that clashes with a built-in is refused',
    Store.db.statuses.length === 1, JSON.stringify(Store.db.statuses));

  check('a custom status is offered on the form',
    Bids.settableStatuses().some(s => s.key === 'On Hold'),
    Bids.settableStatuses().map(s => s.key).join(','));
  check('it is open work, so the bid stays on Active Bids and counts as open',
    Bids.bucketOf({ status: 'On Hold' }) === 'open' &&
    Bids.onActiveOf({ status: 'On Hold' }) === true);
  check('and it draws in the colour it was given',
    /status-tone-warn/.test(Bids.statusBadge('On Hold')), Bids.statusBadge('On Hold'));
  check('the Active Bids status filter offers it too',
    (Bids.setView('active'), Array.from(U.$('filterStatus').options)
      .some(o => o.value === 'On Hold')),
    Array.from(U.$('filterStatus').options).map(o => o.value).join(','));

  const sBid = Store.db.bids.filter(b => b.active)[0] || Store.db.bids[0];
  const wasStatus = sBid.status;
  sBid.status = 'On Hold';
  App.switchTab('statuses');
  Settings.renameStatus(0, 'Waiting on client');
  check('renaming a custom status carries onto the bids on it',
    sBid.status === 'Waiting on client' &&
    Store.db.statuses[0].name === 'Waiting on client', sBid.status);
  Settings.removeStatus(0);
  check('and removing it leaves those bids alone, still readable as open',
    !Store.db.statuses.length && sBid.status === 'Waiting on client' &&
    Bids.bucketOf(sBid) === 'open', sBid.status);
  sBid.status = wasStatus;

  // The sync half of this - that both copies of SETTING_KEYS name every shop
  // list - is checked in tests/sync.js, which has the server to compare with.

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

console.log('\n--- timestamps are IST, and the right day ---');
{
  // THE BUG THIS EXISTS FOR. 20:30 UTC is 02:00 the NEXT day in IST, so taking
  // the date off the front of the ISO string - which is what every reader used
  // to do - showed the previous day. For five and a half hours out of every
  // twenty-four, the Created column was simply wrong.
  const iso = '2026-09-06T20:30:00.000Z';
  check('an instant is read on the IST calendar, not the UTC one',
    U.stampDate(iso) === '09-07-2026', U.stampDate(iso));
  check('the naive slice it replaced gave the day before',
    U.date(iso.slice(0, 10)) === '09-06-2026', U.date(iso.slice(0, 10)));
  check('the time comes with it', U.stampTime(iso) === '02:00', U.stampTime(iso));
  check('and it says which clock it is on',
    U.stamp(iso) === '09-07-2026 02:00 IST', U.stamp(iso));

  // Fixed to Asia/Kolkata, not the machine. A laptop that has travelled must
  // not quietly restate when something happened.
  check('the same instant reads the same whatever the machine is set to',
    U.stamp(iso) === '09-07-2026 02:00 IST' &&
    U.stamp(new Date(iso)) === '09-07-2026 02:00 IST');

  // A due date is a calendar day, not an instant, and must never be shifted.
  check('a plain stored date is not put through a timezone',
    U.date('2026-07-22') === '07-22-2026', U.date('2026-07-22'));
  check('nothing renders a bare date as a moment', U.stamp('2026-07-22') !== '-');
  check('and rubbish still gives a dash',
    U.stamp('') === '-' && U.stamp('not a date') === '-' && U.stampDate(null) === '-');

  // The Created column carries both, and sorts on the raw ISO.
  Bids.setView('all');
  Bids.filterTable();
  const createdCol = BidGrid.COLUMNS.filter(c => c.key === 'createdAt')[0];
  const withStamp = { createdAt: iso };
  check('the Created cell shows the IST date and time',
    /09-07-2026/.test(createdCol.render(withStamp)) &&
    /02:00/.test(createdCol.render(withStamp)), createdCol.render(withStamp));
  check('it sorts on the raw ISO, which orders correctly as a string',
    createdCol.value(withStamp) === iso, createdCol.value(withStamp));
  check('and filters on what is actually on screen',
    createdCol.text(withStamp) === '09-07-2026', createdCol.text(withStamp));
  check('an inferred date shows no time it cannot vouch for',
    !/\d\d:\d\d/.test(createdCol.render({ createdAt: iso, createdAtInferred: true })),
    createdCol.render({ createdAt: iso, createdAtInferred: true }));
}

console.log('\n--- the newest bid is at the top ---');
{
  // Asserted on the Created column the grid actually rendered, on All Bids
  // where it is visible. Mapping rows back to bid records by project name does
  // not work here - seeded names repeat, which is why the duplicate-name
  // warning exists - so this reads the dates straight off the screen.
  Bids.setView('all');
  BidGrid.cfg().sort = null;
  Bids.filterTable();
  {
    const createdIdx = BidGrid.activeColumns().findIndex(c => c.key === 'createdAt');
    const cells = [...gridRows()].map(tr =>
      tr.querySelectorAll('td')[createdIdx].textContent.trim());
    // An observed arrival prints a time under the date; an inferred one is
    // prefixed with ~ and has none. Observed first, then the inferred backlog.
    // An observed arrival is the only one that prints a time under the date.
    // Everything else is backlog: a ~ guessed from the due date, or an em-dash
    // where even that was missing. Observed first, backlog after.
    const observed = cells.map(t => /\d\d:\d\d/.test(t));
    const firstBacklog = observed.indexOf(false);
    check('all: observed arrivals lead, the backlog follows',
      firstBacklog < 0 || !observed.slice(firstBacklog).some(Boolean),
      'row ' + firstBacklog + ': ' +
        cells.slice(0, 4).map(c => c.replace(/\s+/g, ' ')).join(' | '));
    check('and the observed ones run newest to oldest',
      cells.filter(t => !t.startsWith('~')).length >= 1);
  }

  // On the other two the column is hidden, so the invariant checked is the one
  // that matters: whatever the grid put first is the newest thing in the view.
  for (const view of ['active', 'awarded']) {
    Bids.setView(view);
    BidGrid.cfg().sort = null;
    Bids.filterTable();
    const list = Bids.baseList();
    if (list.length < 2) continue;
    const best = list.slice().sort((a, b) => {
      const ai = !!a.createdAtInferred, bi = !!b.createdAtInferred;
      if (ai !== bi) return ai ? 1 : -1;
      const at = String(a.createdAt || ''), bt = String(b.createdAt || '');
      return at === bt ? (b.id || 0) - (a.id || 0) : (at < bt ? 1 : -1);
    })[0];
    // textContent, not innerHTML: a project named "X & Y" is "X &amp; Y" in
    // the markup and would never match.
    check(view + ': the newest bid is the first row',
      gridRows()[0].textContent.indexOf(best.project) >= 0,
      best.project + '  |  got: ' + gridRows()[0].textContent.trim().slice(0, 60));
  }

  Bids.setView('all');
  BidGrid.cfg().sort = null;
  Bids.openAdd();
  U.$('mProject').value = 'Newest bid on the list';
  U.$('mPortal').value = 'PlanHub';
  U.$('mRegion').value = Store.db.regions[0];
  U.$('mStatus').value = 'Not Started';
  Bids.save({ preventDefault() {} });
  Bids.setView('all');
  Bids.filterTable();
  check('a bid just entered is the first row',
    /Newest bid on the list/.test(gridRows()[0].innerHTML),
    gridRows()[0].textContent.trim().slice(0, 60));

  // An explicit sort still wins, and clearing it comes back here rather than
  // dropping into seed order.
  BidGrid.toggleSort('project');
  const names = [...gridRows()].map(tr =>
    tr.querySelector('td:nth-child(4)').textContent.trim().split('\n')[0]);
  check('sorting by a column overrides it',
    names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0),
    names.slice(0, 3).join(' | '));
  BidGrid.toggleSort('project'); BidGrid.toggleSort('project');   // asc -> desc -> off
  check('and the third click returns to newest-first, not seed order',
    BidGrid.cfg().sort === null &&
    /Newest bid on the list/.test(gridRows()[0].innerHTML),
    gridRows()[0].textContent.trim().slice(0, 60));
}

console.log('\n--- a charge has a quantity and a unit ---');
{
  const tk = Store.db.takeoffs[Store.db.ui.lastTakeoffId] ||
             Store.db.takeoffs[Object.keys(Store.db.takeoffs)[0]];
  Takeoff.openTakeoff(tk.id);
  const p = tk.products[0];
  Takeoff.selectProduct(p.id);

  const baseline = M.computeTakeoff(tk).total;

  // A flat amount, which is what every charge already in the database is.
  Takeoff.addExtra();
  const flat = p.extras[p.extras.length - 1];
  Takeoff.setExtra(p.extras.length - 1, 'amount', '500');
  check('a flat amount still totals as itself',
    M.extraAmount(flat) === 500, String(M.extraAmount(flat)));

  // Quantity times unit price, which is what most of them actually are.
  Takeoff.addExtra();
  const i = p.extras.length - 1;
  const priced = p.extras[i];
  Takeoff.setExtra(i, 'label', 'Scissor lift');
  Takeoff.setExtra(i, 'qty', '2');
  Takeoff.setExtra(i, 'um', 'Wks');
  Takeoff.setExtra(i, 'unitPrice', '1000');
  check('a priced charge is qty x unit price',
    M.extraAmount(priced) === 2000, String(M.extraAmount(priced)));
  check('and keeps the unit it was quoted in', priced.um === 'Wks', priced.um);
  check('the flat amount is dropped once it is priced',
    priced.amount === null, String(priced.amount));

  // 500 flat + 2 x 1000 priced = 2500 of extras on this product.
  const calc = M.computeTakeoff(tk).products.find(x => x.product.id === p.id).calc;
  check('both charges reach the product extras total',
    calc.extrasTotal === 2500, String(calc.extrasTotal));
  const after = M.computeTakeoff(tk).total;
  check('and the takeoff total carries them, with markup on top',
    after > baseline + 2500, baseline + ' -> ' + after);

  // The unit on a standard row is the estimator's to set.
  check('a standard row starts on its default unit',
    M.rowUnit(p, 'supervisor') === 'Hrs', M.rowUnit(p, 'supervisor'));
  Takeoff.setRowUnit('supervisor', 'Wks');
  check('and can be changed', M.rowUnit(p, 'supervisor') === 'Wks', M.rowUnit(p, 'supervisor'));
  check('storing only the exception',
    p.rowUnits.supervisor === 'Wks' && p.rowUnits.forklift === undefined,
    JSON.stringify(p.rowUnits));
  Takeoff.setRowUnit('supervisor', '');
  check('clearing it puts the default back',
    M.rowUnit(p, 'supervisor') === 'Hrs' && p.rowUnits.supervisor === undefined,
    M.rowUnit(p, 'supervisor'));

  // Cleanup so the proposal totals later in the run are not thrown off.
  p.extras.splice(p.extras.length - 2, 2);
  Takeoff.render();
}

console.log('\n--- editing a field where you are reading it ---');
{
  Bids.setView('active');
  const b = Bids.baseList().filter(x => Bids.bucketOf(x) === 'open')[0];
  Project.openFrom(b.id, 'active');
  Project.render();

  const host = () => [...win.document.querySelectorAll('#section-project [data-edit]')]
    .find(el => JSON.parse(el.dataset.edit).field === 'price');

  check('a typed field is marked editable', !!host(), 'no price field');
  check('a computed one is not',
    ![...win.document.querySelectorAll('#section-project [data-edit]')]
      .some(el => ['products', 'material', 'lf'].includes(JSON.parse(el.dataset.edit).field)),
    [...win.document.querySelectorAll('#section-project [data-edit]')]
      .map(el => JSON.parse(el.dataset.edit).field).join(','));

  // Double-click swaps the value for a control carrying the raw value.
  const el = host();
  UI.beginEdit(el);
  const input = el.querySelector('input');
  check('double-clicking gives you an input', !!input);
  check('holding the raw value, not the formatted one',
    input.value === String(b.price), input.value + ' vs ' + b.price);

  input.value = '123456';
  input.dispatchEvent(new win.Event('blur'));
  check('committing writes it through', b.price === 123456, String(b.price));

  // Escape reverts, and nothing is written.
  Project.render();
  const el2 = host();
  UI.beginEdit(el2);
  el2.querySelector('input').value = '999';
  el2.querySelector('input').dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape leaves the record alone', b.price === 123456, String(b.price));
  check('and puts the display back', !el2.querySelector('input'));

  // The same rules the form applies apply here - a refused edit is not silently
  // dropped, and the record is not changed.
  const other = Bids.baseList().filter(x => x.id !== b.id && x.proposalNo)[0];
  if (other) {
    const before = b.proposalNo;
    Bids.saveField(b.id, 'proposalNo', other.proposalNo, 'text', null);
    check('a duplicate project number is refused here too',
      b.proposalNo === before, b.proposalNo);
  }
  const beforeDate = b.dueDate;
  Bids.saveField(b.id, 'dueDate', '02-30-2026', 'date', null);
  check('and so is a date that does not exist', b.dueDate === beforeDate, b.dueDate);

  /* A DATE THAT DOES NOT EXIST IS REFUSED IN FRONT OF THE PERSON WHO TYPED IT.
     It used to be handed to saveField from inside a blur handler, which had no
     way to say no - so it was dropped, the old value came back, and nothing was
     said. Now the editor stays open and marked. */
  Project.render();
  const dateHost = () => [...win.document.querySelectorAll('#section-project [data-edit]')]
    .find(el => JSON.parse(el.dataset.edit).field === 'dueDate');
  const dh = dateHost();
  UI.beginEdit(dh);
  const dateInput = dh.querySelector('input');
  check('a date field edits as MM-DD-YYYY',
    dateInput.value === U.dateToInput(b.dueDate), dateInput.value);
  check('with a calendar button beside it',
    !!dh.querySelector('.fa-calendar-alt'));

  dateInput.value = '02-30-2026';
  dateInput.dispatchEvent(new win.Event('blur'));
  check('a date that cannot exist keeps the editor open',
    !!dh.querySelector('input'), dh.innerHTML.slice(0, 60));
  check('says so', /Not a date/.test(dh.textContent), dh.textContent);
  check('and marks the field',
    dh.querySelector('input').className.indexOf('border-danger') >= 0);
  check('while the record is untouched', b.dueDate === beforeDate, b.dueDate);

  // Typing again clears the complaint, and a good value commits.
  dateInput.value = '12-01-2026';
  dateInput.dispatchEvent(new win.Event('input'));
  check('correcting it clears the mark',
    dh.querySelector('.text-danger').classList.contains('hidden'));
  dateInput.dispatchEvent(new win.Event('blur'));
  check('and then it saves', b.dueDate === '2026-12-01', b.dueDate);

  // Save and cancel are on the editor, not only on the keyboard.
  Project.render();
  const h3 = host();
  UI.beginEdit(h3);
  check('the editor offers Save and Cancel',
    h3.querySelectorAll('button[title="Save"], button[title="Cancel"]').length === 2,
    String(h3.querySelectorAll('button').length));
  h3.querySelector('button[title="Cancel"]')
    .dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  check('Cancel puts it back', !h3.querySelector('input'));

  // A field is reachable and openable from the keyboard, not only by clicking.
  Project.render();
  check('an editable field is in the tab order', host().tabIndex === 0);
  check('and says a single click opens it',
    /Click to edit/.test(host().getAttribute('title')), host().getAttribute('title'));

  // Changing the due date has to re-file the bid under the right month.
  Bids.saveField(b.id, 'dueDate', '11-05-2026', 'date', null);
  check('editing the due date re-files the month', b.month === 10, String(b.month));
}

console.log('\n--- how a bid got where it is ---');
{
  Bids.setView('all');
  const b = Store.db.bids.filter(x =>
    !x.active && Bids.bucketOf(x) === 'open')[0] ||
    (() => { const x = Bids.baseList()[0]; x.active = false; x.activatedAt = null;
             x.history = []; return x; })();
  b.history = [];

  // Picking it up is the first thing that happens to a bid. Bids.promoteBid is
  // the transition itself; Bids.addToActive is the id-taking wrapper that may
  // stop at the duplicate-project-name warning first.
  Bids.promoteBid(b);
  check('picking a bid up is recorded',
    History.entries(b).length === 1, JSON.stringify(History.entries(b)));
  const first = History.entries(b)[0];
  check('with where it came from and where it went',
    first.from === 'intake' && first.to === 'active',
    first.from + '->' + first.to);
  check('and the stage it is at now agrees',
    History.stageOf(b) === 'active', History.stageOf(b));
  const numberIssued = b.proposalNo;

  // Awarding it is the second.
  b.status = 'Submitted to review';
  Bids.applyAward(b, '2026-05-01');
  check('awarding is recorded too', History.entries(b).length === 2);
  const award = History.entries(b)[1];
  check('and remembers the status it moved from',
    award.fromStatus === 'Submitted to review', String(award.fromStatus));

  // Reversing restores the recorded state rather than guessing at one.
  check('an awarded bid can be moved back to Active',
    History.previousStage(b) === 'active', String(History.previousStage(b)));
  History.reverse(b, 'client rescinded the award');
  check('reversing puts the status back to what it actually was',
    b.status === 'Submitted to review', b.status);
  check('the award markers are cleared',
    !b.awardedAt && !b.awardNo, b.awardedAt + '/' + b.awardNo);
  check('but the project number never moves', b.proposalNo === numberIssued,
    b.proposalNo + ' vs ' + numberIssued);
  check('and the reversal is itself an entry, with its comment',
    History.entries(b).length === 3 &&
    History.entries(b)[2].reversal === true &&
    /rescinded/.test(History.entries(b)[2].comment),
    JSON.stringify(History.entries(b)[2]));

  // Back once more, to intake.
  History.reverse(b, '');
  check('an active bid goes back to intake',
    History.stageOf(b) === 'intake' && !b.active, History.stageOf(b));
  check('still keeping its number', b.proposalNo === numberIssued);
  check('and there is nowhere further back to go',
    History.previousStage(b) === null, String(History.previousStage(b)));

  // A move that changes nothing is not a move.
  const before = History.entries(b).length;
  History.record(b, 'intake', 'intake', {});
  check('a transition to the same stage is not recorded',
    History.entries(b).length === before);

  // Deleting an entry leaves a mark that it happened.
  const doomed = History.entries(b)[0];
  History.promptDelete(b.id, doomed.id);
  History.confirm();
  check('a deleted entry is gone',
    !History.entries(b).some(e => e.id === doomed.id));
  check('but the deletion is recorded in its place',
    History.entries(b).some(e => e.deletion === true),
    JSON.stringify(History.entries(b).map(e => e.comment)));

  /* THE CARD STARTS SHUT. It is reference material, and open by default it was
     the tallest thing on the project page - pushing the estimate and the
     proposal, which is what people actually come for, below the fold. */
  check('the card is collapsed until somebody asks for it',
    !History.isOpen(b) && !/Active Bids/.test(History.card(b)),
    History.card(b).slice(0, 160));
  check('but the bar still says when it last moved, so it is worth reading shut',
    /Last change/.test(History.card(b)), History.card(b).slice(0, 200));

  History.toggle(b.id);
  check('opening it lists the moves',
    History.isOpen(b) && /Active Bids/.test(History.card(b)));

  /* THE REPAINT CASE. The card re-renders on every save - Assign.save calls
     History.render - so a bare open/shut flag would snap it closed the moment
     somebody typed an hours box with the log open. It is keyed by bid id. */
  check('and a re-render of the same bid leaves it open',
    /Active Bids/.test(History.card(b)) && History.isOpen(b));

  const other = Bids.baseList().filter(x => x.id !== b.id)[0];
  /* aria-expanded rather than the presence of the body's id: the header
     carries aria-controls="historyBody" whether or not the body is there, so
     matching on the bare id passes on a collapsed card too. */
  check('while a different bid comes back collapsed',
    !History.isOpen(other) && /aria-expanded="false"/.test(History.card(other)),
    History.card(other).slice(0, 200));

  History.toggle(b.id);
  check('and it shuts again', !History.isOpen(b));

  /* WHEN THIS BID LAST MOVED. Written by every record* call, from the entry's
     own timestamp - so the column on the bid list and the top line of this
     card are the same fact and cannot drift apart. */
  check('a recorded change stamps the bid',
    b.updatedAt === History.entries(b).slice(-1)[0].at,
    b.updatedAt + ' vs ' + History.entries(b).slice(-1)[0].at);
  check('and names who made it', b.updatedBy === History.entries(b).slice(-1)[0].by,
    b.updatedBy);
  check('pruning the log is itself a change to the record, and is stamped',
    !!b.updatedAt && History.entries(b).some(e => e.deletion === true));

  /* THE COALESCING BRANCH. recordEdit merges a second edit into the previous
     entry and returns without calling push(), so a stamp taken only inside
     push() would leave Last Modified reading the edit before this one. */
  const wasAt = b.updatedAt;
  History.recordEdit(b, [{ field: 'price', label: 'Bid Price', from: '$1', to: '$2' }]);
  const firstAt = b.updatedAt;
  check('a first edit moves it', firstAt !== wasAt, wasAt + ' -> ' + firstAt);

  /* Backdated to a sentinel rather than compared against the previous value:
     two recordEdit calls in a test land in the same millisecond, so the two
     ISO strings would be equal whether or not the stamp was taken. What is
     actually being asserted is that it tracks the MERGED entry. */
  const n = History.entries(b).length;
  b.updatedAt = '2020-01-01T00:00:00.000Z';
  History.recordEdit(b, [{ field: 'price', label: 'Bid Price', from: '$2', to: '$3' }]);
  check('and a second one inside the window still moves it, though it merged',
    History.entries(b).length === n &&
    b.updatedAt === History.entries(b).slice(-1)[0].at &&
    b.updatedAt !== '2020-01-01T00:00:00.000Z',
    History.entries(b).length + ' entries, stamp ' + b.updatedAt);

  /* NOT every write. Assign.ensure backfills missing day rows as the card
     draws and deliberately records nothing - laying out three empty days is
     not a change anybody made, so it must not move the timestamp either. */
  const settled = b.updatedAt;
  b.assignments.forEach(r => { delete r.days; });
  Assign.card(b);
  check('but laying out empty day boxes does not, because nobody did it',
    b.updatedAt === settled, settled + ' -> ' + b.updatedAt);

  check('a bid nobody has edited still reports when it arrived',
    History.lastMovedAt({ createdAt: '2026-03-03T00:00:00.000Z' }) ===
      '2026-03-03T00:00:00.000Z');
}

console.log('\n--- dates a spreadsheet can actually use ---');
{
  /* Excel's date is a NUMBER - whole days since 1899-12-30 - and writing
     "09-16-2026" instead gives text that sorts alphabetically, so October
     lands between January and September. 45292 is 2024-01-01; the figure
     appears in the float-dust note in js/estimate.xlsx.js, which makes it an
     independent check rather than one I derived from the same arithmetic. */
  check('a known serial comes out right', U.excelDate('2024-01-01') === 45292,
    String(U.excelDate('2024-01-01')));
  check('and the epoch itself', U.excelDate('1970-01-01') === 25569,
    String(U.excelDate('1970-01-01')));
  check('a leap day is a real day', U.excelDate('2024-02-29') === 45351,
    String(U.excelDate('2024-02-29')));
  check('nothing is null rather than a misleading zero',
    U.excelDate('') === null && U.excelDate(null) === null &&
    U.excelStamp('') === null,
    JSON.stringify([U.excelDate(''), U.excelStamp('')]));

  /* A calendar date must not go near a timezone - a due date of the 22nd is
     the 22nd everywhere - so consecutive days are exactly one apart. */
  check('consecutive days are one apart, whatever the machine is set to',
    U.excelDate('2026-03-29') - U.excelDate('2026-03-28') === 1 &&
    U.excelDate('2026-11-02') - U.excelDate('2026-11-01') === 1);

  // An instant carries the time of day as the fraction, on the IST clock the
  // rest of the app reads timestamps on.
  const noon = U.excelStamp('2026-09-16T06:30:00.000Z');   // 12:00 IST
  check('an instant keeps its time of day', noon === U.excelDate('2026-09-16') + 0.5,
    String(noon));
}

console.log('\n--- the bid register, as a workbook ---');
{
  Bids.setView('active');
  Bids.filterTable();

  const built = BidsReport.workbook();
  const names = built.sheets.map(s => s.name);
  check('the workbook has the six sheets, in reading order',
    names.join(',') === 'Summary,Bids,Team & Hours,Bookings,Estimate Lines,History',
    names.join(','));
  check('and no two share a name', new Set(names).size === names.length, names.join(','));

  /* IT EXPORTS THE LIST YOU ARE LOOKING AT. The old export walked db.bids and
     ignored every filter, so narrowing the table to one engineer and pressing
     export handed you all ninety-five. */
  check('the rows are the rows on screen, in the same order',
    built.rows.length === BidGrid.visibleRows(Bids.baseList()).length &&
    built.rows.every((b, i) => b.id === BidGrid.visibleRows(Bids.baseList())[i].id),
    built.rows.length + ' vs ' + BidGrid.visibleRows(Bids.baseList()).length);

  const wide = built.rows.length;
  BidGrid.setFilterValues('status', ['In Progress']);
  const narrow = BidsReport.workbook();
  check('narrowing the table narrows the workbook',
    narrow.rows.length < wide && narrow.rows.every(b => b.status === 'In Progress'),
    narrow.rows.length + ' of ' + wide);
  check('and the summary says it is a filtered view, not the whole register',
    /Status = In Progress/.test(narrow.sheets[0].xml()) &&
    /filtered view/.test(narrow.sheets[0].xml()),
    'no filter note on the Summary');
  BidGrid.clearFilters();

  /* TYPED CELLS. A price is a number and a due date is a date serial - a
     spreadsheet is sorted, filtered and summed, and a string does none of it. */
  const cols = BidGrid.activeColumns().filter(c => c.key !== 'actions');
  const priced = built.rows.filter(b => U.n(b.price) > 0)[0];
  const due = built.rows.filter(b => Bids.effectiveDueDate(b))[0];
  if (priced) {
    const c = cols.filter(x => x.key === 'price')[0] ||
      BidGrid.COLUMNS.filter(x => x.key === 'price')[0];
    check('a price is written as a number, not "$7,520"',
      typeof BidsReport.cell(c, priced, 0, false)[0] === 'number',
      JSON.stringify(BidsReport.cell(c, priced, 0, false)));
  }
  if (due) {
    const c = BidGrid.COLUMNS.filter(x => x.key === 'dueDate')[0];
    const v = BidsReport.cell(c, due, 0, false)[0];
    check('a due date is a date serial, not "09-16-2026"',
      typeof v === 'number' && v === U.excelDate(Bids.effectiveDueDate(due)),
      JSON.stringify(v));
  }

  const bidsXML = built.sheets[1].xml();
  check('the totals row is a live SUM, not a baked figure',
    /<f>SUM\(/.test(bidsXML), 'no SUM formula in the Bids sheet');
  check('the header is frozen and the identity columns with it',
    /<pane [^>]*state="frozen"/.test(bidsXML), 'no frozen pane');
  check('and it carries an autofilter',
    /<autoFilter ref="/.test(bidsXML), 'no autofilter');
  /* Schema order, not ours: CT_Worksheet puts autoFilter before mergeCells,
     and out of order Excel refuses the file rather than reading it wrong. */
  check('with autoFilter before mergeCells, as the schema requires',
    bidsXML.indexOf('<autoFilter') < bidsXML.indexOf('<mergeCells'),
    'autoFilter/mergeCells out of order');
  check('the buttons column never reaches the sheet',
    !/>Actions</.test(bidsXML) && cols.every(c => c.key !== 'actions'));

  /* THE CRASH THIS REPLACED. Two bids with the SAME project name, both with
     takeoffs - exactly what re-opening produces, since a revision carries its
     original's name. The old export named a sheet per takeoff and threw. */
  const twin = Bids.baseList().filter(b => b.takeoffId && Store.db.takeoffs[b.takeoffId])[0];
  const clone = JSON.parse(JSON.stringify(twin));
  clone.id = Store.db.bids.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  clone.proposalNo = (twin.proposalNo || 'DIS-26-0001') + '-R01';
  clone.revision = 1;
  const t2 = JSON.parse(JSON.stringify(Store.db.takeoffs[twin.takeoffId]));
  t2.id = 'tk-twin-test';
  clone.takeoffId = t2.id;
  Store.db.takeoffs[t2.id] = t2;
  Store.db.bids.push(clone);
  Bids.filterTable();

  let twinNames = null, threw = null;
  try {
    const w = BidsReport.workbook();
    twinNames = w.sheets.map(s => s.name);
    Report.build(w.sheets);
  } catch (e) { threw = e.message; }
  check('two bids sharing a project name export without throwing',
    threw === null, String(threw));
  check('because no sheet is named after a project any more',
    twinNames && twinNames.every(n => !/xyz|Hillsdale|Lourdes/i.test(n)),
    (twinNames || []).join(','));

  Store.db.bids = Store.db.bids.filter(b => b.id !== clone.id);
  delete Store.db.takeoffs[t2.id];
  Bids.filterTable();

  /* The arithmetic in the workbook is the app's arithmetic. */
  const wb2 = BidsReport.workbook();
  const bookings = wb2.sheets[3].xml();
  const bookedInSheet = (bookings.match(/<v>[\d.]+<\/v>/g) || []).length;
  check('every booked day reaches the Bookings sheet',
    bookedInSheet > 0, String(bookedInSheet));

  // A bid with nothing on it at all must not take the export down with it.
  const bare = { id: 99999, project: 'Bare', status: 'Not Started', active: true,
                 assignments: [], history: [], products: [], createdAt: U.today() };
  Store.db.bids.push(bare);
  Bids.filterTable();
  let bareErr = null;
  try { Report.build(BidsReport.workbook().sheets); } catch (e) { bareErr = e.message; }
  check('a bid with no team, no takeoff and no history exports cleanly',
    bareErr === null, String(bareErr));
  Store.db.bids = Store.db.bids.filter(b => b.id !== 99999);
  Bids.filterTable();

  /* BOTH WORKBOOKS ARE WRITTEN BY HAND NOW, so the SheetJS CDN script is gone.
     Pinned because it is easy to reintroduce by habit, and because a page that
     silently reacquires a 900KB third-party dependency is worth failing a
     build over. */
  check('SheetJS is not loaded any more', typeof win.XLSX === 'undefined',
    typeof win.XLSX);
  check('and nothing on the page asks a CDN for it',
    !/xlsx\.full\.min\.js/.test(fs.readFileSync(HTML, 'utf8')),
    'xlsx.full.min.js still referenced in the HTML');

  /* Written out so the formatting can be looked at in a real spreadsheet -
     the one thing these checks cannot do. .scratch is gitignored. */
  try {
    const out = Report.build(BidsReport.workbook().sheets);
    require('fs').mkdirSync('.scratch', { recursive: true });
    require('fs').writeFileSync('.scratch/bids-report.xlsx', Buffer.from(out));
  } catch (e) { /* the checks above are the test; this is a convenience */ }
}

console.log('\n--- the table layout follows the login ---');
{
  /* Everything in db.ui is written to the per-user user_prefs row, so a new
     column inherits per-person persistence with nothing added. Pinned here
     because it is most of what "save this view per login" asks for, and it
     would be easy to break without noticing. */
  Bids.setView('active');
  BidGrid.toggleSort('lastModified');
  const g = () => Store.db.ui.grids.active;
  check('a sort is held against the view, not globally',
    g().sort && g().sort.key === 'lastModified', JSON.stringify(g().sort));
  check('and the other views are untouched by it',
    !(Store.db.ui.grids.all && Store.db.ui.grids.all.sort),
    JSON.stringify(Store.db.ui.grids.all && Store.db.ui.grids.all.sort));

  BidGrid.toggleColumn('portal');
  const hidPortal = g().visible.indexOf('portal') < 0;

  Store.db.ui.theme = 'dark';
  Store.db.ui.section = 'active';
  await Store.resetLayout();

  check('hiding a column sticks until it is reset', hidPortal);
  check('Reset my table layout clears the sort',
    !Store.db.ui.grids.active || !Store.db.ui.grids.active.sort,
    JSON.stringify(Store.db.ui.grids.active && Store.db.ui.grids.active.sort));
  check('and puts the hidden column back',
    BidGrid.activeColumns().some(c => c.key === 'portal'),
    BidGrid.activeColumns().map(c => c.key).join(','));
  /* It resets TABLES. Somebody who works in the dark did not ask for the
     lights, and resetting columns should not throw you to another tab. */
  check('but leaves the theme alone', Store.db.ui.theme === 'dark', Store.db.ui.theme);
  check('and where you were', Store.db.ui.section === 'active', Store.db.ui.section);
}

console.log('\n--- hours are booked against days ---');
{
  Bids.setView('active');
  const b = Bids.baseList().filter(x => Bids.bucketOf(x) === 'open')[0];
  Project.openFrom(b.id, 'active');
  Assign.add(b.id);
  const r = Assign.rows(b).slice(-1)[0];

  check('a new row opens with three working days',
    Assign.dayRows(r).length === 3, String(Assign.dayRows(r).length));
  check('none of them a weekend',
    Assign.dayRows(r).every(d => !Assign.isWeekend(d.date)),
    Assign.dayRows(r).map(d => d.date).join(','));
  check('and it starts on the day the task was created',
    r.startDate === Assign.dayRows(r)[0].date, r.startDate);
  check('with nothing booked yet', r.asgnHrs === 0, String(r.asgnHrs));

  const days = Assign.dayRows(r).map(d => d.date);
  Assign.setDay(b.id, r.id, days[0], '5');
  Assign.setDay(b.id, r.id, days[1], '3');
  check('the row total is the sum of its days', r.asgnHrs === 8, String(r.asgnHrs));
  Assign.setDay(b.id, r.id, days[0], '');
  check('and follows a cell being cleared', r.asgnHrs === 3, String(r.asgnHrs));

  // Add day steps over the weekend.
  const beforeAdd = Assign.dayRows(r).length;
  Assign.addDay(b.id, r.id);
  check('Add day appends one more', Assign.dayRows(r).length === beforeAdd + 1);
  check('and never lands on a weekend',
    Assign.dayRows(r).every(d => !Assign.isWeekend(d.date)),
    Assign.dayRows(r).map(d => d.date).join(','));
  check('each one after the last',
    Assign.dayRows(r).every((d, i, a) => i === 0 || d.date > a[i - 1].date),
    Assign.dayRows(r).map(d => d.date).join(','));

  // Moving the start slides the whole booking without changing its shape.
  const shape = Assign.dayRows(r).map(d => d.hrs);
  const total = r.asgnHrs;
  Assign.set(b.id, r.id, 'startDate', '11-02-2026');   // a Monday
  check('moving the start slides every day with it',
    Assign.dayRows(r)[0].date === '2026-11-02', Assign.dayRows(r)[0].date);
  check('keeping the hours on the same day of the task',
    JSON.stringify(Assign.dayRows(r).map(d => d.hrs)) === JSON.stringify(shape),
    JSON.stringify(Assign.dayRows(r).map(d => d.hrs)));
  check('and the total unchanged', r.asgnHrs === total, String(r.asgnHrs));

  // THE START DATE IS A FIELD ON THE CARD, and it has to write through.
  // It was rendered without a change handler, so typing a date into it did
  // nothing at all: the booking stayed where it was and there was no sign the
  // field had been ignored.
  Project.openFrom(b.id, 'active');
  const startField = U.$('asg-start-' + r.id);
  check('the row shows its start date', !!startField && startField.value === '11-02-2026',
    startField ? startField.value : 'no field');
  startField.value = '11-09-2026';
  startField.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('and typing a new one moves the booking',
    Assign.dayRows(r)[0].date === '2026-11-09', Assign.dayRows(r)[0].date);

  // A row that reaches the card without a booking - synced from a session
  // running the older code, or restored from a backup taken before the day
  // strip existed - is laid out rather than left with nowhere to type.
  delete r.days;
  delete r.startDate;
  Assign.render(b);
  check('a row with no days at all is given some',
    Assign.dayRows(r).length === 3, String(Assign.dayRows(r).length));
  check('starting from the day the task was created',
    r.startDate === Assign.defaultStart(b), r.startDate + ' vs ' + Assign.defaultStart(b));
  check('and blank, because nobody has booked anything to them',
    Assign.dayRows(r).every(d => d.hrs == null) && r.asgnHrs === 0,
    JSON.stringify(Assign.dayRows(r)));
  check('which the card then offers as empty boxes',
    U.$('asg-day-' + r.id + '-' + Assign.dayRows(r)[0].date).value === '',
    U.$('asg-day-' + r.id + '-' + Assign.dayRows(r)[0].date).value);

  // The card totals still read the same figure as the grid and the export.
  check('the project card total matches the rows',
    Assign.totals(b).asgn ===
      Assign.rows(b).reduce((s, x) => s + x.asgnHrs, 0),
    String(Assign.totals(b).asgn));

  /* WHAT A SAVED ROW SHOWS.
     Every booked day used to be a box whether anything went in it or not, so a
     three-week task was twenty boxes of which five carried numbers. The empties
     fold away behind a count once there is something to fold them behind. */
  const boxes = () => Assign.dayRows(r)
    .filter(d => !!U.$('asg-day-' + r.id + '-' + d.date)).length;

  Assign.set(b.id, r.id, 'startDate', '11-02-2026');
  Assign.addDay(b.id, r.id);
  Assign.addDay(b.id, r.id);                       // five days on the row
  check('a row with nothing booked shows all of its days',
    boxes() === Assign.dayRows(r).length, boxes() + ' of ' + Assign.dayRows(r).length);

  const five = Assign.dayRows(r).map(d => d.date);
  Assign.setDay(b.id, r.id, five[0], '4');
  Assign.setDay(b.id, r.id, five[3], '2');
  check('once hours are on it, only the days worked are shown',
    boxes() === 2, String(boxes()));
  check('and the rest are behind a count of what is folded away',
    /\+3 empty/.test(U.$('assignCard').innerHTML));
  check('nothing was deleted to do it', Assign.dayRows(r).length === 5,
    String(Assign.dayRows(r).length));

  Assign.toggleEmpty(b.id, r.id);
  check('the count opens them again for editing', boxes() === 5, String(boxes()));
  check('and offers to fold them back', /Hide empty/.test(U.$('assignCard').innerHTML));
  Assign.toggleEmpty(b.id, r.id);
  check('which it does', boxes() === 2, String(boxes()));

  /* ADDING A DAY: the next few, or any other one. Stepping day by day to reach
     a date three weeks out was the alternative, and it left twenty boxes. */
  Assign.addDay(b.id, r.id, '2026-12-01');
  check('a day can be booked by date, without stepping through the ones between',
    Assign.dayRows(r).some(d => d.date === '2026-12-01'));
  check('and lands in date order',
    Assign.dayRows(r).every((d, i, a) => i === 0 || d.date > a[i - 1].date),
    Assign.dayRows(r).map(d => d.date).join(','));
  const countBeforeDup = Assign.dayRows(r).length;
  Assign.addDay(b.id, r.id, '2026-12-01');
  check('a day already on the row is refused rather than doubled',
    Assign.dayRows(r).length === countBeforeDup, String(Assign.dayRows(r).length));

  Assign.addDay(b.id, r.id, '2026-10-26');
  check('a day before the start moves the start back to it',
    r.startDate === '2026-10-26' && Assign.dayRows(r)[0].date === '2026-10-26',
    r.startDate);

  // The picker itself: the next five working days, and a way to any other.
  const addBtn = U.$('asg-addday-' + r.id);
  Assign.openDayPicker(addBtn, b.id, r.id);
  const pop = win.document.querySelector('[role=dialog]');
  check('the + offers a short list rather than appending blindly',
    !!pop && /Book a day/.test(pop.innerHTML));
  check('five working days, none of them a weekend',
    (pop.innerHTML.match(/Assign.addDay\([0-9]+,'[^']+','[^']+'\)/g) || []).length +
      (pop.innerHTML.match(/>booked</g) || []).length === 5 &&
      !/Sat |Sun /.test(pop.innerHTML), pop.innerHTML.replace(/<[^>]*>/g, ' ').trim());
  check('with the calendar behind "Pick a date..."',
    /Assign.pickDayFromCalendar/.test(pop.innerHTML));
  UI.closePopover();
  check('and it closes again', !win.document.querySelector('[role=dialog]'));

  // Each box carries its own delete now: "drop the last day" stopped making
  // sense once the last day can be one of the folded empties.
  const gone = Assign.dayRows(r)[0].date;
  Assign.removeDayAt(b.id, r.id, gone);
  check('a day can be removed from its own box',
    !Assign.dayRows(r).some(d => d.date === gone), gone);

  Assign.remove(b.id, r.id);
}

console.log('\n--- the Employee view ---');
{
  Bids.setView('active');
  const b = Bids.baseList().filter(x => Bids.bucketOf(x) === 'open')[0];

  // Two engineers on one bid, booked across the same three days.
  Assign.rows(b).slice().forEach(r => Assign.remove(b.id, r.id));
  Assign.add(b.id);
  const r1 = Assign.rows(b).slice(-1)[0];
  Assign.set(b.id, r1.id, 'engineer', 'AF');
  Assign.add(b.id);
  const r2 = Assign.rows(b).slice(-1)[0];
  Assign.set(b.id, r2.id, 'engineer', 'MGJ');

  // Put both on a known Monday so the week and month buckets are predictable.
  Assign.set(b.id, r1.id, 'startDate', '11-02-2026');
  Assign.set(b.id, r2.id, 'startDate', '11-02-2026');
  const d1 = Assign.dayRows(r1).map(d => d.date);
  Assign.setDay(b.id, r1.id, d1[0], '5');
  Assign.setDay(b.id, r1.id, d1[1], '5');
  Assign.setDay(b.id, r2.id, Assign.dayRows(r2)[0].date, '3');

  // ---- the window: the zoom says how much calendar, the anchor says where.
  const wed = '2026-11-04';                       // the Wednesday of that week

  const days = Schedule.periods('day', wed);
  check('the Day zoom shows one day - the one it is pointed at',
    days.length === 1 && days[0].start === wed, JSON.stringify(days.map(p => p.start)));

  const week = Schedule.periods('week', wed);
  check('the Week zoom shows that whole week', week.length === 7, String(week.length));
  check('starting on the Monday',
    week[0].start === '2026-11-02' && week[0].isWeekStart, week[0].start);
  check('and marking its weekend',
    week.filter(p => p.isWeekend).length === 2, week.map(p => p.label).join(','));

  const month = Schedule.periods('month', wed);
  check('the Month zoom shows the whole month, day by day',
    month.length === 30 && month[0].start === '2026-11-01' &&
    month[29].start === '2026-11-30', month.length + ' from ' + month[0].start);

  // Columns are days at every zoom, so hours land in one place and one only.
  check('an engineer\'s hours land on the right day',
    Schedule.hoursFor(b, 'AF', week[0]) === 5 &&
    Schedule.hoursFor(b, 'MGJ', week[0]) === 3,
    Schedule.hoursFor(b, 'AF', week[0]) + '/' + Schedule.hoursFor(b, 'MGJ', week[0]));
  check('and not on somebody else\'s',
    Schedule.hoursFor(b, 'MGJ', week[1]) === 0, String(Schedule.hoursFor(b, 'MGJ', week[1])));
  const sum = list => list.reduce((s, p) => s + Schedule.bidHoursFor(b, p), 0);
  check('the week and the month agree on the total',
    sum(week) === 13 && sum(month) === 13, `${sum(week)}/${sum(month)}`);
  check('every column half-open, so nothing is counted twice',
    week[0].start === '2026-11-02' && week[0].end === '2026-11-03',
    week[0].start + '..' + week[0].end);

  // Paging: back and forward by one of whatever is on screen.
  check('a day steps a day', Schedule.step('day', wed, 1) === '2026-11-05');
  check('a week steps to the next Monday',
    Schedule.step('week', wed, 1) === '2026-11-09', Schedule.step('week', wed, 1));
  check('and back to the last one',
    Schedule.step('week', wed, -1) === '2026-10-26', Schedule.step('week', wed, -1));
  check('a month steps a month, off the 1st rather than the 31st',
    Schedule.step('month', '2026-01-31', 1) === '2026-02-01',
    Schedule.step('month', '2026-01-31', 1));
  check('the window says which one it is',
    Schedule.windowLabel('month', wed) === 'November 2026',
    Schedule.windowLabel('month', wed));
  check('and knows whether today is in it',
    Schedule.isNowWindow('day', Schedule.today()) &&
    !Schedule.isNowWindow('day', '2026-11-04') === (Schedule.today() !== '2026-11-04'));

  // A day is judged against a day's capacity, at every zoom, because a column
  // IS a day at every zoom.
  check('an ordinary day is not flagged',
    Schedule.loadLevel(4, week[0], 1) === 1, String(Schedule.loadLevel(4, week[0], 1)));
  check('an overbooked day is',
    Schedule.loadLevel(12, week[0], 1) === 3, String(Schedule.loadLevel(12, week[0], 1)));
  /* A WORKING DAY IS NINE HOURS, AND IT IS A SETTING.
     It was a flat 8 written into js/schedule.js; the office works 9, and one
     person in four works something else again. Three answers, in priority
     order: the engineer's own row, then the shop, then the built-in default. */
  check('one person, one day, the shop\'s working day',
    Schedule.capacityOf(week[0], 1) === 9, String(Schedule.capacityOf(week[0], 1)));
  check('and the default is 9, not the 8 it used to be',
    Schedule.DEFAULT_DAY_HOURS === 9 && Schedule.shopDayHours() === 9,
    Schedule.DEFAULT_DAY_HOURS + '/' + Schedule.shopDayHours());

  Store.db.company.dayHours = 10;
  check('the shop can say otherwise', Schedule.shopDayHours() === 10,
    String(Schedule.shopDayHours()));
  check('and everyone follows it', Schedule.dayHoursFor('AF') === 10,
    String(Schedule.dayHoursFor('AF')));

  // A per-person shift lives on the register entry, so there has to be one.
  const af = Bids.findEngineer('AF') || Bids.addEngineer('AF', '');
  af.dayHours = 4.5;
  check('until somebody works a different day', Schedule.dayHoursFor('AF') === 4.5,
    String(Schedule.dayHoursFor('AF')));
  check('which does not move anybody else', Schedule.dayHoursFor('MGJ') === 10,
    String(Schedule.dayHoursFor('MGJ')));
  /* Capacity given NAMES sums what those people actually work, rather than
     multiplying a headcount by a figure none of them is on. */
  check('a mixed team\'s capacity is the sum of its people, not a headcount',
    Schedule.capacityOf(week[0], ['AF', 'MGJ']) === 14.5,
    String(Schedule.capacityOf(week[0], ['AF', 'MGJ'])));

  /* HOURS LEFT IN THE DAY - counted across every bid, which is the only
     reading that is any use: the hours that fill a Friday are usually on a
     project you are not looking at. */
  Schedule.invalidate();
  check('what somebody has booked that day, from the whole database',
    Schedule.bookedFor('AF', '2026-11-02') === 5,
    String(Schedule.bookedFor('AF', '2026-11-02')));
  check('and what is left of their day',
    Schedule.remainingFor('AF', '2026-11-02') === -0.5,
    String(Schedule.remainingFor('AF', '2026-11-02')));
  af.dayHours = 9;
  Schedule.invalidate();
  check('which moves when their shift does',
    Schedule.remainingFor('AF', '2026-11-02') === 4,
    String(Schedule.remainingFor('AF', '2026-11-02')));
  check('a day they are not on is a whole day free',
    Schedule.remainingFor('AF', '2026-11-06') === 9,
    String(Schedule.remainingFor('AF', '2026-11-06')));
  check('nobody is not a number',
    Schedule.remainingFor('', '2026-11-02') === null,
    String(Schedule.remainingFor('', '2026-11-02')));

  // A SECOND BID IS THE POINT. One bid's card must count the other bid's hours,
  // or it reports free time that does not exist.
  const other = Bids.baseList().filter(x => x.id !== b.id)[0];
  Assign.add(other.id);
  const rOther = Assign.rows(other).slice(-1)[0];
  Assign.set(other.id, rOther.id, 'engineer', 'AF');
  Assign.set(other.id, rOther.id, 'startDate', '11-02-2026');
  Assign.setDay(other.id, rOther.id, '2026-11-02', '3');
  check('hours on another project come off the same day',
    Schedule.bookedFor('AF', '2026-11-02') === 8,
    String(Schedule.bookedFor('AF', '2026-11-02')));
  check('so the hours left account for work you are not looking at',
    Schedule.remainingFor('AF', '2026-11-02') === 1,
    String(Schedule.remainingFor('AF', '2026-11-02')));
  check('and the day is credited to both projects',
    Schedule.projectsOn('AF', '2026-11-02') === 2,
    String(Schedule.projectsOn('AF', '2026-11-02')));

  // Put it back, so the view checks below read the bookings they were written for.
  Assign.remove(other.id, rOther.id);
  Store.db.company.dayHours = 9;
  delete af.dayHours;
  Schedule.invalidate();

  // Only what is booked in the window belongs in it.
  check('a bid booked in the window is in it', Schedule.hasWorkIn(b, 'week', wed));
  check('and is not in the week before',
    !Schedule.hasWorkIn(b, 'week', '2026-10-28'));

  // ---- now the view itself.
  BidGrid.setDensity('employee');
  BidGrid.setZoom('week');
  BidGrid.setAnchor(wed);
  const grid = U.$('bidsGridHost');

  check('the Employee view is offered on Active Bids',
    /setDensity\('employee'\)/.test(grid.innerHTML));
  check('the calendar is a week of days',
    grid.querySelectorAll('thead th.sched-col').length === 7,
    String(grid.querySelectorAll('thead th.sched-col').length));
  check('with the window named above it',
    /Wk 45/.test(grid.textContent) && /Nov 2 - 8 2026/.test(grid.textContent),
    Schedule.windowLabel('week', wed));

  // Every column the person has arranged is here, not a fixed four.
  const keys = BidGrid.activeColumns().map(c => c.key);
  check('it shows the columns this view is set to, like every other view',
    keys.length > 4 && keys.indexOf('portal') >= 0, keys.join(','));
  check('with Engineer among them, because the calendar is a line per engineer',
    keys.indexOf('team') >= 0, keys.join(','));
  /* Engineer then Task, in that order, hard against the calendar: who, what
     they are on, then their hours across the dates - left to right with
     nothing in between. */
  check('and Engineer then Task last of them, hard against the calendar',
    keys.slice(-2).join(',') === 'team,task', keys.slice(-3).join(','));
  check('so the header runs ... Engineer, Task, then the dates',
    (function () {
      const th = [...grid.querySelectorAll('thead th')];
      const first = th.findIndex(h => h.classList.contains('sched-col'));
      return th[first - 1].classList.contains('sched-task') &&
             th[first - 2].classList.contains('sched-team');
    })(), [...grid.querySelectorAll('thead th')].map(h => h.textContent.trim().slice(0, 6)).join('|'));
  check('the identity block stays put while the dates scroll under it',
    grid.querySelectorAll('thead th.col-sticky').length === 3,
    String(grid.querySelectorAll('thead th.col-sticky').length));
  check('which is the row controls, the counter and the project',
    keys.slice(0, 3).join(',') === 'actions,sr,project', keys.slice(0, 3).join(','));

  // Rearranging the rest does not dislodge it - it is placed, not ordered.
  BidGrid.moveColumn('status', -1);
  check('rearranging the other columns leaves Engineer and Task at the edge',
    BidGrid.activeColumns().slice(-2).map(c => c.key).join(',') === 'team,task',
    BidGrid.activeColumns().map(c => c.key).join(','));
  BidGrid.moveColumn('status', 1);

  // The column chooser drives it, the same as anywhere else.
  BidGrid.toggleColumn('portal');
  check('unticking a column takes it off the schedule too',
    BidGrid.activeColumns().map(c => c.key).indexOf('portal') < 0,
    BidGrid.activeColumns().map(c => c.key).join(','));
  BidGrid.toggleColumn('portal');

  // THE SCHEDULE LISTS EVERY ACTIVE BID, booked or not - the same list as
  // Comfortable and Compact, with a calendar beside it.
  check('every active bid is on the schedule, booked or not',
    schedRows().length === Bids.baseList().length,
    schedRows().length + ' of ' + Bids.baseList().length);
  check('and the bar says how many of them have anybody on them',
    /1 of \d+ booked/.test(grid.textContent), grid.textContent.slice(0, 120));

  // A bid with two engineers renders two aligned lines in every cell.
  const row = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  const nameLines = row.querySelectorAll('td.sched-team .sched-line').length;
  const cellLines = row.querySelector('td.sched-cell').querySelectorAll('.sched-line').length;
  check('two engineers give two lines in the Engineer column',
    nameLines === 2, String(nameLines));
  check('and the same number in every calendar cell, so they line up',
    cellLines === nameLines, cellLines + ' vs ' + nameLines);
  check('with a heavier rule between projects than between people',
    row.classList.contains('sched-row'), row.className);

  /* A LINE IS A TASK, NOT A PERSON.

     One engineer holding two tasks used to be one line with their two
     bookings summed into it - a figure that could say neither which task the
     hours were against nor whether either was finished. Hours are stored per
     assignment row, so the schedule draws one line per row and an engineer
     with two tasks appears twice. */
  Assign.add(b.id);
  const rSecond = Assign.rows(b).slice(-1)[0];
  Assign.set(b.id, rSecond.id, 'engineer', 'AF');     // AF again, second task
  Assign.set(b.id, rSecond.id, 'taskType', 'Estimating');
  Assign.set(b.id, r1.id, 'taskType', 'Drawing Take-off');
  Assign.set(b.id, r1.id, 'status', 'done');
  Assign.set(b.id, rSecond.id, 'startDate', '11-02-2026');
  Assign.setDay(b.id, rSecond.id, '2026-11-02', '2');
  Bids.filterTable();

  const row2 = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  const chips2 = [...row2.querySelectorAll('td.sched-team .person-chip')];
  check('one person with two tasks is two lines, not one',
    chips2.length === 3 && chips2.filter(c => /AF/.test(c.textContent)).length === 2,
    chips2.map(c => c.textContent.trim()).join(','));
  check('and every calendar cell still has a line each, so they line up',
    row2.querySelector('td.sched-cell').querySelectorAll('.sched-line').length === 3,
    String(row2.querySelector('td.sched-cell').querySelectorAll('.sched-line').length));

  /* THE HOURS SPLIT BY TASK, and are not repeated down the person's lines.
     Read per engineer, AF's 5 and 2 would both show as 7 on both of his
     lines; read per row they are 5 on one and 2 on the other. */
  const mon = [...row2.querySelectorAll('td.sched-cell')][0];
  const monFigures = [...mon.querySelectorAll('.sched-line')].map(s => s.textContent.trim());
  check('each task carries its own hours, not the person\'s total',
    monFigures.join(',') === '5,3,2', monFigures.join(','));

  // The Task column, lining up with the names beside it.
  const taskLines = [...row2.querySelectorAll('td.sched-task .sched-line')];
  check('the Task column names what each line is for',
    taskLines.length === 3 && /Drawing Take-off/.test(taskLines[0].textContent),
    taskLines.map(s => s.textContent.trim()).join(' | '));
  check('and says where it is up to',
    /Done/.test(taskLines[0].textContent) && /Not started/.test(taskLines[2].textContent),
    taskLines.map(s => s.textContent.trim()).join(' | '));
  check('a finished task ticks its own chip, not the whole person',
    chips2[0].querySelector('.fa-check') && !chips2[2].querySelector('.fa-check'),
    chips2.map(c => (c.querySelector('.fa-check') ? 'done' : 'open')).join(','));

  /* ---- FILTERING BY A PERSON GIVES YOU THAT PERSON'S WORK ----------------
     The Engineer filter narrowed which BIDS were listed and then left every
     row stacking everybody - the right seven projects, and a hunt through
     each one for the line you asked for. */
  const bidAsgn = Assign.totals(b).asgn;
  const bookedBefore = [...grid.querySelectorAll('tr.sched-totals td.sched-cell')]
    .map(td => td.textContent.trim()).join(',');

  BidGrid.setFilterValues('team', ['MGJ']);
  const narrowed = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);

  const nNames = narrowed.querySelectorAll('td.sched-team .sched-line').length;
  const nTasks = narrowed.querySelectorAll('td.sched-task .sched-line').length;
  const nCell = narrowed.querySelector('td.sched-cell').querySelectorAll('.sched-line').length;
  check('filtering to one person leaves only their line',
    nNames === 1, String(nNames));
  check('and the Task column and the calendar narrow with it',
    nTasks === 1 && nCell === 1, nTasks + '/' + nCell);
  /* All three counts equal is what keeps the name, the task and the hours on
     the same physical line - the alignment is by construction because all
     three render from scheduleLines. */
  check('so all three still line up',
    nNames === nTasks && nTasks === nCell, [nNames, nTasks, nCell].join('/'));
  /* AF is the other person on this bid - naming somebody who was never on it
     would make the negative half of this pass without testing anything. */
  check('and it is the right person',
    /MGJ/.test(narrowed.querySelector('td.sched-team').textContent) &&
    !/AF/.test(narrowed.querySelector('td.sched-team').textContent),
    narrowed.querySelector('td.sched-team').textContent.trim());

  /* THE AGGREGATES DO NOT NARROW. A person's share is not the bid's effort,
     and quietly reducing these would mean a row reading 4.5 against 18 booked.
     The note under the chip bar is what says so. */
  check('the bid\'s hours are untouched by the filter',
    Assign.totals(b).asgn === bidAsgn, Assign.totals(b).asgn + ' vs ' + bidAsgn);
  check('and so is the shop\'s booked total',
    [...grid.querySelectorAll('tr.sched-totals td.sched-cell')]
      .map(td => td.textContent.trim()).join(',') === bookedBefore);
  check('the chip bar says the figures are still the whole bid\'s',
    /still the whole bid/.test(grid.innerHTML), 'no narrowing note');

  /* A ROW CAN NARROW TO NOTHING. This bid has an MGJ row and an Estimating
     row, so it passes the row filter on both - but no single row is both, and
     zero lines would leave it with no height and throw the calendar beside it
     out of step with the names. */
  BidGrid.setFilterValues('task', ['Estimating']);
  const empty = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  check('a bid with no row matching every filter keeps its height',
    empty && empty.querySelectorAll('td.sched-team .sched-line').length === 1,
    empty ? String(empty.querySelectorAll('td.sched-team .sched-line').length) : 'row gone');
  check('and says why the line is empty rather than showing a blank',
    /no matching task/.test(empty.querySelector('td.sched-team').innerHTML),
    empty.querySelector('td.sched-team').textContent.trim());

  BidGrid.clearFilters();
  const restored = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  check('clearing the filter brings everybody back',
    restored.querySelectorAll('td.sched-team .sched-line').length === 3,
    String(restored.querySelectorAll('td.sched-team .sched-line').length));

  /* The Comfortable view draws its Engineer column from Bids.teamCell rather
     than from the lines, so it has to be narrowed by hand or the two views
     disagree about who is on the bid. */
  check('the Comfortable Engineer cell narrows too',
    /MGJ/.test(Bids.teamCell(b, ['MGJ'])) && !/AF/.test(Bids.teamCell(b, ['MGJ'])),
    Bids.teamCell(b, ['MGJ']));
  check('and says so when the bid matched on something else entirely',
    /not on this one/.test(Bids.teamCell(b, ['ZZZ'])), Bids.teamCell(b, ['ZZZ']));
  check('while an unfiltered cell is unchanged',
    /AF/.test(Bids.teamCell(b)) && /MGJ/.test(Bids.teamCell(b)), Bids.teamCell(b));

  Assign.remove(b.id, rSecond.id);
  Bids.filterTable();

  /* Two pinned rows now: what the shop has booked, and what is left of it.
     Booked alone said how hard everyone is working; Free is the one somebody
     scheduling has actually come to read. */
  check('there are two totals rows - booked, and free',
    grid.querySelectorAll('tr.sched-totals').length === 2,
    String(grid.querySelectorAll('tr.sched-totals').length));
  check('and Free is the lower of the two, pinned to the bottom',
    grid.querySelectorAll('tr.sched-totals')[1].classList.contains('sched-free'));

  /* THE DUE DATE, ON THE CALENDAR. A row of hours means nothing without the
     date it is working towards, and the schedule drew one and not the other. */
  b.dueDate = '2026-11-05';                       // the Thursday of that week
  b.revisedDueDate = '';
  Bids.filterTable();
  const dueRow = () => schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  const dueCells = () => [...dueRow().querySelectorAll('td.sched-cell')];
  check('the deadline is marked on its own day',
    dueCells()[3].querySelector('.sched-due') && !dueCells()[2].querySelector('.sched-due'),
    dueCells().map(c => c.querySelector('.sched-due') ? 'X' : '.').join(''));
  check('and the heading says how many are due that day',
    /flag-checkered/.test([...grid.querySelectorAll('thead th.sched-col')][3].innerHTML));

  // A moved deadline is the one the project works to.
  b.revisedDueDate = '2026-11-06';
  Bids.filterTable();
  check('a revised due date moves the marker',
    dueCells()[4].querySelector('.sched-due') && !dueCells()[3].querySelector('.sched-due'),
    dueCells().map(c => c.querySelector('.sched-due') ? 'X' : '.').join(''));

  check('a deadline still weeks off reads as ahead',
    !!dueCells()[4].querySelector('.due-ahead'),
    dueCells()[4].innerHTML.slice(0, 80));

  /* Overdue and due-this-week are different news and are coloured differently.
     Measured against today, so the calendar is pointed at today's week for
     these rather than at the fixed November one above. */
  const shiftFromToday = n => {
    const d = win.U.parseDate(Schedule.today());
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  };
  BidGrid.goToday();
  b.revisedDueDate = '';
  b.dueDate = shiftFromToday(-1);
  Bids.filterTable();
  check('yesterday reads as overdue',
    !!dueRow().querySelector('.due-over'), dueRow().innerHTML.indexOf('due-') );
  b.dueDate = shiftFromToday(1);
  Bids.filterTable();
  check('tomorrow reads as due soon',
    !!dueRow().querySelector('.due-soon'));
  BidGrid.setAnchor(wed);
  b.dueDate = '2026-11-05';
  b.revisedDueDate = '2026-11-06';
  Bids.filterTable();

  // A deadline off the edge of the window is not silently absent.
  b.revisedDueDate = '';
  b.dueDate = '2027-01-15';
  Bids.filterTable();
  check('a deadline past the end of the window shows on the last column',
    !!dueCells()[6].querySelector('.sched-due-off') &&
    !dueCells().some(c => c.querySelector('.sched-due')),
    dueCells().map(c => c.querySelector('.sched-due-off') ? '>' : '.').join(''));
  b.dueDate = '2026-11-05';
  b.revisedDueDate = '';
  Bids.filterTable();

  /* HOURS BOOKED TO A ROW WITH NOBODY ON IT.
     They were counted in the totals row and drawn nowhere - a cell reading 8
     above a total of 13, with five hours unaccounted for on screen. */
  Assign.add(b.id);
  const r3 = Assign.rows(b).slice(-1)[0];
  Assign.set(b.id, r3.id, 'startDate', '11-02-2026');
  Assign.setDay(b.id, r3.id, '2026-11-02', '5');
  check('a booking with no engineer on it is still a booking',
    r3.engineer === '' && r3.asgnHrs === 5, r3.engineer + '/' + r3.asgnHrs);

  const row3 = schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0);
  const names = [...row3.querySelectorAll('td.sched-team .sched-line')].map(s => s.textContent);
  const monday = row3.querySelectorAll('td.sched-cell')[0];
  const figures = [...monday.querySelectorAll('.sched-line')].map(s => s.textContent);
  check('it gets a line of its own, after the named ones',
    names.length === 3 && names[2] === 'unassigned', names.join('|'));
  check('and its hours are shown on that line',
    figures.length === 3 && figures[2] === '5', figures.join('|'));
  check('so the cell now accounts for every hour the totals row counts',
    figures.reduce((s, t) => s + (parseFloat(t) || 0), 0) === 13, figures.join('|'));
  const mondayTotal = grid.querySelector('tr.sched-totals td.sched-cell').textContent.trim();
  check('which is what the totals row says', mondayTotal === '13', mondayTotal);

  Assign.remove(b.id, r3.id);

  // Paging the calendar moves the window and takes the rows with it.
  BidGrid.stepWindow(-1);
  check('a step back lands on the week before',
    BidGrid.anchor() === '2026-10-26', BidGrid.anchor());
  check('where nothing is booked - but the bids are still listed',
    /0 of \d+ booked/.test(U.$('bidsGridHost').textContent) &&
    schedRows().length === Bids.baseList().length,
    schedRows().length + ' rows');
  BidGrid.stepWindow(1);
  check('and forward again brings the hours back',
    schedRows().find(tr => tr.textContent.indexOf(b.project) >= 0)
      .querySelector('td.sched-cell').textContent.indexOf('5') >= 0);

  BidGrid.setZoom('month');
  check('the Month zoom draws the whole month',
    U.$('bidsGridHost').querySelectorAll('thead th.sched-col').length === 30,
    String(U.$('bidsGridHost').querySelectorAll('thead th.sched-col').length));
  check('and sizes its columns for it',
    /grid-table sched-month/.test(U.$('bidsGridHost').innerHTML));

  BidGrid.setZoom('day');
  check('the Day zoom draws one column',
    U.$('bidsGridHost').querySelectorAll('thead th.sched-col').length === 1,
    String(U.$('bidsGridHost').querySelectorAll('thead th.sched-col').length));

  // Today is always one control away, and the zoom is what is remembered.
  BidGrid.goToday();
  check('Today comes back to now', BidGrid.anchor() === Schedule.today(), BidGrid.anchor());
  check('the zoom is remembered', BidGrid.cfg().zoom === 'day', BidGrid.cfg().zoom);
  check('but where you had paged to is not - it opens on today',
    BidGrid.cfg().anchor === undefined, String(BidGrid.cfg().anchor));

  // It is an Active Bids view, and heals if a layout names it elsewhere.
  Bids.setView('all');
  BidGrid.cfg().density = 'employee';
  Bids.filterTable();
  check('a layout naming it on another tab falls back',
    !U.$('bidsGridHost').querySelector('.sched-col'),
    U.$('bidsGridHost').querySelectorAll('.sched-col').length + ' period columns on All Bids');
  check('and All Bids does not offer it',
    !/setDensity\('employee'\)/.test(U.$('bidsGridHost').innerHTML));
  BidGrid.cfg().density = 'comfortable';

  // Switching back restores the columns that were arranged, untouched.
  Bids.setView('active');
  BidGrid.setDensity('comfortable');
  check('switching back restores the saved columns',
    BidGrid.activeColumns().length > 4,
    BidGrid.activeColumns().map(c => c.key).join(','));
  check('which the Employee view never wrote over',
    BidGrid.cfg().visible.indexOf('portal') >= 0,
    BidGrid.cfg().visible.join(','));
  check('including where Engineer sits - it is only moved on the schedule',
    BidGrid.activeColumns().slice(-1)[0].key !== 'team',
    BidGrid.activeColumns().map(c => c.key).join(','));
}

console.log('\n--- one colour per person ---');
{
  /* Three grey initials over a column of grey figures means counting lines to
     work out whose hours those are. Every person carries a colour instead, and
     it has to be the SAME colour in the name column and on the hours - which is
     the whole of what these checks are for. */
  const reg = Store.db.engineers;
  const af = Bids.findEngineer('AF') || Bids.addEngineer('AF', 'A Fitter');
  const mgj = Bids.findEngineer('MGJ') || Bids.addEngineer('MGJ', 'M G Jadhav');

  check('everybody in the register has a colour without anybody setting one',
    /^pal-\d+$/.test(Bids.colorClass('AF')), Bids.colorClass('AF'));
  check('and two people do not share one',
    Bids.colorClass('AF') !== Bids.colorClass('MGJ'),
    Bids.colorClass('AF') + ' vs ' + Bids.colorClass('MGJ'));
  check('the whole register is inside the palette',
    reg.every(e => Bids.colorOf(e) >= 1 && Bids.colorOf(e) <= Bids.PALETTE),
    reg.map(e => Bids.colorOf(e)).join(','));
  check('the first fourteen entries are fourteen different colours',
    new Set(reg.slice(0, Bids.PALETTE).map(e => Bids.colorOf(e))).size ===
      Math.min(reg.length, Bids.PALETTE),
    reg.slice(0, Bids.PALETTE).map(e => Bids.colorOf(e)).join(','));
  check('somebody the register has never heard of is grey, not a fifteenth colour',
    Bids.colorClass('ZZZ') === 'pal-none', Bids.colorClass('ZZZ'));

  // Choosing one by hand, and going back to the one they were given.
  const auto = Bids.colorOf(af);
  Bids.setEngineerColor(af.id, 9);
  check('a colour chosen by hand wins', Bids.colorClass('AF') === 'pal-9',
    Bids.colorClass('AF'));
  check('and is on the record, so it reaches every other browser',
    Store.db.engineers.filter(e => e.id === af.id)[0].color === 9);
  Bids.setEngineerColor(af.id, 0);
  check('Auto puts them back on the colour they were given',
    Bids.colorOf(af) === auto, Bids.colorOf(af) + ' vs ' + auto);
  check('with nothing left on the record to explain',
    Store.db.engineers.filter(e => e.id === af.id)[0].color === undefined);

  // ---- and now on the schedule, which is what it is for.
  Bids.setView('active');
  BidGrid.setDensity('employee');
  BidGrid.setZoom('week');
  BidGrid.setAnchor('2026-11-04');
  Bids.filterTable();

  const row = [...U.$('bidsGridHost').querySelectorAll('tr.sched-row')]
    .find(tr => /AF/.test(tr.textContent) && /MGJ/.test(tr.textContent));
  check('the Engineer column labels each person with their colour',
    row && row.querySelectorAll('td.sched-team .person-chip').length === 2,
    row ? row.querySelector('td.sched-team').innerHTML.slice(0, 120) : 'no row');

  const chipClass = i => [...row.querySelectorAll('td.sched-team .person-chip')][i]
    .className.match(/pal-\S+/)[0];
  const booked = [...row.querySelectorAll('td.sched-cell .sched-line.is-booked')];
  check('and the hours booked to them carry the same colour',
    booked.length > 0 && booked.every(s =>
      s.className.indexOf(chipClass(0)) >= 0 || s.className.indexOf(chipClass(1)) >= 0),
    booked.map(s => s.className.match(/pal-\S+/)[0]).join(','));
  check('a day with nothing booked stays clear, so the load wash still reads',
    [...row.querySelectorAll('td.sched-cell .sched-line')]
      .filter(s => s.textContent.trim() === '·')
      .every(s => !s.classList.contains('is-booked')));

  // The line height is what makes the frozen column and the calendar agree; a
  // label that added to it would put every figure in the month out of step.
  check('the label does not make the line taller than the figures beside it',
    row.querySelectorAll('td.sched-team .sched-line').length ===
      row.querySelector('td.sched-cell').querySelectorAll('.sched-line').length,
    row.querySelectorAll('td.sched-team .sched-line').length + ' vs ' +
      row.querySelector('td.sched-cell').querySelectorAll('.sched-line').length);

  // The same colour wherever the person is named.
  check('the bid table names them in the same colour',
    Bids.personChip('MGJ').indexOf(Bids.colorClass('MGJ')) >= 0,
    Bids.personChip('MGJ'));

  BidGrid.setDensity('comfortable');
  Bids.filterTable();
}

console.log('\n--- every change is recorded, by whom and when ---');
{
  Bids.setView('all');
  Bids.openAdd();
  U.$('mProject').value = 'Audit trail test';
  U.$('mPortal').value = 'PlanHub';
  U.$('mRegion').value = Store.db.regions[0];
  U.$('mStatus').value = 'Not Started';
  U.$('mPrice').value = '1000';
  Bids.save({ preventDefault() {} });
  const b = Store.db.bids.filter(x => x.project === 'Audit trail test')[0];

  check('creating a bid is recorded',
    History.entries(b).length === 1 && History.entries(b)[0].kind === 'created',
    JSON.stringify(History.entries(b)));
  check('stamped at the moment it was created',
    History.entries(b)[0].at === b.createdAt, History.entries(b)[0].at);

  // Through the form: one Save that moved three fields is one entry naming all
  // three, not three entries.
  Bids.edit(b.id);
  U.$('mPrice').value = '2000';
  U.$('mComments').value = 'client called';
  U.$('mStatus').value = 'In Progress';
  Bids.save({ preventDefault() {} });
  const formEdit = History.entries(b)[History.entries(b).length - 1];
  check('a form save records one entry for the whole save',
    formEdit.kind === 'edit' && formEdit.changes.length === 3,
    JSON.stringify(formEdit.changes));
  check('naming each field with its before and after',
    formEdit.changes.some(c => c.label === 'Bid Price' && /1,000/.test(c.from) && /2,000/.test(c.to)),
    JSON.stringify(formEdit.changes));
  check('and dates read in the format the rest of the app uses',
    (Bids.saveField(b.id, 'dueDate', '11-05-2026', 'date', null),
     History.entries(b).slice(-1)[0].changes[0].to === '11-05-2026'),
    JSON.stringify(History.entries(b).slice(-1)[0].changes));

  // Through the inline editor, and the coalescing that keeps it readable.
  const before = History.entries(b).length;
  Bids.saveField(b.id, 'link', 'https://one.example', 'text', null);
  Bids.saveField(b.id, 'link', 'https://two.example', 'text', null);
  check('two quick edits to one field become one entry',
    History.entries(b).length === before + 1, String(History.entries(b).length - before));
  const merged = History.entries(b).slice(-1)[0];
  check('keeping the original value and the latest one',
    merged.changes[0].from === '' && merged.changes[0].to === 'https://two.example',
    JSON.stringify(merged.changes));

  Bids.saveField(b.id, 'comments', 'a different field', 'textarea', null);
  check('but a different field is its own entry',
    History.entries(b).length === before + 2);

  // Typed something, thought better of it, put it back: nothing happened.
  const settled = History.entries(b).length;
  Bids.saveField(b.id, 'portal', 'PennBid', 'select', null);
  Bids.saveField(b.id, 'portal', 'PlanHub', 'select', null);
  check('an edit undone within the window leaves no entry',
    History.entries(b).length === settled, String(History.entries(b).length - settled));
  check('and the record really is back to where it started',
    b.portal === 'PlanHub', b.portal);

  // The two cards each summarise themselves into one readable line.
  Bids.promoteBid(b);
  const teamBefore = History.entries(b).length;
  Assign.add(b.id);
  const row = Assign.rows(b)[0];
  Assign.set(b.id, row.id, 'engineer', 'AF');
  const teamEntry = History.entries(b).slice(-1)[0];
  check('a team change is recorded as one readable line',
    teamEntry.kind === 'edit' && teamEntry.changes[0].label === 'Team & Hours' &&
    /AF/.test(teamEntry.changes[0].to),
    JSON.stringify(teamEntry.changes));
  check('rather than as a blob of JSON',
    !/[{[]/.test(teamEntry.changes[0].to), teamEntry.changes[0].to);
  check('and the team change did produce entries', History.entries(b).length > teamBefore);

  Products.add(b.id);
  const pl = Products.rows(b).slice(-1)[0];
  Products.onProductChange({ value: 'Bollard' }, b.id, pl.id);
  const prodEntry = History.entries(b).slice(-1)[0];
  check('so is a product change',
    prodEntry.changes[0].label === 'Products & Materials' &&
    /Bollard/.test(prodEntry.changes[0].to),
    JSON.stringify(prodEntry.changes));

  // Old entries predate `kind` and were all stage moves.
  const legacy = { id: 'h-old', at: '2026-01-02T03:04:05.000Z', by: 'MGJ',
                   from: 'intake', to: 'active' };
  b.history.unshift(legacy);
  check('an entry written before kind existed still renders',
    /Moved to/.test(History.card(b)) || History.entries(b).length > 0);
  b.history = b.history.filter(e => e.id !== 'h-old');

  // Every entry carries who and when.
  check('every entry has a timestamp',
    History.entries(b).every(e => /^\d{4}-\d{2}-\d{2}T/.test(e.at)),
    History.entries(b).map(e => e.at).join(','));
  check('and the card shows them in IST, newest first',
    /IST/.test(History.card(b)), History.card(b).slice(0, 200));
}

console.log('\n--- products carry their own materials ---');
{
  Bids.setView('active');
  const b = Bids.baseList()[0];

  // Every bid was migrated from the flat fields into rows.
  check('a seeded bid has product rows',
    Array.isArray(b.productLines), JSON.stringify(b.productLines));
  check('one row per product it already had',
    b.productLines.length === b.products.filter(Boolean).length,
    b.productLines.length + ' vs ' + b.products.length);

  // The flat fields are a projection now, rewritten from the rows.
  Products.add(b.id);
  const row = b.productLines[b.productLines.length - 1];
  Products.onProductChange({ value: 'Bollard' }, b.id, row.id);
  check('adding a product row reaches bid.products',
    b.products.indexOf('Bollard') >= 0, b.products.join('|'));

  Products.toggleMaterial(b.id, row.id, 'Aluminum');
  Products.toggleMaterial(b.id, row.id, 'Glass');
  check('a product can carry more than one material',
    Products.materialsOf(row).join('|') === 'Aluminum|Glass',
    Products.materialsOf(row).join('|'));
  check('and both reach bid.material',
    /Aluminum/.test(b.material) && /Glass/.test(b.material), b.material);

  Products.toggleMaterial(b.id, row.id, 'Glass');
  check('toggling one off removes it again',
    Products.materialsOf(row).join('|') === 'Aluminum', Products.materialsOf(row).join('|'));

  // Two products in the same material is one material, not two - or the
  // Material column's filter would offer it twice.
  const second = (Products.add(b.id), b.productLines[b.productLines.length - 1]);
  Products.onProductChange({ value: 'Railing' }, b.id, second.id);
  Products.toggleMaterial(b.id, second.id, 'Aluminum');
  check('a material shared by two products is listed once',
    (b.material.match(/Aluminum/g) || []).length === 1, b.material);

  Products.remove(b.id, second.id);
  check('removing a row takes its product off the bid',
    b.products.indexOf('Railing') < 0 || b.productLines.some(r => r.product === 'Railing'),
    b.products.join('|'));

  // The bid form is the quick intake path and must not flatten pairings the
  // card was used to make.
  Bids.edit(b.id);
  Bids.save({ preventDefault() {} });
  check('saving the bid form keeps the materials the card set',
    b.productLines.some(r => r.product === 'Bollard' &&
      Products.materialsOf(r).indexOf('Aluminum') >= 0),
    JSON.stringify(b.productLines));

  // Renaming a material in Settings carries onto every row using it.
  const before = Products.countMaterial('Aluminum');
  check('the material is counted across bids', before >= 1, String(before));
  Products.renameMaterial('Aluminum', 'Aluminium');
  check('a rename reaches the rows',
    Products.countMaterial('Aluminium') === before &&
    Products.countMaterial('Aluminum') === 0,
    Products.countMaterial('Aluminium') + '/' + Products.countMaterial('Aluminum'));
  check('and the derived field follows it', /Aluminium/.test(b.material), b.material);
  Products.renameMaterial('Aluminium', 'Aluminum');

  check('materials are a managed list like regions and task types',
    Array.isArray(Store.db.materials) && Store.db.materials.length >= 6,
    JSON.stringify(Store.db.materials));
}

console.log('\n--- a revised due date is the date that counts ---');
{
  Bids.setView('active');
  const b = Bids.baseList().filter(x => Bids.bucketOf(x) === 'open')[0];

  Bids.edit(b.id);
  U.$('mDueDate').value = '06-10-2026';
  U.$('mRevisedDueDate').value = '';
  Bids.save({ preventDefault() {} });
  check('with no revision, the due date stands',
    Bids.effectiveDueDate(b) === '2026-06-10', Bids.effectiveDueDate(b));
  check('and the bid is filed under that month', b.month === 5, String(b.month));

  Bids.edit(b.id);
  U.$('mRevisedDueDate').value = '07-22-2026';
  Bids.save({ preventDefault() {} });
  check('a revised date overrides it',
    Bids.effectiveDueDate(b) === '2026-07-22', Bids.effectiveDueDate(b));
  check('the original is kept, not overwritten', b.dueDate === '2026-06-10', b.dueDate);
  check('and the bid moves to the revised month', b.month === 6, String(b.month));

  // The grid sorts and reads on the effective date, and shows both.
  Bids.filterTable();
  const dueCol = BidGrid.COLUMNS.filter(c => c.key === 'dueDate')[0];
  check('the grid column reads the effective date',
    dueCol.value(b) === '2026-07-22', dueCol.value(b));
  check('and its cell shows what it was revised from',
    /07-22-2026/.test(dueCol.render(b)) && /06-10-2026/.test(dueCol.render(b)),
    dueCol.render(b));
  /* NEITHER DATE IS CROSSED OUT. The original used to be struck through under
     the revised one, which reads as cancelled - it is not, it is the date on
     the record and the reason the revision is worth knowing about. */
  check('with neither of them struck through',
    !/line-through/.test(dueCol.render(b)), dueCol.render(b));

  // The project page shows each field as itself: Due Date is the due date, not
  // a derived "whichever is in force" with the other crossed out beside it.
  Project.openFrom(b.id, 'active');
  Project.render();
  const cell = key => [...win.document.querySelectorAll('#section-project [data-edit]')]
    .find(el => JSON.parse(el.dataset.edit).field === key);
  check('the Due Date field shows the due date, plainly',
    cell('dueDate').textContent.trim() === '06-10-2026',
    cell('dueDate').textContent.trim());
  check('the Revised Due field shows the revision',
    /07-22-2026/.test(cell('revisedDueDate').textContent),
    cell('revisedDueDate').textContent.trim());
  check('and says which of the two the app works to',
    /in force/.test(cell('revisedDueDate').textContent));
  check('with nothing struck through on either',
    !/line-through/.test(cell('dueDate').innerHTML + cell('revisedDueDate').innerHTML));

  // And the schedule flags the revised date, since that is the one in force.
  check('the Employee schedule counts down to the revised date',
    Bids.effectiveDueDate(b) === '2026-07-22', Bids.effectiveDueDate(b));

  // A date that cannot exist must be refused, not stored as ''.
  Bids.edit(b.id);
  U.$('mRevisedDueDate').value = '02-30-2026';
  Bids.save({ preventDefault() {} });
  check('an impossible revised date blocks the save',
    b.revisedDueDate === '2026-07-22', b.revisedDueDate);
  check('and the field is flagged',
    /border-danger/.test(U.$('mRevisedDueDate').className));

  // Clearing it puts the original back in force.
  Bids.edit(b.id);
  U.$('mRevisedDueDate').value = '';
  Bids.save({ preventDefault() {} });
  check('clearing the revision restores the original',
    Bids.effectiveDueDate(b) === '2026-06-10', Bids.effectiveDueDate(b));
}

console.log('\n--- every bid records when it arrived ---');
{
  Bids.openAdd();
  U.$('mProject').value = 'Arrival stamp test';
  U.$('mPortal').value = 'PlanHub';
  U.$('mRegion').value = Store.db.regions[0];
  U.$('mStatus').value = 'Not Started';
  Bids.save({ preventDefault() {} });
  const fresh = Store.db.bids.filter(x => x.project === 'Arrival stamp test')[0];
  check('a new bid is stamped with a full timestamp',
    /^\d{4}-\d{2}-\d{2}T/.test(fresh.createdAt), String(fresh.createdAt));
  check('and is not marked as inferred', !fresh.createdAtInferred);
  check('a new bid starts in intake with no number',
    !fresh.active && !fresh.proposalNo, String(fresh.proposalNo));

  // Seeded bids predate the field, so theirs is inferred and says so.
  const seeded = Store.db.bids.filter(x => x.id !== fresh.id)[0];
  check('an existing bid was backfilled', seeded.createdAt !== undefined);
  check('and is marked as a guess rather than an observation',
    seeded.createdAtInferred === true, String(seeded.createdAtInferred));
}

console.log('\n--- the dashboard ---');
{
  App.switchTab('dashboard');

  const kpi = id => U.$(id).textContent;
  check('the KPI row counts every bid', kpi('kpiTotal') === String(Store.db.bids.length),
    kpi('kpiTotal'));
  // Each figure carries the one fact that makes it mean something; a blank
  // note means the tile is back to being a number with no context.
  check('and every tile says something underneath it',
    ['kpiTotal', 'kpiSubmitted', 'kpiProgress', 'kpiAwarded', 'kpiValue']
      .every(id => U.$(id + 'Note').textContent.trim().length > 0));

  const strip = U.$('monthGrid');
  check('the month strip has one bar per month', strip.children.length === 12,
    String(strip.children.length));
  check('and every bar can be clicked to filter',
    [...strip.children].every(el => /selectMonth/.test(el.getAttribute('onclick'))));

  check('needs-attention rendered something', U.$('attentionList').innerHTML.length > 0);

  /* NEEDS ATTENTION IS A TO-DO LIST, so it may not hide its tail and it may not
     nag about work that is finished.

     The panel used to print four rows and "and N more" under a count of eight,
     which is the worst of both: it tells you there is something you cannot
     reach. It now renders every row and the card scrolls. And Completed sits in
     the `open` bucket - done, but not yet won or lost - so a finished job went
     on reporting itself overdue until somebody archived it. */
  {
    const panel = U.$('attentionList');
    const due = [...panel.querySelectorAll('div')]
      .find(d => /Due within 7 days/i.test(d.textContent));
    const rowsFor = () => {
      const heads = [...panel.children];
      const group = heads.find(g => /Due within 7 days/i.test(g.textContent));
      return group ? [...group.querySelectorAll('button')] : [];
    };
    const countFor = () => {
      const group = [...panel.children].find(g => /Due within 7 days/i.test(g.textContent));
      return group ? Number(group.querySelector('span.tabular-nums').textContent) : 0;
    };
    check('the due list has a heading with a count', !!due && countFor() > 0,
      String(countFor()));
    check('and shows every row it counts, not the first four',
      rowsFor().length === countFor(), `${rowsFor().length} rows, count says ${countFor()}`);
    check('so nothing is stranded behind an "and N more"',
      !/and \d+ more/.test(panel.innerHTML));

    // Take the most overdue bid and mark it done; it should leave the list.
    const overdue = rowsFor()[0];
    const id = Number(/Project\.open\((\d+)\)/.exec(overdue.getAttribute('onclick'))[1]);
    const bid = Store.db.bids.find(b => b.id === id);
    const before = countFor();
    const wasStatus = bid.status;
    bid.status = 'Completed';
    Bids.refresh();
    check('a bid marked Completed stops being reported as due',
      countFor() === before - 1 &&
      !rowsFor().some(r => r.getAttribute('onclick').includes('open(' + id + ')')),
      `${before} -> ${countFor()}`);
    bid.status = wasStatus;
    Bids.refresh();
    check('and comes back when it is reopened', countFor() === before,
      `${countFor()} vs ${before}`);
  }

  // The redundant Monthly Bid Volume chart went; the month strip is the same
  // twelve numbers and is also the filter.
  check('there is no second copy of the month figures', U.$('monthChart') === null);
}

console.log('\n--- the bids grid ---');
{
  App.switchTab('active');
  const grid = U.$('bidsGridHost');

  // Scrolling right used to take the project name off the screen, so THAT is
  // the column that has to be frozen - checking "something is frozen" passes
  // happily while Sr. No. is pinned on its own and Project sails away.
  const heads = [...grid.querySelectorAll('thead th')].map(th => th.textContent.trim());
  const frozenHeads = [...grid.querySelectorAll('thead th.col-sticky')]
    .map(th => th.textContent.trim());
  check('the project name is frozen', frozenHeads.some(h => /^Project/.test(h)),
    JSON.stringify(frozenHeads));
  check('and the frozen ones lead the table',
    heads.slice(0, frozenHeads.length).join('|') === frozenHeads.join('|'),
    JSON.stringify(heads.slice(0, 4)));

  const frozen = [...grid.querySelectorAll('tbody tr:first-child .col-sticky')];
  check('every row freezes the same columns', frozen.length === frozenHeads.length,
    frozen.length + ' vs ' + frozenHeads.length);
  check('and each one is told where its left edge is',
    frozen.every(td => /left:\d+px/.test(td.getAttribute('style') || '')));
  check('the last frozen column carries the edge',
    grid.querySelectorAll('tbody tr:first-child .col-sticky-edge').length === 1);

  // Every row the same height, whatever is in it.
  const rowClasses = [...grid.querySelectorAll('tbody tr')].map(tr => tr.className);
  check('every row is given the same height',
    rowClasses.length > 1 && new Set(rowClasses.map(c => /h-\[\d+px\]/.exec(c)?.[0])).size === 1,
    JSON.stringify([...new Set(rowClasses)].slice(0, 3)));

  // Actions lead the row and are one button, not a cluster of six at the far
  // right that you had to scroll the project name away to reach.
  check('Actions is the first column',
    BidGrid.activeColumns()[0].key === 'actions',
    BidGrid.activeColumns().map(c => c.key).join(','));
  check('and is frozen with the identity block',
    !!grid.querySelector('thead th.col-sticky') &&
    grid.querySelectorAll('thead th')[0].classList.contains('col-sticky'));

  const cell = Bids.actionCell(Store.db.bids[0]);
  const buttons = (cell.match(/<button|<a /g) || []).length;
  check('a row offers exactly one control', buttons === 1, String(buttons));
  check('and everything else is behind its menu', /openRowMenu/.test(cell));
  check('the menu names its actions in words, not just icons',
    /Edit bid/.test(Bids.rowMenu(Store.db.bids[0])), Bids.rowMenu(Store.db.bids[0]));

  // Column widths: per view, persisted with the rest of the layout, and fed
  // back into the frozen block's left offsets.
  check('every header offers a resize grip',
    grid.querySelectorAll('thead .col-resize').length ===
      BidGrid.activeColumns().length,
    grid.querySelectorAll('thead .col-resize').length + ' of ' +
      BidGrid.activeColumns().length);

  BidGrid.cfg().widths.project = 320;
  Bids.filterTable();
  const projIdx = BidGrid.activeColumns().findIndex(c => c.key === 'project');
  const projTh = U.$('bidsGridHost').querySelectorAll('thead th')[projIdx];
  check('a set width reaches the header cell',
    /width:\s*320px/.test(projTh.getAttribute('style') || ''),
    projTh.getAttribute('style'));
  // Project is frozen, so everything frozen to its right shifts with it.
  const after = [...U.$('bidsGridHost').querySelectorAll('thead th.col-sticky')];
  const lefts = after.map(th => /left:(\d+)px/.exec(th.getAttribute('style') || '')?.[1]);
  check('the frozen offsets are recomputed from it',
    lefts.every(v => v !== undefined) &&
    lefts.map(Number).every((v, i, a) => i === 0 || v > a[i - 1]),
    lefts.join(','));

  check('widths are remembered per view, not globally',
    (Bids.setView('all'), !BidGrid.cfg().widths.project));
  Bids.setView('active');
  check('and are still there on the view they were set on',
    BidGrid.cfg().widths.project === 320);

  BidGrid.resetWidths();
  check('Reset widths clears them',
    Object.keys(BidGrid.cfg().widths).length === 0);
  check('and leaves the columns themselves alone',
    BidGrid.activeColumns().some(c => c.key === 'project'));

  Bids.filterTable();
  check('the density toggle is on the table', /setDensity/.test(grid.innerHTML));
  BidGrid.setDensity('compact');
  check('and compact really is shorter',
    /h-\[36px\]/.test(U.$('bidsGridHost').innerHTML));
  check('which is remembered with the rest of the layout',
    Store.db.ui.grids.active.density === 'compact');
  BidGrid.setDensity('comfortable');
}

console.log('\n--- where the app opens ---');
{
  /* Opening the app and reloading it are different events and want opposite
     answers. The marker is per tab, so it tells them apart. */
  const SECTION = 'dv.tab.section';
  const BID = 'dv.tab.bid';
  const before = Store.db.ui.section;

  win.sessionStorage.clear();
  Store.db.ui.section = 'proposal';        // where this person last was
  check('a fresh tab opens on the Dashboard, not where anybody was last',
    Nav.initialSection() === 'dashboard', Nav.initialSection());

  // Navigating writes the marker, so a reload of this tab stays put.
  Bids.setView('all');
  App.switchTab('all');
  check('navigating remembers the page for this tab',
    win.sessionStorage.getItem(SECTION) === 'all',
    win.sessionStorage.getItem(SECTION));
  check('and a reload comes back to it',
    Nav.initialSection() === 'all', Nav.initialSection());

  // On a project, the project itself is remembered too - ui.projectBidId is
  // shared by every tab and so is whichever one moved last.
  const b = Bids.baseList()[0];
  Project.openFrom(b.id, 'all');
  check('a project page remembers which project',
    Nav.tabBidId() === b.id, String(Nav.tabBidId()));
  // Leaving the project page keeps it: this is the project THIS tab was last
  // looking at, and it is only ever a hint for what to reopen. The page it
  // lands on is the marker above, so a reload here comes back to All Bids -
  // with the same project behind it if you go back in.
  App.switchTab('all');
  check('leaving the project page keeps which project it was',
    Nav.tabBidId() === b.id && win.sessionStorage.getItem(SECTION) === 'all',
    Nav.tabBidId() + ' / ' + win.sessionStorage.getItem(SECTION));

  // A page the role cannot open is never landed on.
  check('an unknown marker is ignored',
    (win.sessionStorage.setItem(SECTION, 'nonsense'), Nav.initialSection() === 'dashboard'),
    Nav.initialSection());

  /* THE BOOT PATH ITSELF, not just the function that decides.
     Reopening the last takeoff and proposal is part of starting up, and each of
     them navigates to its own page on the way - which wrote this tab's marker.
     So the proposal set the marker to 'proposal' and the landing decision, read
     afterwards, found it there. Every load opened the proposal, whatever you
     had been doing; going somewhere else first did not help, because the next
     boot overwrote the marker again before reading it.

     Asserting through App.resumeLastSession because the ordering IS the fix -
     testing Nav.initialSection alone is what let this through. */
  const hasProposal = Object.keys(Store.db.proposals)[0];
  Store.db.ui.lastProposalId = hasProposal;
  Store.db.ui.lastTakeoffId = Object.keys(Store.db.takeoffs)[0];

  win.sessionStorage.clear();
  App.resumeLastSession();
  check('a fresh tab still opens on the Dashboard with a proposal to reopen',
    App.currentTab === 'dashboard', App.currentTab);

  win.sessionStorage.setItem(SECTION, 'all');
  App.resumeLastSession();
  check('and a reload comes back to the page you were on, not the proposal',
    App.currentTab === 'all', App.currentTab);
  check('which is what the marker still says afterwards',
    win.sessionStorage.getItem(SECTION) === 'all',
    win.sessionStorage.getItem(SECTION));

  Store.db.ui.lastProposalId = null;
  Store.db.ui.lastTakeoffId = null;

  win.sessionStorage.removeItem(SECTION);
  win.sessionStorage.removeItem(BID);
  Store.db.ui.section = before;
  Bids.setView('active');
  App.switchTab('active');
}

console.log('\n--- the user guide ---');
{
  const { Guide } = win;
  check('the guide has sections', Guide.SECTIONS.length >= 10, String(Guide.SECTIONS.length));
  check('each one says what it is and gives details',
    Guide.SECTIONS.every(s => s.key && s.title && s.blurb && s.points.length),
    Guide.SECTIONS.filter(s => !(s.blurb && s.points.length)).map(s => s.key).join(','));
  check('and it is honest about the modules that are not built',
    /not built/i.test(Guide.SECTIONS.map(s => s.title + ' ' + s.blurb).join(' ')));

  // The sign-in page shows the headline half of the same document, so the two
  // cannot drift apart.
  const lead = Guide.SECTIONS.filter(s => s.lead);
  check('the sign-in page shows the lead sections', lead.length >= 3, String(lead.length));
  const landing = Guide.landing();
  check('and draws every one of them',
    lead.every(s => landing.indexOf(U.esc(s.title)) >= 0), landing.slice(0, 120));

  Guide.open();
  const modal = U.$('guideModal');
  check('Help opens the full guide', !modal.classList.contains('hidden'));
  check('with every section in it',
    Guide.SECTIONS.every(s => modal.querySelector('#guide-' + s.key)),
    Guide.SECTIONS.filter(s => !modal.querySelector('#guide-' + s.key)).map(s => s.key).join(','));
  check('and a way out', /Guide.close\(\)/.test(modal.innerHTML));
  Guide.close();
  check('which closes it', modal.classList.contains('hidden'));

  check('the Help button is in the header',
    /Guide.open\(\)/.test(U.$('headerActions').innerHTML));

  // The sign-in screen. The harness runs with no server, so the gate never
  // opens on its own - this is what it would draw.
  const gate = win.Auth.gateHTML();
  check('the sign-in page carries the form',
    /authUsername/.test(gate) && /authPassword/.test(gate) &&
    /Auth.submitLogin/.test(gate), gate.slice(0, 100));
  check('and says what the app is, rather than only asking who you are',
    lead.every(s => gate.indexOf(U.esc(s.title)) >= 0));
  check('with a way into the guide before signing in',
    /Guide.openFromGate\(\)/.test(gate));

  /* THE WELD. The scene is drawn from js/intro.js and animated with the same
     spark engine as the banner. jsdom has no layout and no canvas, so what can
     be checked here is that the scene is built, that it degrades to the
     finished mark rather than throwing, and that the guards hold. */
  check('the sign-in page welds the mark rather than just showing it',
    /introStage/.test(gate) && /introSparks/.test(gate) && /intro-arc/.test(gate));
  check('and carries the company\'s own words, not invented ones',
    /Trust Through Quality Work/.test(gate) && /Safety is our foundation/.test(gate));
  check('with the buttons under it',
    /Intro.play\(\)/.test(gate) && /User guide/.test(gate) && /About this app/.test(gate));

  // Mounting it with no layout must settle to the finished mark and touch no
  // canvas - which is what stops the test harness reporting a jsdom error.
  U.$('bootOverlay').innerHTML = gate;
  win.Intro.mount();
  check('with no layout engine it settles instead of animating',
    U.$('introStage').classList.contains('is-welded'));
  check('and the words are up rather than waiting for an animation that cannot run',
    U.$('introWords').classList.contains('is-in'));
  check('the spark engine was never asked for a drawing context',
    !win.Sparks.isRunning());

  // The password field.
  check('the password is hidden to start with',
    U.$('authPassword').type === 'password', U.$('authPassword').type);
  win.Auth.toggleReveal('authPassword');
  check('and can be shown, because a password you cannot see is one you mistype',
    U.$('authPassword').type === 'text', U.$('authPassword').type);
  check('the button says what it will do next',
    /eye-slash/.test(U.$('authPasswordEye').innerHTML) &&
    U.$('authPasswordEye').getAttribute('aria-label') === 'Hide the password');
  win.Auth.toggleReveal('authPassword');
  check('and hides it again', U.$('authPassword').type === 'password');
  check('the reveal button is out of the tab order - Tab belongs to Sign in',
    U.$('authPasswordEye').tabIndex === -1, String(U.$('authPasswordEye').tabIndex));

  // Caps Lock, the most common cause of "the password does not work".
  const caps = on => win.Auth.capsCheck({ getModifierState: k => k === 'CapsLock' && on });
  caps(true);
  check('Caps Lock is called out', !U.$('capsWarn').classList.contains('hidden'));
  caps(false);
  check('and the warning clears with it', U.$('capsWarn').classList.contains('hidden'));

  U.$('bootOverlay').innerHTML = '';
}

console.log('\n--- who else is on this project ---');
{
  const { Presence } = win;
  const b = Bids.baseList()[0];
  const other = Bids.baseList()[1];

  // What the server sends: one entry per connection, ours included.
  Presence.adopt([
    { clientId: 1, userId: 7, name: 'Meera Joshi', initials: 'MGJ',
      where: { bidId: b.id, section: 'takeoff' } },
    { clientId: 2, userId: 9, name: 'Ravi Kumar', initials: null,
      where: { bidId: other.id, section: 'project' } },
    { clientId: 3, userId: 7, name: 'Meera Joshi', initials: 'MGJ',
      where: { bidId: b.id, section: 'proposal' } }
  ]);

  check('somebody else on this project is seen',
    Presence.on(b.id).length === 1, JSON.stringify(Presence.on(b.id)));
  check('one person with two windows on it is still one person',
    Presence.on(b.id)[0].initials === 'MGJ');
  check('and somebody on another project is not on this one',
    Presence.on(other.id).length === 1 && Presence.on(other.id)[0].name === 'Ravi Kumar');
  check('a project nobody has open is quiet',
    Presence.on(-1).length === 0);

  const chip = Presence.headerChip(b.id);
  check('the project header says who is here', /MGJ/.test(chip), chip);
  check('and names them in full on hover', /Meera Joshi/.test(chip));
  check('the bids table marks the row', /fa-eye/.test(Presence.rowMark(b.id)));
  check('and leaves the others alone', Presence.rowMark(-1) === '');
  check('somebody with no initials still gets a badge',
    /RK/.test(Presence.headerChip(other.id)), Presence.headerChip(other.id));

  // Nobody is told about themselves.
  Presence.adopt([{ clientId: 4, userId: null, name: 'Anon', initials: null,
                    where: { bidId: b.id, section: 'project' } }]);
  check('an empty list clears the marks',
    (Presence.adopt([]), Presence.rowMark(b.id) === '' && Presence.headerChip(b.id) === ''));
}

console.log('\n--- the theme is a setting, not a stylesheet ---');
{
  const html = win.document.documentElement;
  // Cycling is light -> dark -> auto, and lands on the class the CSS keys off.
  Store.db.ui.theme = 'light';
  App.cycleTheme();
  check('cycling from light gives dark', Store.db.ui.theme === 'dark', Store.db.ui.theme);
  check('and puts the class on <html>', html.classList.contains('dark'));

  App.cycleTheme();
  check('cycling again gives auto', Store.db.ui.theme === 'auto', Store.db.ui.theme);
  // jsdom reports no colour-scheme preference, so auto resolves to light here.
  check('auto follows the machine, which is light in jsdom',
    !html.classList.contains('dark'));

  App.cycleTheme();
  check('and round-trips back to light', Store.db.ui.theme === 'light', Store.db.ui.theme);
  check('with the class taken off again', !html.classList.contains('dark'));

  // The <head> script reads this before the database has opened, so it is what
  // actually prevents the white flash on a dark app.
  check('the choice is mirrored where the boot script can see it',
    win.localStorage.getItem('dv.theme') === 'light',
    String(win.localStorage.getItem('dv.theme')));

  Store.db.ui.theme = 'dark';
  check('resetting the table layout does not turn the lights back on',
    (Store.resetLayout(), Store.db.ui.theme === 'dark'), Store.db.ui.theme);

  // Nothing in the app should be carrying its own dark-mode variants: the
  // colours are CSS variables and .dark redefines them in one file.
  const sources = localScripts.map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('');
  check('and no module carries a dark: variant of its own',
    !/\bdark:[a-z-]/.test(sources));

  /* THE GHOST ON THE SIGN-IN PAGE. The specular sweep is masked to the logo,
     and a mask travels with the element it is on - so translating it slid a
     logo-shaped white highlight off the plate and painted a copy of the mark on
     the panel beside it. The element must stay put and the gradient move
     inside it. jsdom will not run the animation, so this is read off the
     stylesheet, which is where the bug was. */
  const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
  const glossFrames = (css.match(/@keyframes intro-gloss \{[^}]*\}/) || [''])[0];
  check('the logo highlight moves its gradient, not itself',
    /background-position/.test(glossFrames) && !/transform/.test(glossFrames),
    glossFrames.replace(/\s+/g, ' '));
  check('so nothing masked to the mark can be drawn outside it',
    /\.intro-gloss \{[^}]*background-position/.test(css));
  check('and the strapline sits centred under the logo',
    /\.intro-words \{[^}]*text-align: center/.test(css));

  // Fourteen colours, and js/bids.js hands out exactly that many.
  check('every colour the code can hand out is defined in the stylesheet',
    Array.from({ length: win.Bids.PALETTE }, (_, i) => i + 1)
      .every(n => new RegExp('\\.pal-' + n + '\\s*\\{').test(css)),
    'PALETTE=' + win.Bids.PALETTE);
  check('and none of them are dark - they sit behind initials and figures',
    (css.match(/^\.pal-\d+\s*\{ --pal:\s*(\d+) (\d+) (\d+);/gm) || [])
      .every(line => {
        const [r, g, b] = line.match(/--pal:\s*(\d+) (\d+) (\d+)/).slice(1).map(Number);
        return (r * 299 + g * 587 + b * 114) / 1000 > 100;   // perceived brightness
      }));
}

console.log('\n--- a database from the last build comes forward ---');
{
  /* The three office-review changes that need a migration, driven through it
     rather than inferred from a fresh seed - which would pass on the defaults
     whether or not the step ran. */
  const old = {
    schemaVersion: 16,
    bids: [{ id: 1, project: 'Old one', status: 'Completed', assignments: [] }],
    takeoffs: {}, proposals: {}, catalog: [], engineers: [], regions: [],
    company: { name: 'DiVerse' },
    ui: { grids: { active: { order: ['sr', 'team', 'status'], visible: ['sr', 'team', 'status'] },
                   all:    { order: ['sr', 'team', 'status'], visible: ['sr', 'team', 'status'] } } }
  };
  const up = Store.migrate(JSON.parse(JSON.stringify(old)));

  check('it reaches the current schema', up.schemaVersion === Store.SCHEMA_VERSION,
    up.schemaVersion + ' vs ' + Store.SCHEMA_VERSION);
  check('the working day is written rather than left to a default',
    up.company.dayHours === 9, String(up.company.dayHours));
  check('and the company details it already had are untouched',
    up.company.name === 'DiVerse', up.company.name);

  /* The relationship, not the whole string: later steps append columns of
     their own, and an exact match would fail every time one is added without
     anything actually being wrong. */
  check('the Task column lands directly after Engineer',
    up.ui.grids.active.order.indexOf('task') ===
      up.ui.grids.active.order.indexOf('team') + 1,
    up.ui.grids.active.order.join(','));
  check('switched on where there is a team to describe',
    up.ui.grids.active.visible.indexOf('task') >= 0,
    up.ui.grids.active.visible.join(','));
  check('and off on the intake register, where nobody is booked yet',
    up.ui.grids.all.visible.indexOf('task') < 0,
    up.ui.grids.all.visible.join(','));

  /* Nothing is invented for a bid that was only ever bid once. */
  check('an existing bid is not retrospectively made a revision',
    up.bids[0].revision === null && up.bids[0].revisionOf === null &&
    up.bids[0].reopenedInto === null,
    JSON.stringify([up.bids[0].revision, up.bids[0].revisionOf, up.bids[0].reopenedInto]));
  check('and it keeps the status it had', up.bids[0].status === 'Completed');

  /* LAST MODIFIED, backfilled from the log each bid has been keeping all
     along - the newest entry IS the last time anything happened to it. */
  check('Last Modified lands after Status',
    up.ui.grids.active.order.indexOf('lastModified') ===
      up.ui.grids.active.order.indexOf('status') + 1,
    up.ui.grids.active.order.join(','));
  check('switched on where work is actually happening',
    up.ui.grids.active.visible.indexOf('lastModified') >= 0 &&
    up.ui.grids.all.visible.indexOf('lastModified') < 0,
    up.ui.grids.all.visible.join(','));

  const withLog = Store.migrate({
    schemaVersion: 17, bids: [
      { id: 1, project: 'Worked', createdAt: '2026-01-01T00:00:00.000Z', assignments: [],
        history: [{ id: 'h1', at: '2026-01-01T00:00:00.000Z', by: 'MGJ', kind: 'created' },
                  { id: 'h2', at: '2026-05-05T09:30:00.000Z', by: 'AJP', kind: 'edit',
                    changes: [{ field: 'price', label: 'Bid Price', from: '', to: '$10' }] }] },
      { id: 2, project: 'Never touched', createdAt: '2026-02-02T00:00:00.000Z',
        assignments: [], history: [] }
    ],
    takeoffs: {}, proposals: {}, catalog: [], engineers: [], regions: [], ui: {}
  });
  check('a worked bid is stamped with its newest entry, and who made it',
    withLog.bids[0].updatedAt === '2026-05-05T09:30:00.000Z' &&
    withLog.bids[0].updatedBy === 'AJP',
    withLog.bids[0].updatedAt + ' / ' + withLog.bids[0].updatedBy);
  /* NOT stamped as today. Marking the whole register modified now would put
     ninety bids nobody has touched in a year at the top of a column whose
     only job is to say what is being worked on. */
  check('and one nobody has touched falls back to when it arrived',
    withLog.bids[1].updatedAt === '2026-02-02T00:00:00.000Z',
    String(withLog.bids[1].updatedAt));
}

console.log('\n--- how long ago that was ---');
{
  const mins = n => new Date(Date.now() - n * 60000).toISOString();
  check('a moment ago reads as now', U.ago(mins(0.2)) === 'just now', U.ago(mins(0.2)));
  check('minutes', U.ago(mins(7)) === '7m ago', U.ago(mins(7)));
  check('and hours once it is past one', /^\dh ago$/.test(U.ago(mins(150))), U.ago(mins(150)));
  /* A clock behind the server's, or a record stamped a moment ahead. Reading
     "in 3 minutes" off an audit trail is worse than rounding it to now. */
  check('a timestamp in the future rounds to now rather than counting down',
    U.ago(mins(-3)) === 'just now', U.ago(mins(-3)));
  check('nothing is an empty string, not a dash or NaN',
    U.ago('') === '' && U.ago(null) === '' && U.ago('not a date') === '',
    JSON.stringify([U.ago(''), U.ago(null), U.ago('not a date')]));

  /* DAYS ARE CALENDAR DAYS. 23:50 and 00:10 are twenty minutes apart and are
     different days, and a reader who has turned a page of the calendar cares
     which. Dividing elapsed hours would call that "0d ago" and mean
     yesterday, so U.ago compares the two IST dates instead. */
  const istDay = v => U.stampISO(v);
  const today = istDay(new Date());
  const backTo = iso => {
    let n = 1;
    while (istDay(mins(n * 60)) === today && n < 72) n++;
    return n;
  };
  const yesterdayHrs = backTo();
  check('the first instant on the previous IST day reads as yesterday',
    U.ago(mins(yesterdayHrs * 60)) === 'yesterday',
    U.ago(mins(yesterdayHrs * 60)) + ' at -' + yesterdayHrs + 'h');
  check('then days', /^\dd ago$/.test(U.ago(mins(3 * 1440))), U.ago(mins(3 * 1440)));
  check('and past a week it is just the date',
    U.ago(mins(30 * 1440)) === U.date(U.stampISO(mins(30 * 1440))),
    U.ago(mins(30 * 1440)));
}

console.log('\n--- the takeoff and the proposal reach the history ---');
{
  const b = Store.db.bids.filter(x => x.takeoffId && Store.db.takeoffs[x.takeoffId])[0];
  const t = Store.db.takeoffs[b.takeoffId];
  b.history = [];

  /* A DIGEST, NOT A DIFF OF THE DOCUMENT. A takeoff is thousands of cells;
     what the log keeps is what somebody reading back asks - how big it got and
     what it came to. */
  const snap = History.snapshotDoc(t, 'takeoff');
  check('a takeoff snapshot is a handful of figures, not the document',
    Object.keys(snap).length < 15 && 'total' in snap && 'base' in snap,
    Object.keys(snap).join(','));

  t.rollup.taxPct = U.n(t.rollup.taxPct) + 1;
  const changes = History.diffDoc(snap, t, 'takeoff');
  check('changing the tax rate moves the tax and the total together',
    changes.some(c => c.f === 'taxPct') && changes.some(c => c.f === 'total'),
    changes.map(c => c.f).join(','));
  check('and each change is stored compactly, with the label left out',
    changes.every(c => 'f' in c && 'a' in c && 'b' in c && !('label' in c)),
    JSON.stringify(changes[0]));
  check('the label is looked up when it is drawn, not stored on every entry',
    History.docLabel('takeoff', 'total') === 'Takeoff total',
    History.docLabel('takeoff', 'total'));

  History.recordDoc(b, 'takeoff', changes);
  check('which lands in the bid\'s own history, beside everything else',
    History.entries(b).length === 1 && History.entries(b)[0].doc === 'takeoff',
    JSON.stringify(History.entries(b)[0]));

  /* SESSION COALESCING. Ten minutes of estimating is one entry saying where
     the total started and where it ended - not two hundred saying nothing. */
  for (let i = 0; i < 40; i++) {
    const before = History.snapshotDoc(t, 'takeoff');
    t.rollup.freight = U.n(t.rollup.freight) + 25;
    History.recordDoc(b, 'takeoff', History.diffDoc(before, t, 'takeoff'));
  }
  check('forty edits in a sitting stay one entry', History.entries(b).length === 1,
    String(History.entries(b).length));
  const merged = History.entries(b)[0].c.filter(c => c.f === 'freight')[0];
  /* The EARLIEST from and the LATEST to. Freight started at nothing, so the
     entry reads "empty -> $1,000" rather than "$975 -> $1,000" - which would
     be the last keystroke of the session rather than the session itself. */
  check('keeping where the figure started and where it got to',
    merged && merged.a === '' && merged.b === U.currency(U.n(t.rollup.freight)),
    JSON.stringify(merged) + ' vs ' + U.currency(U.n(t.rollup.freight)));

  // A value typed and then put back is not a change and does not survive.
  b.history = [];
  const t0 = History.snapshotDoc(t, 'takeoff');
  t.rollup.miscPct = 99;
  History.recordDoc(b, 'takeoff', History.diffDoc(t0, t, 'takeoff'));
  const t1 = History.snapshotDoc(t, 'takeoff');
  t.rollup.miscPct = U.n(t0.miscPct);
  History.recordDoc(b, 'takeoff', History.diffDoc(t1, t, 'takeoff'));
  check('a figure typed and then put back leaves nothing behind',
    History.entries(b).length === 0, JSON.stringify(History.entries(b)));

  /* AN EXPORT IS A FACT even though nothing on the record moved. */
  History.recordDocEvent(b, 'proposal', 'exported-pdf');
  check('sending a PDF is recorded', History.entries(b).length === 1 &&
    History.entries(b)[0].event === 'exported-pdf');
  check('and is not merged into an edit', !History.entries(b)[0].c);

  /* THE SIZE BUDGET - the one that matters. bid.history rides inside the bid's
     JSON blob, and past LOG_BODY_MAX (32KB) the server stops sending that blob
     in the change log and every browser has to refetch it instead. */
  b.history = [];
  const day = 86400000;
  for (let i = 0; i < 400; i++) {
    History.entries(b).push({
      id: 'h' + i,
      at: new Date(Date.now() - (30 - (i % 30)) * day).toISOString(),
      /* Author on a modulus COPRIME WITH 30, which is what the day spreads on.
         A group is one document on one day - so it holds i, i+30, i+60 ... and
         30 is divisible by both 2 and 3. Picking the author on either of those
         would hand every group a single person by accident, and the "names
         everyone" check below would pass without testing anything. */
      by: ['AJP', 'SSJ'][i % 7 < 3 ? 0 : 1],
      kind: 'doc', doc: i % 2 ? 'takeoff' : 'proposal',
      c: [{ f: 'total', a: '$' + (100000 + i), b: '$' + (100001 + i) },
          { f: 'base', a: '$' + (90000 + i), b: '$' + (90001 + i) }]
    });
  }
  const raw = History.size(b);
  History.compact(b);
  const after = History.size(b);

  console.log('   [size] 400 doc entries: ' + raw + ' -> ' + after + ' bytes; bid total ' + JSON.stringify(b).length);
  check('four hundred entries compact down',
    after < raw / 4, raw + ' -> ' + after);
  check('and inside the budget, so the record keeps travelling in the change log',
    after <= History.HISTORY_BUDGET, after + ' vs ' + History.HISTORY_BUDGET);
  check('which keeps the whole bid clear of the 32KB ceiling',
    JSON.stringify(b).length < 32768, String(JSON.stringify(b).length));

  /* NOTHING IS SILENTLY DROPPED. The rollup changes the RESOLUTION of old
     entries, never their existence - so what they stood for is still readable. */
  const rolled = History.entries(b).filter(e => e.rolled && e.rolled.n > 1);
  check('the entries that went are accounted for, not discarded',
    rolled.length > 0 &&
    History.entries(b).reduce((s, e) => s + (e.rolled ? e.rolled.n : 1), 0) === 400,
    History.entries(b).reduce((s, e) => s + (e.rolled ? e.rolled.n : 1), 0) + ' of 400');
  check('each summary says what it stands for, and over what dates',
    rolled.every(e => e.rolled.from && e.rolled.to && e.rolled.from <= e.rolled.to),
    JSON.stringify(rolled[0].rolled));
  check('and names everyone whose edits it covers',
    rolled.some(e => e.rolled.by.length === 2), JSON.stringify(rolled[0].rolled.by));
  check('the net movement survives the fold',
    rolled.every(e => (e.c || []).every(c => c.a !== c.b)));

  // Today's entries keep full detail - the log is most precise when somebody
  // is actually looking at it.
  b.history = [];
  History.recordDoc(b, 'takeoff', [{ f: 'total', a: '$1', b: '$2' }]);
  History.compact(b);
  check('today\'s entries are not rolled up', !History.entries(b)[0].rolled);

  /* STAGE MOVES AND BID EDITS ARE NEVER FOLDED. They are the record the office
     is answerable to; only the document chatter is compressible. */
  b.history = [];
  History.record(b, 'intake', 'active', { fromStatus: 'Not Started' });
  for (let i = 0; i < 400; i++) {
    History.entries(b).push({
      id: 'x' + i, at: new Date(Date.now() - 5 * day).toISOString(),
      by: 'AJP', kind: 'doc', doc: 'takeoff',
      c: [{ f: 'total', a: '$' + i, b: '$' + (i + 1) }]
    });
  }
  History.compact(b);
  check('a stage move is never folded away, however long the log gets',
    History.entries(b).some(e => (e.kind || 'stage') === 'stage'),
    History.entries(b).map(e => e.kind || 'stage').join(',').slice(0, 60));

  /* THE CARD. Document entries outnumber everything else on a worked job, so
     they can be narrowed to rather than burying the stage moves. */
  b.history = [];
  History.recordCreated(b);
  History.recordDoc(b, 'takeoff', [{ f: 'total', a: '$1', b: '$2' }]);
  History.recordDocEvent(b, 'proposal', 'exported-pdf');
  // The card starts collapsed, so everything below is about its body.
  if (!History.isOpen(b)) History.toggle(b.id);
  const card = () => History.card(b);
  check('the card offers a filter once there are documents in the log',
    /History.setFilter/.test(card()), 'no filter chips');
  check('and says which document each entry is about',
    /TakeOff/.test(card()) && /Proposal/.test(card()));
  check('an export reads as what it is',
    /exported to PDF/.test(card()), 'no export line');
  History.setFilter(b.id, 'bid');
  /* Both halves asserted. Checking only that the export is ABSENT would pass
     just as well on a collapsed card showing nothing at all, which is exactly
     what it did the day the card learned to collapse. */
  check('narrowing to the bid leaves the document entries out',
    !/exported to PDF/.test(History.card(b)) && /Bid created/.test(History.card(b)),
    History.card(b).slice(-200));
  History.setFilter(b.id, 'all');
  check('and All puts them back', /exported to PDF/.test(History.card(b)));
  check('and the filter chips only exist while it is open',
    (History.toggle(b.id), !/History.setFilter/.test(History.card(b))),
    History.card(b).slice(0, 160));
}

console.log('\n' + (failures === 0
  ? 'All smoke checks passed.'
  : failures + ' CHECK(S) FAILED: ' + errors.join(', ')));
process.exit(failures === 0 ? 0 : 1);
}
