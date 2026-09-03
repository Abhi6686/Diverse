/* Numeric parity check against Estimation_Lancaster Township.xlsx.
   Run with:  node tests/verify-lancaster.js
   Loads the real app modules in a minimal fake-DOM sandbox so the maths under
   test is exactly the maths the browser runs. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Minimal window/document shim: the model layer only needs Intl and localStorage.
const sandbox = {
  console, Intl, Date, Math, JSON, isNaN, Number, String, Array, Object, parseFloat,
  setTimeout, clearTimeout, Promise,
  // No indexedDB here on purpose: this exercises the localStorage fallback path
  // as well as the cost maths.
  navigator: undefined,
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = v; },
    removeItem(k) { delete this._d[k]; }
  },
  document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/seed.js', 'js/catalog.seed.js', 'js/proposal.defaults.js',
 'js/util.js', 'js/store.js', 'js/rates.js', 'js/catalog.js', 'js/takeoff.model.js']
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }));

const { Store, Rates, TakeoffModel: M } = sandbox;

let failures = 0;
function check(label, actual, expected, tol = 0.01) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} got ${fmt(actual).padStart(14)}   want ${fmt(expected).padStart(14)}`);
}

// Boot is async now. Everything below runs once the store is in memory.
Store.open().then(() => {
Rates.ensure(Store.db);
console.log('storage backend: ' + Store.backend + ' (localStorage fallback expected here)');

/* ---- Steel Guardrail, transcribed from the sheet ---------------------- */
// [qty, unitCost] for every material row (rows 4-32). Alro rows are priced by
// weight in the workbook, so their unit cost is total/qty.
const guardrailRows = [
  [23, 3742 / 23], [25, 3948.52 / 25], [24, 4716.63 / 24], [23, 8.09], [23, 6.56],
  [92, 2.87], [15, 516.09 / 15], [23, 8.48], [12, 6.56], [3, 7.46],
  [4, 1844.96 / 4], [11, 31.05], [3, 23.27], [32, 5.57], [2, 1613.47 / 2],
  [5, 4.45], [5, 0.23], [54, 3.49], [13, 3866.15 / 13], [6, 3589.15 / 6],
  [5, 29.44], [1, 10.28], [2, 44.76]
];

function buildProduct(type, rows, totalLF, opts = {}) {
  const p = M.newProduct(type);
  p.totalLF = totalLF;
  M.applyDerived(p);
  rows.forEach(([qty, unitCost]) => {
    p.groups[0].items.push(M.newItem({ qty, unitCost }));
  });
  if (opts.supervisorHrs != null) M.setField(p, 'labour.supervisor.hrs', opts.supervisorHrs);
  if (opts.forkliftDays != null) M.setField(p, 'equipment.forklift.days', opts.forkliftDays);
  if (opts.truckDays != null) M.setField(p, 'equipment.truck.days', opts.truckDays);
  if (opts.finishQty != null) M.setField(p, 'finish.qty', opts.finishQty);
  if (opts.overrides) Object.entries(opts.overrides).forEach(([k, v]) => M.setField(p, k, v));
  if (opts.truckRate != null) p.equipment.truck.rate = opts.truckRate;
  return p;
}

console.log('\n--- Steel Guardrail (sheet rows 34-49) ---');
const guardrail = buildProduct('Steel Guardrail', guardrailRows, 442.43, {
  supervisorHrs: 64, forkliftDays: 1, truckDays: 8
});
let c = M.computeProduct(guardrail);
check('Material Cost', c.materialCost, 25782.56);
check('Engineering hrs (LF*0.3+16)', guardrail.labour.engineering.hrs, 148.729);
check('Fabrication hrs (LF*0.6+24)', guardrail.labour.fabrication.hrs, 289.458);
check('Installation hrs (LF*0.5)', guardrail.labour.installation.hrs, 221.215);
check('Subtotal', c.subtotal, 127315.195);
check('Markup + Margin 25%', c.markup, 31828.79875);
check('Overhead & Profit 20%', c.overhead, 25463.039);
check('Total Cost', c.total, 184607.03275);

/* ---- Wall Mount Handrail --------------------------------------------- */
console.log('\n--- Wall Mount Handrail (fabrication at $125/hr) ---');
const handrail = buildProduct('Wall Mount Handrail',
  [[3, 1698.17 / 3], [17, 16.67], [5, 23.27], [6, 5.57]], 45.61, {
    supervisorHrs: 4.5, forkliftDays: 0, truckDays: 1,
    // The sheet's hours are hand-entered here, not formula-derived.
    overrides: {
      'labour.engineering.hrs': 13.122,
      'labour.fabrication.hrs': 13.683,
      'labour.installation.hrs': 9.122
    }
  });
handrail.equipment.forklift.rate = 0;
c = M.computeProduct(handrail);
check('Fabrication rate override', handrail.labour.fabrication.rate, 125, 0);
check('Material Cost', c.materialCost, 2131.33);
check('Subtotal', c.subtotal, 8474.955);
check('Total Cost', c.total, 12288.68475);

/* ---- Bollard ---------------------------------------------------------- */
console.log('\n--- Bollard (two component groups) ---');
const bollard = M.newProduct('Bollard');
bollard.totalLF = 0;
[[24, 25884.96 / 24], [66, 76.97]].forEach(([q, u]) =>
  bollard.groups[0].items.push(M.newItem({ qty: q, unitCost: u })));
[[3, 4690.79 / 3], [7, 942.54 / 7], [32, 7.66], [8, 76.97], [74, 74.91]]
  .forEach(([q, u]) => bollard.groups[1].items.push(M.newItem({ qty: q, unitCost: u })));
M.setField(bollard, 'finish.qty', 0);
M.setField(bollard, 'labour.engineering.hrs', 12.875);
M.setField(bollard, 'labour.fabrication.hrs', 142);
M.setField(bollard, 'labour.installation.hrs', 106.5);
M.setField(bollard, 'labour.supervisor.hrs', 32);
M.setField(bollard, 'equipment.forklift.days', 0);
M.setField(bollard, 'equipment.truck.days', 4);
c = M.computeProduct(bollard);
check('Material Cost (both groups)', c.materialCost, 43002.53);
check('Subtotal', c.subtotal, 79642.53);
check('Total Cost', c.total, 115481.6685);

/* ---- Galvanized Platform ---------------------------------------------- */
console.log('\n--- Galvanized Platform ---');
const platform = M.newProduct('Galvanized Platform');
platform.totalLF = 121;
M.applyDerived(platform);
[[9, 9757.9 / 9], [41, 11.71], [155, 14.71], [5, 2422.39 / 5], [7, 3607.99 / 7],
 [6, 1714.61 / 6], [2, 2556.05 / 2], [8, 431.59 / 8], [32, 10.95], [41, 21.38]]
  .forEach(([q, u]) => platform.groups[0].items.push(M.newItem({ qty: q, unitCost: u })));
[[2, 3906.45 / 2], [55, 14.71], [1, 529.49], [6, 3266.19 / 6], [1, 1199.34],
 [11, 8289.75 / 11], [26, 1068.31 / 26], [104, 10.95], [1, 286.08], [5, 4.31], [2, 3011.66]]
  .forEach(([q, u]) => platform.groups[1].items.push(M.newItem({ qty: q, unitCost: u })));
// The sheet bills galvanizing on 568.13 LF of stock, not the 121 LF of platform.
M.setField(platform, 'finish.qty', 568.13);
M.setField(platform, 'labour.supervisor.hrs', 32);
M.setField(platform, 'equipment.forklift.days', 1);
M.setField(platform, 'equipment.truck.days', 4);
// The workbook appends +(1000*2)+(200*2) inside three formulas (L44/L45/L47).
// Modelled here as explicit lines so the money is visible rather than hidden.
platform.extras = [
  { id: 'x1', label: 'Crane / lift allowance (installation)', amount: 2400 },
  { id: 'x2', label: 'Crane / lift allowance (supervision)', amount: 2400 },
  { id: 'x3', label: 'Crane / lift allowance (transport)', amount: 2400 }
];
c = M.computeProduct(platform);
// Platform-specific hour factors must fall out of Rates, not be typed in.
check('Engineering hrs (LF*0.6+16)', platform.labour.engineering.hrs, 88.6);
check('Fabrication hrs (LF*1.8)', platform.labour.fabrication.hrs, 217.8);
check('Installation hrs (LF*1)', platform.labour.installation.hrs, 121);
check('Material Cost', c.materialCost, 51016.00);
check('Subtotal', c.subtotal, 131380.90);
check('Total Cost', c.total, 190502.305);

/* ---- Stair ------------------------------------------------------------ */
console.log('\n--- Stair ---');
const stair = buildProduct('Stair',
  [[6, 5115.86 / 6], [1, 258.7], [9, 24.61], [39, 129.19], [32, 5.9], [4, 12.22], [4, 5.75]],
  108.6, {
    supervisorHrs: 16, forkliftDays: 0, truckDays: 2,
    overrides: {
      'labour.engineering.hrs': 29.72,
      'labour.fabrication.hrs': 32.58,
      'labour.installation.hrs': 27.15
    }
  });
c = M.computeProduct(stair);
check('Material Cost', c.materialCost, 10895.14);
check('Subtotal', c.subtotal, 26928.49);
check('Total Cost', c.total, 39046.3105);

/* ---- Project roll-up -------------------------------------------------- */
console.log('\n--- Project Cost Summary ---');
const takeoff = M.newTakeoff(null);
takeoff.products = [guardrail, handrail, bollard, platform, stair];
// The workbook carries a negotiated flat roundoff of 343 rather than rounding
// up to the next ten, so this reproduction pins roundMode to manual.
takeoff.rollup = { miscPct: 5, freight: 12000, taxPct: 7, roundoff: 343, roundMode: 'manual' };
const roll = M.computeTakeoff(takeoff);
check('Project Base Cost', roll.base, 541926.0015);
check('Total LF', roll.totalLF, 442.43 + 45.61 + 0 + 121 + 108.6);
check('Miscellaneous 5%', roll.misc, 27096.300075);
check('Tax 7%', roll.tax, 37934.820105);
check('Total Bid Cost', roll.total, 619300.12168);

/* ---- Round-to-10 quoting --------------------------------------------- */
console.log('\n--- Round the bid total to the next 10 ---');
const U = sandbox.U;
check('101,980.65 -> 101,980', U.roundTo10(101980.65), 101980, 0);
check('101,981.25 -> 101,990', U.roundTo10(101981.25), 101990, 0);
check('101,988.75 -> 101,990', U.roundTo10(101988.75), 101990, 0);
check('exact multiple stays put', U.roundTo10(101990), 101990, 0);
check('x.00 just above a multiple', U.roundTo10(101981.00), 101990, 0);
check('x.99 on a multiple stays', U.roundTo10(101980.99), 101980, 0);
check('zero', U.roundTo10(0), 0, 0);
check('negative rounds toward zero', U.roundTo10(-15.5), -10, 0);

takeoff.rollup.roundMode = 'auto10';
const auto = M.computeTakeoff(takeoff);
check('auto total is the rounded pre-round figure', auto.total, U.roundTo10(auto.preRound), 0);
check('auto total is a whole multiple of 10', auto.total % 10, 0, 0);
check('roundoff equals total minus pre-round', auto.roundoff, auto.total - auto.preRound);
check('pre-round excludes the roundoff', auto.preRound,
  auto.base + auto.misc + auto.freight + auto.tax);
takeoff.rollup.roundMode = 'manual';

/* ---- Formula-quantity evaluator --------------------------------------- */
console.log('\n--- Qty formula evaluator (mirrors Excel F4 =ROUNDUP(B58/21,0)+1) ---');
const g = M.newGroup('t', ['Top Rail_1-1/2" Pipe (LF)']);
g.grid.rows = [{ ref: '2/A-101', values: { [g.grid.columns[0].key]: 442.43 } }];
check('ROUNDUP(TK(col)/21,0)+1',
  M.evalQtyExpr('ROUNDUP(TK("Top Rail_1-1/2\\" Pipe (LF)")/21,0)+1', g), 23, 0);
check('nested arithmetic', M.evalQtyExpr('(2+3)*4-10/5', g), 18, 0);
let threw = false;
try { M.evalQtyExpr('constructor.constructor("return 1")()', g); } catch (e) { threw = true; }
check('rejects non-whitelisted identifiers', threw ? 1 : 0, 1, 0);

console.log('\n' + (failures === 0
  ? 'All checks passed.'
  : failures + ' CHECK(S) FAILED.'));
process.exit(failures === 0 ? 0 : 1);

}).catch(err => { console.error(err); process.exit(1); });
