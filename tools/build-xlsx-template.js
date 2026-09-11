/* build-xlsx-template.js - turns the shop's estimate workbook into js/estimate.template.js.
   Run:  node tools/build-xlsx-template.js ["Estimation_....xlsx"]

   WHY THIS EXISTS.
   Estimation_Two Story Ground Up Shell - Orange.xlsx is the workbook the
   estimators actually use: 17 fonts, 174 cell formats, live formulas and three
   hidden lookup sheets. The exported takeoff has to come out looking like it.
   SheetJS's community build cannot write a single cell style, so the only way
   to get that formatting is to keep the template's own styles.xml and theme and
   write worksheets that index into them.

   This tool prepares that: it strips the parts nothing references, keeps the
   ones that carry the formatting, and reads the template's own product sheet to
   learn which style id belongs on which kind of cell. js/estimate.xlsx.js then
   builds worksheets from data using that map.

   HARVESTING RATHER THAN HARD-CODING. Every style id, column width and row
   height below is read out of the file, never typed in. When the shop restyles
   the workbook they drop the new file in and re-run this; no JavaScript
   changes. That is the whole point of the split.

   WHAT GETS DROPPED, AND WHY IT IS SAFE.
     xl/media/*.png             664 KB of Excel rich-value artefacts. No sheet
                                has a drawing relationship, so nothing displays
                                them - they are what makes the file 725 KB.
     xl/richData/, metadata.xml, featurePropertyBag/   their only referents.
     customXml/                 SharePoint content-type junk.
     calcChain.xml              a cache Excel rebuilds; wrong for our row
                                numbers and refused if stale.
     printerSettings1.bin       a driver blob for one printer.
     docProps/                  authorship of a file we are not shipping.
   What survives is about 50 KB, which is why the result can be a plain JS file
   the browser loads with no fetch and no zip reader. */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE = 'Estimation_Two Story Ground Up Shell - Orange.xlsx';
const OUT = path.join(ROOT, 'js', 'estimate.template.js');

/* ---- reading the container ---------------------------------------------- */

/* A zip reader small enough to keep: walk the central directory rather than
   scanning for local headers, because a stored PNG can contain the local
   header signature and a scanner would find it. */
function unzip(file) {
  const buf = fs.readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(file + ' is not a zip archive');

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---- reading a worksheet ------------------------------------------------- */

/* Just enough of a sheet to harvest from: style id per cell address, plus the
   row heights and the <cols> block. Values and formulas are thrown away - this
   tool only wants the formatting. */
function readSheet(xml) {
  const cells = {};        // 'A1' -> style id (number) or null
  const heights = {};      // row number -> ht attribute, when customHeight
  for (const row of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>|<row([^>]*)\/>/g)) {
    const attrs = row[1] || row[3] || '';
    const num = (/ r="(\d+)"/.exec(attrs) || [])[1];
    const ht = (/ ht="([\d.]+)"/.exec(attrs) || [])[1];
    if (num && ht) heights[num] = ht;
    for (const c of (row[2] || '').matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>)/g)) {
      const s = (/ s="(\d+)"/.exec(c[2]) || [])[1];
      cells[c[1]] = s === undefined ? null : Number(s);
    }
  }
  return {
    cells: cells,
    heights: heights,
    cols: (/<cols>[\s\S]*?<\/cols>/.exec(xml) || [''])[0]
  };
}

const COL = 'ABCDEFGHIJKL'.split('');

/* THE ONE MAPPING RULE, and the reason it is one rule and not a table.

   The template has an Options column at B that the app has no data for, so it
   comes out: template C..L become B..K. But four rows - Material Cost, Total
   linear feet, Markup, Overhead, Total - carry their *value* in B, under the
   Options heading, and those must not vanish with the column.

   Both cases are covered by: A stays A; output B takes template C if the
   template has a C on that row, and template B if it does not; C..K take
   D..L. It works because the rows that use B for a value have nothing in C,
   and the rows that have a real C never need B. */
function shiftRow(sheet, rowNo) {
  const at = (col) => sheet.cells[col + rowNo];
  const has = (col) => (col + rowNo) in sheet.cells;
  const out = [at('A')];
  out.push(has('C') ? at('C') : at('B'));
  for (let i = 3; i < COL.length; i++) out.push(at(COL[i]));
  return withStockCols(out);
}

/* THE TWO COLUMNS THE WORKBOOK NEVER HAD.
 *
 * Len/PKT Qty and Stock U/M record what a vendor sells a part in - 21 LF to a
 * stick - which the shop's workbook never wrote down anywhere, so there is no
 * template column to take a style from. They borrow the pair they are
 * modelled on: Qty for the number, U/M for the unit, which are the same kinds
 * of cell and are already formatted as such.
 *
 * Positions 4 and 5 of the eleven-column output are Qty and U/M; the new pair
 * goes in front of them, after the Description. */
function withStockCols(row) {
  return row.slice(0, 4).concat([row[4], row[5]], row.slice(4));
}

/* A grid row is read straight: the drawing grid is Drawing Ref in A and its
   measured columns from B, and never had an Options column to lose. Padded to
   `width` by repeating the last style, because a takeoff may have more grid
   columns than the template sheet was drawn with - Steel Guardrail has 15. */
function plainRow(sheet, rowNo, width) {
  const out = [];
  for (let i = 0; i < width; i++) {
    const s = sheet.cells[COL[i] + rowNo];
    out.push(s === undefined ? out[out.length - 1] : s);
  }
  return out;
}

/* ---- the harvest --------------------------------------------------------- */

/* Which template row is the canonical example of each kind of row.

   `item` is row 8 and not row 5: rows 5-7 are covered by the J5:J7 / K5:K7 /
   L5:L7 vertical merges and carry the split styles a merge needs, which would
   put a merge fragment's border on every material line. Row 8 is a plain one.

   `cost` is row 29 (a labour line) and `costLast` row 34 (Truck), which closes
   the block with the heavier bottom border. The finish line has its own row
   because it is the only cost line that fills every column. */
const PRODUCT_ROWS = {
  header: 1, sow: 2, blank: 4, group: 13, item: 8,
  matCost: 24, totalLF: 26,
  finish: 28, cost: 29, costLast: 34, subtotal: 35,
  pct: 37, total: 39
};

const GRID_ROWS = { gridTitle: 42, gridHeader: 43, gridRow: 44, gridTotal: 45 };

/* The Project Cost Summary is not shifted - it has no Options column. Its four
   identifying rows each have their own border treatment, so each is harvested
   separately rather than one being reused for all four. */
const SUMMARY_ROWS = {
  meta0: 1, meta1: 2, meta2: 3, meta3: 4,
  band: 6, product: 7, base: 12, misc: 13, freight: 14, tax: 15,
  round: 16, grand: 17
};

function harvest(sheets) {
  const product = sheets.product;
  const summary = sheets.summary;

  const s = {};
  Object.keys(PRODUCT_ROWS).forEach(k => { s[k] = shiftRow(product, PRODUCT_ROWS[k]); });
  Object.keys(GRID_ROWS).forEach(k => { s[k] = plainRow(product, GRID_ROWS[k], 12); });

  const sum = {};
  Object.keys(SUMMARY_ROWS).forEach(k => { sum[k] = plainRow(summary, SUMMARY_ROWS[k], 8); });

  return {
    product: {
      // The template's widths minus the Options column, in output order.
      cols: shiftCols(product.cols),
      heights: {
        gridTitle: product.heights[GRID_ROWS.gridTitle] || null,
        gridHeader: product.heights[GRID_ROWS.gridHeader] || null
      },
      s: s
    },
    summary: {
      cols: summary.cols,
      heights: Object.keys(SUMMARY_ROWS).reduce((acc, k) => {
        acc[k] = summary.heights[SUMMARY_ROWS[k]] || null;
        return acc;
      }, {}),
      s: sum
    }
  };
}

/* <cols> with the Options column removed, everything past it pulled one to the
   left, and the two stock columns inserted - so column widths keep landing
   under the data they were sized for. Excel's ranges are inclusive and may span
   several columns, so this expands them to one entry per column first rather
   than trying to edit the ranges. */
function shiftCols(colsXml) {
  const byCol = {};
  let max = 0;
  for (const m of colsXml.matchAll(/<col ([^/>]*)\/>/g)) {
    const attrs = m[1];
    const min = Number((/\bmin="(\d+)"/.exec(attrs) || [])[1]);
    const to = Number((/\bmax="(\d+)"/.exec(attrs) || [])[1]);
    if (!min || !to) continue;
    const rest = attrs.replace(/\bmin="\d+"\s*/, '').replace(/\bmax="\d+"\s*/, '').trim();
    for (let i = min; i <= to; i++) {
      byCol[i] = rest;
      if (i > max) max = i;
    }
  }
  // Widths in output order, one per column, before the stock pair is added.
  const shifted = [];
  for (let i = 1; i <= max; i++) {
    if (i === 2) continue;                       // the Options column
    shifted.push(byCol[i] || null);
  }
  // Same insertion the styles get - see withStockCols.
  const widths = withStockCols(shifted);

  const out = [];
  widths.forEach((attrs, i) => {
    if (!attrs) return;
    const n = i + 1;
    out.push('<col min="' + n + '" max="' + n + '" ' + attrs + '/>');
  });
  return out.length ? '<cols>' + out.join('') + '</cols>' : '';
}

/* ---- output -------------------------------------------------------------- */

/* A worksheet kept whole, with the bits that are about the machine it was saved
   on stripped: revision ids, the selection the last editor happened to leave,
   and the tab that was in front. Those are not formatting, and shipping them
   means every exported workbook opens on somebody else's cursor. */
function cleanSheet(xml) {
  return xml
    .replace(/ xr:uid="\{[^"]*\}"/g, '')
    .replace(/<selection[^>]*\/>/g, '')
    .replace(/ tabSelected="1"/g, '');
}

function cleanWorkbook(xml) {
  return xml
    // absPath carries the shop's N:\ file-server path into every export.
    .replace(/<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>/g, '')
    .replace(/<xr:revisionPtr[^>]*\/>/g, '')
    .replace(/ xr2:uid="\{[^"]*\}"/g, '');
}

function jsString(s) {
  return JSON.stringify(s);
}

/* Returns the text of js/estimate.template.js for a given workbook, without
   writing anything. main() writes it; tests/estimate-xlsx.js calls this and
   compares, which is how a generated file that has fallen behind its source
   gets caught rather than shipped. */
function build(file) {
  const zip = unzip(file);
  const text = (name) => {
    if (!zip[name]) throw new Error('The template has no ' + name);
    return zip[name].toString('utf8');
  };

  // Sheet name -> part, so the tool follows the workbook rather than assuming
  // sheet3.xml is Steel Guardrail.
  const wb = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  const target = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*)"/g)) target[m[1]] = m[2];
  const byName = {};
  for (const m of wb.matchAll(/<sheet name="([^"]*)"[^>]*r:id="(rId\d+)"/g)) {
    byName[m[1]] = 'xl/' + target[m[2]].replace(/^\.\//, '');
  }

  const need = (name) => {
    if (!byName[name]) {
      throw new Error('The template has no sheet called "' + name + '". Sheets: ' +
        Object.keys(byName).join(', '));
    }
    return text(byName[name]);
  };

  const styles = harvest({
    product: readSheet(need('Steel Guardrail')),
    summary: readSheet(need('Project Cost Summary'))
  });

  // The three lookup sheets travel unchanged: they are reference data the
  // estimators work against, and they index into the shared strings we keep.
  const LOOKUPS = [
    { name: 'References', hidden: true },
    { name: 'Weight Calculator', hidden: true },
    { name: 'Factors', hidden: false }
  ];

  const payload = {
    source: path.basename(file),
    generated: new Date().toISOString().slice(0, 10),
    // Verbatim, and the tests assert they stay that way: these three parts are
    // the formatting.
    parts: {
      'xl/styles.xml': text('xl/styles.xml'),
      'xl/theme/theme1.xml': text('xl/theme/theme1.xml'),
      'xl/sharedStrings.xml': text('xl/sharedStrings.xml')
    },
    workbookAttrs: (/<workbook ([^>]*)>/.exec(cleanWorkbook(wb)) || [])[1] || '',
    lookups: LOOKUPS.map(l => ({ name: l.name, hidden: l.hidden, xml: cleanSheet(need(l.name)) })),
    product: styles.product,
    summary: styles.summary
  };

  const js = '/* GENERATED by tools/build-xlsx-template.js - do not edit by hand.\n' +
    '   Source: ' + payload.source + '\n' +
    '   Built:  ' + payload.generated + '\n\n' +
    '   The shop\'s estimate workbook, stripped to the parts that carry its\n' +
    '   formatting, plus a map of which style id belongs on which kind of cell.\n' +
    '   js/estimate.xlsx.js writes worksheets against this. To refresh it, drop\n' +
    '   the new .xlsx in the project root and run the tool again. */\n' +
    'window.ESTIMATE_TEMPLATE = ' + JSON.stringify(payload, null, 0) + ';\n';

  return { js: js, payload: payload };
}

function main() {
  const source = process.argv[2] || DEFAULT_SOURCE;
  const file = path.isAbsolute(source) ? source : path.join(ROOT, source);
  if (!fs.existsSync(file)) {
    console.error('Cannot find ' + file);
    console.error('Usage: node tools/build-xlsx-template.js ["Estimation_....xlsx"]');
    process.exit(1);
  }

  const out = build(file);
  const js = out.js, payload = out.payload;
  fs.writeFileSync(OUT, js);

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('Read   ' + payload.source + '  (' + kb(fs.statSync(file).size) + ')');
  console.log('Kept   styles.xml ' + kb(payload.parts['xl/styles.xml'].length) +
    ', theme1.xml ' + kb(payload.parts['xl/theme/theme1.xml'].length) +
    ', sharedStrings.xml ' + kb(payload.parts['xl/sharedStrings.xml'].length));
  console.log('Kept   ' + payload.lookups.map(l => l.name).join(', '));
  console.log('Styles ' + Object.keys(payload.product.s).length + ' product roles, ' +
    Object.keys(payload.summary.s).length + ' summary roles');
  console.log('Wrote  js/estimate.template.js  (' + kb(js.length) + ')');
}

module.exports = { build: build, DEFAULT_SOURCE: DEFAULT_SOURCE, OUT: OUT };

if (require.main === module) main();
