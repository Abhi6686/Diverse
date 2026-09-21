/* estimate-xlsx.js - the template-driven estimate export, taken apart again.
   Run with:  node tests/estimate-xlsx.js

   An .xlsx is a zip of XML, so this test unzips what the exporter produced and
   reads it. That is the only honest way to check the thing: "it did not throw"
   says nothing about whether Excel will open the file, and a formula that
   points one row off is invisible until somebody opens the workbook.

   Three questions are asked of every export:
     - is it a valid container, with every part the workbook claims;
     - did the template's formatting survive byte-for-byte;
     - does each formula point where the arithmetic says it should, and does the
       cached value beside it agree with the app's own model to the cent.

   Same lightweight vm sandbox as tests/verify-lancaster.js: the exporter needs
   the model and the store, not a DOM. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const sandbox = {
  console, Intl, Date, Math, JSON, isNaN, Number, String, Array, Object, parseFloat,
  isFinite, RegExp, Error, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer,
  setTimeout, clearTimeout, Promise,
  navigator: undefined,
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = v; },
    removeItem(k) { delete this._d[k]; }
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} })
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/seed.js', 'js/catalog.seed.js', 'js/proposal.defaults.js',
 'js/util.js', 'js/store.js', 'js/rates.js', 'js/catalog.js', 'js/takeoff.model.js',
 'js/xlsx.zip.js', 'js/estimate.template.js', 'js/estimate.xlsx.js']
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }));

const { Store, Rates, TakeoffModel: M, Estimate, ESTIMATE_TEMPLATE: T } = sandbox;

let failures = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) { failures++; errors.push(label); }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  -> ' + detail : ''}`);
}
function near(label, actual, expected, tol = 0.01) {
  check(label, Math.abs(Number(actual) - Number(expected)) <= tol,
    `got ${actual}, want ${expected}`);
}

/* ---- reading back what we wrote ----------------------------------------- */

/* Deliberately not the writer's own code running backwards: this walks the
   central directory the way any unzip tool does, so a header the writer got
   wrong shows up here rather than in Excel. */
function unzip(bytes) {
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = b.readUInt16LE(end + 10);
  const dirSize = b.readUInt32LE(end + 12);
  const dirStart = b.readUInt32LE(end + 16);
  // An unzip tool that finds these two disagreeing declares the file truncated
  // and repairs it before reading, so it has to be asserted rather than
  // assumed - a reader that walks the entries anyway would never notice.
  if (dirStart + dirSize !== end) {
    throw new Error('central directory is ' + (dirStart + dirSize - end) +
      ' bytes out: declared ' + dirSize + ', actual ' + (end - dirStart));
  }
  let p = dirStart;
  const out = {};
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header at entry ' + i);
    const nameLen = b.readUInt16LE(p + 28);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const crc = b.readUInt32LE(p + 16);
    const lho = b.readUInt32LE(p + 42);
    if (b.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(start, start + size);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (sandbox.Zip.crc32(data) !== crc) throw new Error('CRC mismatch on ' + name);
    out[name] = data.toString('utf8');
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return out;
}

/* A sheet as { 'A1': {s, v, f, t}, ... } - enough to ask where a formula points
   and what value was cached beside it. */
function cells(xml) {
  const out = {};
  for (const c of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const inner = c[3] || '';
    out[c[1]] = {
      s: (/ s="(\d+)"/.exec(c[2]) || [])[1],
      t: (/ t="(\w+)"/.exec(c[2]) || [])[1],
      f: (/<f>([\s\S]*?)<\/f>/.exec(inner) || [])[1],
      v: (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1],
      text: (/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/.exec(inner) || [])[1]
    };
  }
  return out;
}

function label(cellMap, text) {
  const key = Object.keys(cellMap).find(k => /^A\d+$/.test(k) && cellMap[k].text === text);
  return key ? Number(key.slice(1)) : null;
}

function sheetNames(workbookXml) {
  return [...workbookXml.matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1]);
}

/* ---- a takeoff to export ------------------------------------------------ */

function buildTakeoff() {
  const t = M.newTakeoff(null);
  t.project.name = 'Filcore - Two Story Ground Up Shell';
  t.project.location = '3900 Orange Place Beachwood, OH 44122';
  t.project.proposalNo = 'DS-PH-0826-27';
  t.project.bidDueDate = '2026-09-08';

  // One product measured on a drawing grid, so the quantity formulas have
  // something to point at.
  const rail = M.newProduct('Steel Guardrail');
  rail.totalLF = 76.96;
  M.applyDerived(rail);
  const g = rail.groups[0];
  // A product arrives with its group and an empty grid, so the column measured
  // below is created here - name and unit, the way the Drawing Takeoff tab
  // creates one. The inch marks are load-bearing: the TK("...") escaping
  // further down is tested against this exact label.
  const topRail = M.newColumn('Top Rail_1-1/2" Pipe', 'LF');
  g.grid.columns.push(topRail);
  g.grid.rows.push({ ref: 'A1.5', values: { [topRail.key]: 40 } });
  g.grid.rows.push({ ref: 'A2.1', values: { [topRail.key]: 35.79 } });
  // The stock column labels carry inch marks - Top Rail_1-1/2" Pipe (LF) - so
  // the quoted name inside TK() has to escape them, exactly as the takeoff's
  // own expression parser expects.
  g.items.push(M.newItem({
    feature: 'Top Rail', description: 'Carbon Steel 1-1/4 SCH 40 PIPE', um: 'EA',
    unitCost: 96.73, qtyMode: 'formula',
    qtyExpr: 'ROUNDUP(TK("' + topRail.label.replace(/"/g, '\\"') + '")/21,0)+1'
  }));
  g.items.push(M.newItem({
    feature: 'Base plate', description: 'Steel Flat Base Flange', um: 'EA',
    qty: 12, unitCost: 5.33
  }));
  // Measured off the drawings and bought in 21-foot sticks - the division the
  // sheet has to show its working for.
  g.items.push(M.newItem({
    feature: topRail.label, description: 'Carbon Steel 1-1/2 SCH 40 PIPE',
    um: 'EA', unitCost: 96.73, qtyMode: 'takeoff',
    scopeKey: M.scopeKey(topRail.label), packQty: 21, packUm: 'LF'
  }));
  // The same again, with the estimator having decided on six rather than the
  // four the division comes to.
  g.items.push(M.newItem({
    feature: topRail.label, description: 'Carbon Steel 1-1/2 SCH 40 PIPE (extra)',
    um: 'EA', unitCost: 96.73, qtyMode: 'takeoff',
    scopeKey: M.scopeKey(topRail.label), packQty: 21, packUm: 'LF',
    orderQtyOverride: 6
  }));
  M.setField(rail, 'labour.supervisor.hrs', 24);
  M.setField(rail, 'equipment.forklift.days', 1);
  M.setField(rail, 'equipment.truck.days', 3);
  t.products.push(rail);

  // A second product with two groups and no grid rows at all, which is the
  // shape that used to export a Sub Total row of zeros.
  const bollard = M.newProduct('Bollard');
  bollard.totalLF = 8;
  M.applyDerived(bollard);
  bollard.groups[0].items.push(M.newItem({
    feature: 'Pipe', description: '8 SCH 40 PIPE', qty: 4, um: 'EA', unitCost: 210
  }));
  bollard.groups[1].items.push(M.newItem({
    feature: 'Base plate', description: 'Bollard base plate', qty: 4, um: 'EA', unitCost: 60
  }));
  t.products.push(bollard);

  return t;
}

/* ---- the run ------------------------------------------------------------ */

Store.open().then(() => {
  Rates.ensure(Store.db);
  const t = buildTakeoff();
  const roll = M.computeTakeoff(t);
  const bytes = Estimate.buildWorkbook(t);
  const parts = unzip(bytes);

  console.log('--- the container ---');
  check('the writer produced bytes', bytes.length > 0, String(bytes.length));
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
   'xl/styles.xml', 'xl/theme/theme1.xml', 'xl/sharedStrings.xml']
    .forEach(p => check('part present: ' + p, !!parts[p]));

  const names = sheetNames(parts['xl/workbook.xml']);
  check('sheets in the order the estimators expect',
    JSON.stringify(names) === JSON.stringify(['References', 'Project Cost Summary',
      'Steel Guardrail', 'Bollard', 'Weight Calculator', 'Factors']),
    names.join(', '));
  check('the two lookup sheets stay hidden',
    (parts['xl/workbook.xml'].match(/state="hidden"/g) || []).length === 2);
  check('and the workbook recalculates on open',
    /fullCalcOnLoad="1"/.test(parts['xl/workbook.xml']));

  // Every sheet the workbook declares must have a part and a content type,
  // which is the pair Excel checks before it will open anything.
  const declared = names.length;
  const sheetParts = Object.keys(parts).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  check('one part per declared sheet', sheetParts.length === declared,
    `${sheetParts.length} parts, ${declared} sheets`);
  check('and a content type for each',
    sheetParts.every(p => parts['[Content_Types].xml'].includes('/' + p + '"')));
  const rels = parts['xl/_rels/workbook.xml.rels'];
  check('every relationship the workbook names resolves',
    [...parts['xl/workbook.xml'].matchAll(/r:id="(rId\d+)"/g)]
      .every(m => rels.includes('Id="' + m[1] + '"')));

  console.log('\n--- the template survived ---');
  Object.keys(T.parts).forEach(p => {
    check(p + ' is byte-identical to the template', parts[p] === T.parts[p]);
  });
  const lookup = cells(parts['xl/worksheets/sheet1.xml']);
  check('References still indexes into the shared strings',
    Object.values(lookup).some(c => c.t === 's'));
  // Style ids are only meaningful against the styles.xml they came from.
  const styleCount = (parts['xl/styles.xml'].match(/<xf /g) || []).length;
  const guardrail = cells(parts['xl/worksheets/sheet3.xml']);
  check('every style id written exists in styles.xml',
    Object.values(guardrail).every(c => c.s === undefined || Number(c.s) < styleCount),
    String(styleCount));

  console.log('\n--- the product sheet ---');
  const header = 'ABCDEFGHIJKLM'.split('').map(c => guardrail[c + '1'] && guardrail[c + '1'].text);
  /* Thirteen columns, and the order is load-bearing: every formula below
     addresses Qty as G, Unit Cost as L and Total Cost as M. Len/PKT Qty and the
     unit it is counted in sit after the Description, beside the part they
     describe rather than among the three quantity columns. */
  check('the header is the thirteen columns, with no Options',
    JSON.stringify(header) === JSON.stringify(['Features', 'Vendor', 'Vendor Part No',
      'Desription', 'Length/PKT Qty', 'Stock U/M', 'Qty', 'U/M', 'Material', 'Grade',
      'Weight (lb)', 'Unit Cost', 'Total Cost']),
    header.join('|'));
  check('nothing on the sheet says Options',
    !parts['xl/worksheets/sheet3.xml'].includes('>Options<'));

  const matRow = label(guardrail, 'Material Cost');
  const lfRow = label(guardrail, 'Total linear feet');
  const subRow = label(guardrail, 'Material+Engg+Fab+Install Cost');
  const totRow = label(guardrail, 'Total Cost');
  check('the summary rows are all there',
    matRow && lfRow && subRow && totRow, `${matRow}/${lfRow}/${subRow}/${totRow}`);

  const calc = M.computeProduct(t.products[0]);
  check('Material Cost sums the Total Cost column',
    /^SUM\(M\d+:M\d+\)$/.test(guardrail['B' + matRow].f), guardrail['B' + matRow].f);
  near('and caches the model\'s own figure', guardrail['B' + matRow].v, calc.materialCost);
  check('the subtotal adds the material cost to every cost line',
    guardrail['M' + subRow].f.startsWith('B' + matRow + '+M'), guardrail['M' + subRow].f);
  near('subtotal value', guardrail['M' + subRow].v, calc.subtotal);
  check('Total Cost is subtotal plus markup plus overhead',
    guardrail['B' + totRow].f === 'M' + subRow + '+B' + (totRow - 2) + '+B' + (totRow - 1),
    guardrail['B' + totRow].f);
  near('total value', guardrail['B' + totRow].v, calc.total);

  // A line total that is a number rather than a formula is a cell that stops
  // responding the moment somebody edits a unit cost.
  const formulaItem = matRow - 4;    // Top Rail, quantity from an fx expression
  const typedItem = matRow - 3;      // Base plate, quantity typed in
  const scopeItem = matRow - 2;      // Top Rail again, measured off the scope
  const overItem = matRow - 1;       // and again, with the order typed over
  check('a material line total is a live formula',
    guardrail['M' + formulaItem].f === 'G' + formulaItem + '*L' + formulaItem,
    guardrail['M' + formulaItem].f);

  console.log('\n--- formulas the estimator wrote ---');
  const gridTotal = label(guardrail, 'Sub Total');
  check('the drawing grid has a Sub Total row', !!gridTotal, String(gridTotal));
  check('which sums the measured rows',
    /^SUM\(B\d+:B\d+\)$/.test(guardrail['B' + gridTotal].f), guardrail['B' + gridTotal].f);
  near('to what the model makes it', guardrail['B' + gridTotal].v, 75.79);

  check('a formula quantity points at that Sub Total row',
    guardrail['G' + formulaItem].f === 'ROUNDUP(B' + gridTotal + '/21,0)+1',
    guardrail['G' + formulaItem].f);
  near('and caches what the takeoff evaluates it to', guardrail['G' + formulaItem].v,
    M.itemQty(t.products[0].groups[0].items[0], t.products[0].groups[0], t.products[0]));
  check('a typed quantity stays a number',
    guardrail['G' + typedItem].f === undefined && guardrail['G' + typedItem].v === '12',
    JSON.stringify(guardrail['G' + typedItem]));

  /* The whole point of the two new columns: the sheet shows the division rather
     than the answer. The divisor is the row's own Len/PKT cell, so correcting a
     stock length in Excel re-orders without anyone coming back to the app. */
  const scopeRow = t.products[0].groups[0].items[2];
  check('a measured quantity is the drawing total divided by the stock size',
    guardrail['G' + scopeItem].f === 'ROUNDUP(B' + gridTotal + '/E' + scopeItem + ',0)',
    guardrail['G' + scopeItem].f);
  check('and the stock size is on the sheet to divide by',
    guardrail['E' + scopeItem].v === '21' && guardrail['F' + scopeItem].text === 'LF',
    JSON.stringify([guardrail['E' + scopeItem], guardrail['F' + scopeItem]]));
  near('the cached order quantity is what the app worked out',
    guardrail['G' + scopeItem].v,
    M.orderQty(scopeRow, t.products[0].groups[0], t.products[0]), 0);
  check('which is whole, because you cannot buy part of a stick',
    Number(guardrail['G' + scopeItem].v) % 1 === 0, guardrail['G' + scopeItem].v);

  /* A quantity somebody typed over the calculation must NOT come out as a
     formula. Excel would recalculate it straight back to the figure they had
     already decided against, and the sheet would then disagree with the app
     about what is being ordered - the exact failure this file's header warns
     against under "inventing a formula for a typed number". */
  check('an order quantity typed over the calculation exports as a number',
    guardrail['G' + overItem].f === undefined && guardrail['G' + overItem].v === '6',
    JSON.stringify(guardrail['G' + overItem]));
  check('and its stock size is still written, so the sheet shows what was overruled',
    guardrail['E' + overItem].v === '21', JSON.stringify(guardrail['E' + overItem]));
  check('while the row beside it keeps its live formula',
    /^ROUNDUP\(/.test(guardrail['G' + scopeItem].f || ''), guardrail['G' + scopeItem].f);

  // The takeoff reads CEILING's second argument as decimal places; Excel reads
  // it as a significance, so CEILING(x, 0) would come out as a flat zero.
  check('CEILING is rewritten to ROUNDUP',
    Estimate.toExcel('CEILING(3.2,0)', () => 'B9') === 'ROUNDUP(3.2,0)',
    Estimate.toExcel('CEILING(3.2,0)', () => 'B9'));
  check('FLOOR is rewritten to ROUNDDOWN',
    Estimate.toExcel('FLOOR(3.2,0)', () => 'B9') === 'ROUNDDOWN(3.2,0)');
  check('an unknown function is refused rather than guessed at',
    Estimate.toExcel('VLOOKUP(1,A:B,2)', () => 'B9') === null);
  check('and so is a column no grid has',
    Estimate.toExcel('TK("nope")', () => null) === null);

  console.log('\n--- derived hours ---');
  const rates = Rates.forType('Steel Guardrail');
  const engRow = label(guardrail, 'Engineering cost');
  check('engineering hours are the run length times the shop factor',
    guardrail['G' + engRow].f === 'B' + lfRow + '*' + rates.engFactor + '+' + rates.engBase,
    guardrail['G' + engRow].f);
  const instRow = label(guardrail, 'Installation cost');
  check('and a factor with no constant does not print "+0"',
    guardrail['G' + instRow].f === 'B' + lfRow + '*' + rates.instFactor,
    guardrail['G' + instRow].f);
  const supRow = label(guardrail, 'Supervisor');
  check('but a supervisor\'s hours, which nobody derives, are a number',
    guardrail['G' + supRow].f === undefined && guardrail['G' + supRow].v === '24',
    JSON.stringify(guardrail['G' + supRow]));

  console.log('\n--- a group with nothing measured ---');
  const bollard = cells(parts['xl/worksheets/sheet4.xml']);
  check('no grid block, rather than a Sub Total of zeros',
    label(bollard, 'Sub Total') === null);
  check('and both group headings are still on the sheet',
    label(bollard, 'Embedded Bollard') && label(bollard, 'Surface Mounted Bollard'));

  console.log('\n--- the cost summary ---');
  const summary = cells(parts['xl/worksheets/sheet2.xml']);
  check('it names the project', summary.B1.text === t.project.name, summary.B1.text);
  check('and carries the proposal number', summary.B3.text === 'DS-PH-0826-27');
  const railRow = label(summary, 'Steel Guardrail');
  check('each product points at its own sheet\'s Total Cost',
    summary['C' + railRow].f === "'Steel Guardrail'!B" + totRow,
    summary['C' + railRow].f);
  near('with the right figure cached', summary['C' + railRow].v, calc.total);

  const baseRow = label(summary, 'Project Base Cost ');
  check('the base cost sums the product lines',
    summary['C' + baseRow].f === 'SUM(C' + railRow + ':C' + (railRow + 1) + ')',
    summary['C' + baseRow].f);
  near('base cost', summary['C' + baseRow].v, roll.base);
  const taxRow = label(summary, 'Tax (' + Store.db.rates.rollup.taxPct + '%)');
  check('tax is a percentage of the base, not a frozen number',
    summary['C' + taxRow].f === 'C' + baseRow + '*' + Store.db.rates.rollup.taxPct + '%',
    summary['C' + taxRow].f);
  const grandRow = label(summary, 'Total Bid Cost');
  check('and the bid total sums straight through the roll-up',
    summary['C' + grandRow].f === 'SUM(C' + baseRow + ':C' + (grandRow - 1) + ')',
    summary['C' + grandRow].f);
  near('Total Bid Cost matches the takeoff', summary['C' + grandRow].v, roll.total);

  console.log('\n--- one product on its own ---');
  const single = unzip(Estimate.buildWorkbook(t, t.products[1].id));
  const singleNames = sheetNames(single['xl/workbook.xml']);
  check('exports just that product, with the lookups behind it',
    JSON.stringify(singleNames) === JSON.stringify(['References', 'Project Cost Summary',
      'Bollard', 'Weight Calculator', 'Factors']),
    singleNames.join(', '));

  console.log('\n--- names Excel will accept ---');
  const clash = M.newTakeoff(null);
  const long = 'Galvanized Platform at the Wash Bay and Walkway';
  [long, long].forEach(name => {
    const p = M.newProduct('Galvanized Platform');
    p.type = name;
    p.totalLF = 10;
    M.applyDerived(p);
    clash.products.push(p);
  });
  const clashNames = sheetNames(unzip(Estimate.buildWorkbook(clash))['xl/workbook.xml']);
  check('no two sheets share a name',
    new Set(clashNames.map(n => n.toLowerCase())).size === clashNames.length,
    clashNames.join(', '));
  check('and none is longer than 31 characters',
    clashNames.every(n => n.length <= 31), clashNames.join(', '));

  /* js/estimate.template.js is generated, and a generated file that has fallen
     behind its source is the failure nobody notices: the export keeps working,
     it just keeps using last month's formatting. Rebuilt here in memory and
     compared - never written, so running the tests cannot change the repo. */
  console.log('\n--- the generated template is current ---');
  {
    const tool = require(path.join(ROOT, 'tools', 'build-xlsx-template.js'));
    const source = path.join(ROOT, tool.DEFAULT_SOURCE);
    if (!fs.existsSync(source)) {
      console.log('SKIP  ' + tool.DEFAULT_SOURCE + ' is not in the working tree');
    } else {
      const rebuilt = tool.build(source).js;
      const committed = fs.readFileSync(tool.OUT, 'utf8');
      // The build date is in the header comment and moves on its own.
      const strip = s => s.replace(/^\/\*[\s\S]*?\*\/\n/, '');
      check('js/estimate.template.js matches the workbook it came from',
        strip(rebuilt) === strip(committed),
        'run npm run build:xlsx-template');
    }
  }

  console.log('\n' + (failures === 0
    ? 'All estimate export checks passed.'
    : failures + ' CHECK(S) FAILED: ' + errors.join(', ')));
  process.exit(failures === 0 ? 0 : 1);
}).catch(e => {
  console.log('FAIL  harness: ' + e.message);
  console.log(e.stack);
  process.exit(1);
});
