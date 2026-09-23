/* report.xlsx.js - the bid register, as a workbook somebody can send.
 *
 * WHY THIS IS NOT SheetJS. The community build cannot write a cell style at
 * all - not a fill, not a number format, not a frozen pane. That is the same
 * wall js/estimate.xlsx.js hit, and the same answer: write the parts directly
 * and pack them with js/xlsx.zip.js. The three primitives both writers need -
 * escaping, column letters, float-dust rounding - live in that file.
 *
 * WHY NOT THE ESTIMATE TEMPLATE'S STYLES. js/estimate.template.js is GENERATED
 * from the shop's estimate workbook, and its style ids mean things about that
 * workbook's layout. Borrowing ids from it would couple this report to a file
 * that is rebuilt whenever the shop restyles its estimate, with the numbering
 * shifting underneath us. Sixty lines of stylesheet is cheaper than that
 * coupling, so this owns its own.
 *
 * STYLE IDS ARE BUILT, NOT COUNTED. A cellXfs list is addressed by position,
 * and hand-numbering one is how a workbook ends up with money in the date
 * column. The table below is written by name, the XML and the name->index map
 * are generated from it together, and nothing in this file ever writes a bare
 * number into an s="" attribute.
 *
 * TYPED CELLS, ALWAYS. A price is a number and a due date is a date serial,
 * never "$7,520" and "09-16-2026". A spreadsheet is a thing people sort, filter
 * and sum, and a string does none of that - see U.excelDate.
 */
(function (root) {
  'use strict';

  var U = root.U;
  var esc = root.Zip.esc, colName = root.Zip.colName, num = root.Zip.num;

  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /* ---- the palette ------------------------------------------------------ */

  /* Lifted from assets/tokens.css so a status is the same colour in the sheet
     as it is on the screen. ARGB, which is what OOXML wants. */
  var C = {
    chrome:     'FF0F172A',   // header bar - the app's chrome navy
    chromeInk:  'FFE2E8F0',
    band:       'FFF8FAFC',   // every other body row
    line:       'FFE2E8F0',
    ink:        'FF0F172A',
    muted:      'FF64748B',
    okSoft:     'FFD1FAE5', okInk:      'FF065F46',
    warnSoft:   'FFFEF3C7', warnInk:    'FF92400E',
    dangerSoft: 'FFFEE2E2', dangerInk:  'FF991B1B',
    infoSoft:   'FFEDE9FE', infoInk:    'FF5B21B6',
    neutralSoft:'FFF1F5F9', neutralInk: 'FF475569',
    brandSoft:  'FFEFF6FF', brandInk:   'FF1D4ED8'
  };

  /* ---- the stylesheet --------------------------------------------------- */

  var FMT = {
    money:    164,
    hours:    165,
    date:     166,
    datetime: 167,
    int:      168
  };

  var NUM_FMTS =
    '<numFmts count="5">' +
      '<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>' +
      '<numFmt numFmtId="165" formatCode="0.0"/>' +
      '<numFmt numFmtId="166" formatCode="mm\\-dd\\-yyyy"/>' +
      '<numFmt numFmtId="167" formatCode="mm\\-dd\\-yyyy\\ hh:mm"/>' +
      '<numFmt numFmtId="168" formatCode="#,##0"/>' +
    '</numFmts>';

  // font index -> definition. 0 must be the body font; Excel assumes it.
  var FONTS = [
    '<font><sz val="11"/><color rgb="' + C.ink + '"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="' + C.ink + '"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="' + C.chromeInk + '"/><name val="Calibri"/></font>',
    '<font><b/><sz val="16"/><color rgb="' + C.ink + '"/><name val="Calibri"/></font>',
    '<font><sz val="9"/><color rgb="' + C.muted + '"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="' + C.dangerInk + '"/><name val="Calibri"/></font>',
    '<font><sz val="11"/><color rgb="' + C.muted + '"/><name val="Calibri"/></font>'
  ];
  var F = { body: 0, bold: 1, header: 2, title: 3, small: 4, danger: 5, muted: 6 };

  function solid(rgb) {
    return '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb +
      '"/><bgColor indexed="64"/></patternFill></fill>';
  }

  // 0 and 1 are reserved by the format: Excel requires none then gray125.
  var FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    solid(C.chrome), solid(C.band), solid(C.okSoft), solid(C.warnSoft),
    solid(C.dangerSoft), solid(C.infoSoft), solid(C.neutralSoft), solid(C.brandSoft)
  ];
  var FL = { none: 0, header: 2, band: 3, ok: 4, warn: 5, danger: 6, info: 7,
             neutral: 8, brand: 9 };

  var BORDERS = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color rgb="' + C.line +
      '"/></bottom><diagonal/></border>',
    '<border><left/><right/><top style="thin"><color rgb="' + C.ink +
      '"/></top><bottom/><diagonal/></border>'
  ];
  var B = { none: 0, under: 1, over: 2 };

  /* THE STYLE TABLE. Each entry becomes one <xf> and one name in S.
     `band` variants exist because a banded row's fill has to be on the cell -
     OOXML has no "every other row" rule short of conditional formatting, which
     is a great deal of XML for a stripe. */
  var XFS = [
    ['base',        {}],
    ['title',       { font: F.title }],
    ['sub',         { font: F.small }],
    ['subKey',      { font: F.bold }],
    ['header',      { font: F.header, fill: FL.header, align: 'center', wrap: true }],

    ['text',        { border: B.under }],
    ['textB',       { border: B.under, fill: FL.band }],
    ['muted',       { border: B.under, font: F.muted }],
    ['mutedB',      { border: B.under, font: F.muted, fill: FL.band }],

    ['money',       { border: B.under, fmt: FMT.money, align: 'right' }],
    ['moneyB',      { border: B.under, fmt: FMT.money, align: 'right', fill: FL.band }],
    ['hours',       { border: B.under, fmt: FMT.hours, align: 'right' }],
    ['hoursB',      { border: B.under, fmt: FMT.hours, align: 'right', fill: FL.band }],
    ['int',         { border: B.under, fmt: FMT.int, align: 'right' }],
    ['intB',        { border: B.under, fmt: FMT.int, align: 'right', fill: FL.band }],
    ['date',        { border: B.under, fmt: FMT.date, align: 'center' }],
    ['dateB',       { border: B.under, fmt: FMT.date, align: 'center', fill: FL.band }],
    ['stamp',       { border: B.under, fmt: FMT.datetime, align: 'center' }],
    ['stampB',      { border: B.under, fmt: FMT.datetime, align: 'center', fill: FL.band }],

    // A due date already past, in the one place emphasis earns its keep.
    ['overdue',     { border: B.under, fmt: FMT.date, align: 'center', font: F.danger }],
    ['overdueB',    { border: B.under, fmt: FMT.date, align: 'center', font: F.danger,
                      fill: FL.band }],

    // The status pill, one per tone. No banded twin: the fill IS the value.
    ['tone-ok',      { border: B.under, fill: FL.ok, align: 'center' }],
    ['tone-warn',    { border: B.under, fill: FL.warn, align: 'center' }],
    ['tone-danger',  { border: B.under, fill: FL.danger, align: 'center' }],
    ['tone-info',    { border: B.under, fill: FL.info, align: 'center' }],
    ['tone-neutral', { border: B.under, fill: FL.neutral, align: 'center' }],
    ['tone-brand',   { border: B.under, fill: FL.brand, align: 'center' }],

    /* A count that is also a warning - overdue bids on the Summary. It needs
       the fill AND the number format; the tone styles above carry no numFmt,
       so reusing one of those turns the figure into General and drops the
       thousands separator. */
    ['intAlarm',    { border: B.under, fill: FL.danger, fmt: FMT.int, align: 'right',
                      font: F.danger }],

    ['totLabel',    { font: F.bold, border: B.over }],
    ['totMoney',    { font: F.bold, border: B.over, fmt: FMT.money, align: 'right' }],
    ['totHours',    { font: F.bold, border: B.over, fmt: FMT.hours, align: 'right' }],
    ['totInt',      { font: F.bold, border: B.over, fmt: FMT.int, align: 'right' }]
  ];

  var S = {};
  XFS.forEach(function (x, i) { S[x[0]] = i; });

  function xfXML(o) {
    var parts = ' numFmtId="' + (o.fmt || 0) + '" fontId="' + (o.font || 0) +
      '" fillId="' + (o.fill || 0) + '" borderId="' + (o.border || 0) + '"';
    if (o.fmt) parts += ' applyNumberFormat="1"';
    if (o.font) parts += ' applyFont="1"';
    if (o.fill) parts += ' applyFill="1"';
    if (o.border) parts += ' applyBorder="1"';
    if (o.align || o.wrap) {
      return '<xf' + parts + ' applyAlignment="1"><alignment' +
        (o.align ? ' horizontal="' + o.align + '"' : '') +
        ' vertical="center"' + (o.wrap ? ' wrapText="1"' : '') + '/></xf>';
    }
    return '<xf' + parts + '/>';
  }

  function stylesXML() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        NUM_FMTS +
        '<fonts count="' + FONTS.length + '">' + FONTS.join('') + '</fonts>' +
        '<fills count="' + FILLS.length + '">' + FILLS.join('') + '</fills>' +
        '<borders count="' + BORDERS.length + '">' + BORDERS.join('') + '</borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
        '</cellStyleXfs>' +
        '<cellXfs count="' + XFS.length + '">' +
          XFS.map(function (x) { return xfXML(x[1]); }).join('') +
        '</cellXfs>' +
        '<cellStyles count="1">' +
          '<cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  /* ---- a sheet under construction --------------------------------------- */

  /* Deliberately not the Sheet in js/estimate.xlsx.js. That one is depended on
     by an export whose output is compared cell-for-cell against a real
     workbook, and this needs three things it does not have - frozen panes, an
     autofilter and its own column widths. Widening a tested builder to serve a
     second caller is how both callers end up fragile. */
  function Sheet(name) {
    this.name = name;
    this.rows = [];
    this.next = 1;
    this.maxCol = 0;
    this.merges = [];
    this.widths = null;
    this.freeze = null;
    this.filter = null;
  }

  /* One row. `cells` is an array of values or [value, style] pairs; a null
     hole leaves the cell empty but still advances the column. */
  Sheet.prototype.row = function (cells, o) {
    var opts = o || {};
    var n = this.next++;
    var out = [];
    (cells || []).forEach(function (c, i) {
      var v = Array.isArray(c) ? c[0] : c;
      var s = Array.isArray(c) ? c[1] : opts.style;
      if (v == null && s == null) return;
      out.push({ col: i, v: v, s: s == null ? null : s });
    });
    this.maxCol = Math.max(this.maxCol, (cells || []).length);
    this.rows.push({ n: n, cells: out, ht: opts.ht || null });
    return n;
  };

  Sheet.prototype.blank = function () { return this.next++; };

  Sheet.prototype.merge = function (rowN, from, to) {
    if (to > from) this.merges.push(colName(from) + rowN + ':' + colName(to) + rowN);
  };

  Sheet.prototype.setWidths = function (list) {
    this.widths = list;
    this.maxCol = Math.max(this.maxCol, list.length);
  };

  function cellXML(c, rowN) {
    var ref = colName(c.col) + rowN;
    var attrs = ' r="' + ref + '"' + (c.s == null ? '' : ' s="' + c.s + '"');
    var v = c.v;
    if (v == null || v === '') return '<c' + attrs + '/>';
    // { f: 'SUM(D6:D20)' } - a live formula, so a recipient deleting a row
    // gets a total that still means something.
    if (typeof v === 'object' && v.f) {
      return '<c' + attrs + '><f>' + esc(v.f) + '</f></c>';
    }
    if (typeof v === 'number') return '<c' + attrs + '><v>' + num(v) + '</v></c>';
    if (typeof v === 'boolean') return '<c' + attrs + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
    return '<c' + attrs + ' t="inlineStr"><is><t xml:space="preserve">' +
      esc(v) + '</t></is></c>';
  }

  Sheet.prototype.xml = function () {
    var body = this.rows.map(function (r) {
      return '<row r="' + r.n + '"' +
        (r.ht ? ' ht="' + r.ht + '" customHeight="1"' : '') + '>' +
        r.cells.map(function (c) { return cellXML(c, r.n); }).join('') +
      '</row>';
    }).join('');

    var lastRow = Math.max(this.next - 1, 1);
    var lastCol = colName(Math.max(this.maxCol, 1) - 1);

    var view = '<sheetView showGridLines="0" workbookViewId="0">';
    if (this.freeze) {
      var x = this.freeze.x || 0, y = this.freeze.y || 0;
      view += '<pane' + (x ? ' xSplit="' + x + '"' : '') +
        (y ? ' ySplit="' + y + '"' : '') +
        ' topLeftCell="' + colName(x) + (y + 1) + '"' +
        ' activePane="bottomRight" state="frozen"/>' +
        '<selection pane="bottomRight"/>';
    }
    view += '</sheetView>';

    var cols = this.widths
      ? '<cols>' + this.widths.map(function (w, i) {
          return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w +
            '" customWidth="1"/>';
        }).join('') + '</cols>'
      : '';

    /* ELEMENT ORDER IS THE SCHEMA'S, NOT OURS. CT_Worksheet fixes it, and
       autoFilter comes before mergeCells. Out of order, Excel does not read
       the sheet wrong - it refuses the file and offers to repair it. */
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
        '<sheetViews>' + view + '</sheetViews>' +
        '<sheetFormatPr defaultRowHeight="15"/>' +
        cols +
        '<sheetData>' + body + '</sheetData>' +
        (this.filter ? '<autoFilter ref="' + this.filter + '"/>' : '') +
        (this.merges.length
          ? '<mergeCells count="' + this.merges.length + '">' +
            this.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') +
            '</mergeCells>'
          : '') +
        '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" ' +
          'header="0.3" footer="0.3"/>' +
      '</worksheet>';
  };

  /* ---- sheet names ------------------------------------------------------ */

  /* Excel's rules, and then uniqueness. THIS IS THE BUG THAT STARTED ALL OF
     THIS: the old export named a sheet per project, truncated to 28 characters,
     and two projects sharing a prefix crashed it outright. Nothing here is
     named after a project any more - but a name is still forced unique, because
     a workbook that throws on the thirty-first bid is not a report. */
  function sheetName(want, taken) {
    var base = String(want || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    var name = base, n = 1;
    while (taken[name.toLowerCase()]) {
      var suffix = ' (' + (++n) + ')';
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    taken[name.toLowerCase()] = true;
    return name;
  }

  /* ---- the container ---------------------------------------------------- */

  function build(sheets) {
    var parts = [];
    var rels = [];

    sheets.forEach(function (s, i) {
      parts.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml() });
      rels.push('<Relationship Id="rId' + (i + 1) + '" Type="' + NS_REL +
        '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    });

    var styleRel = 'rId' + (sheets.length + 1);
    parts.push({ name: 'xl/styles.xml', data: stylesXML() });
    rels.push('<Relationship Id="' + styleRel + '" Type="' + NS_REL +
      '/styles" Target="styles.xml"/>');

    parts.push({
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
        '<sheets>' + sheets.map(function (s, i) {
          return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) +
            '" r:id="rId' + (i + 1) + '"/>';
        }).join('') + '</sheets>' +
        '<calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>'
    });

    parts.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/' +
        'relationships">' + rels.join('') + '</Relationships>'
    });

    parts.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/' +
        'relationships"><Relationship Id="rId1" Type="' + NS_REL +
        '/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    });

    var CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
    parts.push({
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-' +
          'package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="' + CT + '.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
            '.xml" ContentType="' + CT + '.worksheet+xml"/>';
        }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="' + CT + '.styles+xml"/>' +
        '</Types>'
    });

    return root.Zip.write(parts);
  }

  root.Report = {
    Sheet: Sheet,
    S: S, C: C, FMT: FMT,
    sheetName: sheetName,
    stylesXML: stylesXML,
    build: build
  };
})(window);
