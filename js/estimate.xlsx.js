/* estimate.xlsx.js - the takeoff, exported into the shop's own estimate workbook.

   WHAT THIS REPLACES. The old export handed SheetJS an array of arrays: the
   right numbers with no formatting, no formulas and none of the lookup sheets.
   SheetJS's community build cannot write a cell style at all, so that was not
   fixable by passing it more options.

   HOW IT WORKS. tools/build-xlsx-template.js reads the shop's workbook once and
   leaves js/estimate.template.js behind: its styles.xml, theme and shared
   strings verbatim, the three lookup sheets whole, and a map saying which style
   id belongs on which kind of row. This file writes worksheets that index into
   that styles.xml, and js/xlsx.zip.js packs the result. Nothing here names a
   colour, a border or a font - restyle the template, re-run the tool, and the
   export follows.

   FORMULAS WHERE THE MODEL HAS THEM, VALUES WHERE IT DOES NOT. Every total,
   subtotal, markup and cross-sheet reference is a live formula, because those
   are arithmetic the workbook can do itself. A material quantity is a formula
   only when the estimator wrote one (qtyMode 'formula', which is the same
   TK("column") expression the takeoff grid evaluates); a hand-typed quantity
   stays a number. Inventing a formula for a typed number would put a cell in
   the workbook that silently disagrees with what somebody meant.

   THE OPTIONS COLUMN IS GONE. The template's column B held an abbreviated
   restatement of the description. The app dropped it, so the sheets written
   here are the eleven columns of SHEET_COLS and every style id and column width
   is taken from the template one column to the right. The one thing that does
   not shift is the drawing grid, which never had an Options column: it keeps
   Drawing Ref in A and its measured columns from B. */
(function (root) {
  'use strict';

  var U = root.U, M = root.TakeoffModel;

  function tpl() { return root.ESTIMATE_TEMPLATE; }
  function db() { return root.Store.db; }

  /* ---- XML ------------------------------------------------------------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Excel rejects the C0 controls outright; a stray tab or newline pasted
      // into a description would otherwise make the whole file unreadable.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(i) {
    var s = '';
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) {
      s = String.fromCharCode(65 + (i - 1) % 26) + s;
    }
    return s;
  }

  /* Float dust: 45292.30150000001 is the same money as 45292.3015 and one of
     them makes the sheet look broken. Ten places is far past the cent and well
     inside a double's honest precision. */
  function num(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 1e10) / 1e10;
  }

  /* ---- a sheet under construction --------------------------------------- */

  /* Rows are collected as data and serialised at the end, so a formula written
     on row 12 can refer to a row that has not been built yet - which is the
     whole difficulty with this file: almost every formula points downwards. */
  function Sheet(cols) {
    this.cols = cols || '';
    this.rows = [];
    this.merges = [];
    this.maxCol = 0;
    this.next = 1;
  }

  /* styles: array of style ids, one per column, from the harvested map.
     values: same length. Each entry is null (empty but styled), a number,
             a string, or { f: 'FORMULA', v: cachedValue }.
     Returns the row number it landed on, which is what the callers plan with. */
  Sheet.prototype.add = function (styles, values, ht) {
    var r = this.next++;
    var cells = [];
    for (var i = 0; i < styles.length; i++) {
      var s = styles[i];
      var v = values ? values[i] : null;
      if (s == null && (v == null || v === '')) continue;
      cells.push({ col: i, s: s, v: v });
      if (i + 1 > this.maxCol) this.maxCol = i + 1;
    }
    this.rows.push({ n: r, ht: ht || null, cells: cells });
    return r;
  };

  Sheet.prototype.blank = function (styles) { return this.add(styles, null); };

  Sheet.prototype.merge = function (row, from, to) {
    if (to <= from) return;
    this.merges.push(colName(from) + row + ':' + colName(to) + row);
  };

  Sheet.prototype.xml = function (opts) {
    var o = opts || {};
    var body = this.rows.map(function (row) {
      var cells = row.cells.map(function (c) {
        var ref = colName(c.col) + row.n;
        var attrs = ' r="' + ref + '"' + (c.s == null ? '' : ' s="' + c.s + '"');
        var v = c.v;
        if (v == null || v === '') return '<c' + attrs + '/>';
        if (typeof v === 'object') {
          return '<c' + attrs + '><f>' + esc(v.f) + '</f>' +
            (v.v == null ? '' : '<v>' + num(v.v) + '</v>') + '</c>';
        }
        if (typeof v === 'number') return '<c' + attrs + '><v>' + num(v) + '</v></c>';
        return '<c' + attrs + ' t="inlineStr"><is><t xml:space="preserve">' +
          esc(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + row.n + '"' +
        (row.ht ? ' ht="' + row.ht + '" customHeight="1"' : '') + '>' + cells + '</row>';
    }).join('');

    var last = colName(Math.max(this.maxCol, 1) - 1) + Math.max(this.next - 1, 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:' + last + '"/>' +
      '<sheetViews><sheetView' + (o.showGridLines === false ? ' showGridLines="0"' : '') +
        ' workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="14.4"/>' +
      this.cols +
      '<sheetData>' + body + '</sheetData>' +
      (this.merges.length
        ? '<mergeCells count="' + this.merges.length + '">' +
          this.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') +
          '</mergeCells>'
        : '') +
      '</worksheet>';
  };

  /* ---- quantity expressions -------------------------------------------- */

  /* The takeoff's own little formula language is already a subset of Excel's,
     so translating it is mostly a matter of resolving TK("column") to the cell
     that column's Sub Total lands in.

     CEILING and FLOOR are the exception and the reason this is a translation
     rather than a copy. The takeoff reads their second argument as a number of
     decimal places, the way ROUNDUP does; Excel reads it as a significance, so
     CEILING(7.2, 0) is 7.2 rounded up to nothing in the takeoff and a flat 0 in
     Excel. They are rewritten to the functions that mean in Excel what they
     meant here. */
  function toExcel(expr, addressOf) {
    var out = '';
    var i = 0;
    while (i < expr.length) {
      var rest = expr.slice(i);
      var tk = /^TK\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/i.exec(rest);
      if (tk) {
        var addr = addressOf(tk[2].replace(/\\(.)/g, '$1'));
        if (!addr) return null;                 // no grid to point at
        out += addr;
        i += tk[0].length;
        continue;
      }
      var fn = /^([A-Za-z]+)\s*\(/.exec(rest);
      if (fn) {
        var name = fn[1].toUpperCase();
        var mapped = name === 'CEILING' ? 'ROUNDUP' : name === 'FLOOR' ? 'ROUNDDOWN' : name;
        if (['ROUNDUP', 'ROUNDDOWN', 'ROUND', 'MIN', 'MAX', 'ABS'].indexOf(mapped) < 0) return null;
        out += mapped + '(';
        i += fn[0].length;
        continue;
      }
      out += expr[i++];
    }
    return out;
  }

  /* ---- one product as a worksheet --------------------------------------- */

  /* Laid out in two passes. The first works out what row everything lands on -
     the material count varies per product, and so does the number of cost lines
     once hidden ones are dropped - and the second writes it, by which time
     every address a formula needs is known. */
  function productSheet(p, t) {
    var T = tpl().product, S = T.s;
    var calc = M.computeProduct(p);
    var sheet = new Sheet(T.cols);
    var COLS = 13;

    /* Columns, in the order SHEET_COLS defines them. Len/PKT Qty and the unit
       it is counted in sit next to the Description, because they describe the
       part rather than the job - and because putting them beside Qty would
       have three unit columns in a row. */
    var FEATURE = 0, VENDOR = 1, PARTNO = 2, DESC = 3, PACKQTY = 4, PACKUM = 5,
        QTY = 6, UM = 7, MATERIAL = 8, GRADE = 9, WEIGHT = 10, RATE = 11, TOTAL = 12;
    // Named for what they address rather than for the letters they happen to
    // be, since inserting a column moves every one of them.
    var totalCol = colName(TOTAL), qtyCol = colName(QTY), rateCol = colName(RATE),
        packCol = colName(PACKQTY), valCol = colName(VENDOR);

    function row(styles, fill) {
      var v = new Array(COLS).fill(null);
      if (fill) Object.keys(fill).forEach(function (k) { v[k] = fill[k]; });
      return sheet.add(styles, v);
    }

    /* A group with nothing measured gets no grid block at all. The old export
       printed its header and a Sub Total row of zeros, which reads as "we
       measured this and it came to nothing" rather than "nobody measured it". */
    var grids = p.groups.map(function (g) {
      var rows = (g.grid && g.grid.rows) || [];
      var cols = (g.grid && g.grid.columns) || [];
      return { group: g, cols: cols, rows: rows, live: rows.length > 0 && cols.length > 0 };
    });

    /* A quantity formula points down the sheet, at a Sub Total row in a drawing
       grid that has not been written yet. Rather than compute the whole layout
       twice to find out where, the material rows are written with their plain
       value and remembered; once the grids are down and their row numbers are
       real, the cells are patched in place. Cells stay objects until the sheet
       is serialised, so a patch is an assignment. */
    var pending = [];

    function resolveFor(group) {
      var grid = grids.filter(function (x) { return x.group === group; })[0];
      return function (label) {
        if (!grid || !grid.live || grid.totalRow == null) return null;
        for (var i = 0; i < grid.cols.length; i++) {
          var c = grid.cols[i];
          // Including the pre-schema-16 spelling, with the unit in the heading -
          // see the note on TakeoffModel.gridSubtotals.
          if (c.label === label || c.key === label ||
              (c.um && c.label + ' (' + c.um + ')' === label)) {
            return colName(i + 1) + grid.totalRow;
          }
        }
        return null;
      };
    }

    /* A scope's total is the Sub Total cells of every column that carries its
       name, in every group of the product - so the sheet adds them up the same
       way TakeoffModel.scopeTotal does, rather than freezing the sum. Two
       groups measuring the same rail come out as C41+C58, and re-measuring
       either one in Excel moves what gets ordered. */
    function resolveScope(key) {
      var addrs = [];
      grids.forEach(function (grid) {
        if (!grid.live || grid.totalRow == null) return;
        grid.cols.forEach(function (col, i) {
          if (M.scopeKey(col.label) === key) addrs.push(colName(i + 1) + grid.totalRow);
        });
      });
      if (!addrs.length) return null;
      return addrs.length === 1 ? addrs[0] : '(' + addrs.join('+') + ')';
    }

    /* -- the header and the two identifying rows -------------------------- */

    sheet.add(S.header, ['Features', 'Vendor', 'Vendor Part No', 'Desription',
      'Length/PKT Qty', 'Stock U/M', 'Qty', 'U/M', 'Material', 'Grade',
      'Weight (lb)', 'Unit Cost', 'Total Cost']);
    row(S.sow, { 0: 'SOW', 1: p.sow || '' });
    row(S.sow, { 0: 'Material', 1: p.material || '' });
    sheet.blank(S.blank);

    /* -- the material block ----------------------------------------------- */

    var firstItem = sheet.next;
    var multi = p.groups.length > 1;

    grids.forEach(function (grid) {
      var g = grid.group;
      if (multi) row(S.group, { 0: g.name });
      g.items.forEach(function (it) {
        var qty = M.itemQty(it, g, p);            // what gets ordered
        var req = M.requiredQty(it, g, p);        // what the job needs
        var per = U.n(it.packQty);
        var r = sheet.next;
        var total = M.itemTotal(it, g, p);
        var fill = {};
        fill[FEATURE] = it.feature || '';
        fill[VENDOR] = it.vendor || '';
        fill[PARTNO] = it.partNo || '';
        fill[DESC] = it.description || '';
        fill[PACKQTY] = per > 0 ? num(per) : null;
        fill[PACKUM] = it.packUm || '';
        fill[QTY] = qty == null ? null : num(qty);
        fill[UM] = it.um || '';
        fill[MATERIAL] = it.material || '';
        fill[GRADE] = it.grade || '';
        fill[WEIGHT] = it.weightLb == null || it.weightLb === '' ? null : num(it.weightLb);
        fill[RATE] = it.unitCost == null || it.unitCost === '' ? null : num(it.unitCost);
        // Always a formula: the line total is qty times rate by definition, and
        // an estimator changing a unit cost in Excel should see it move.
        fill[TOTAL] = { f: qtyCol + r + '*' + rateCol + r, v: total };
        row(S.item, fill);

        var cells = sheet.rows[sheet.rows.length - 1].cells;
        var qtyCell = null, totalCell = null;
        for (var i = 0; i < cells.length; i++) {
          if (cells[i].col === QTY) qtyCell = cells[i];
          if (cells[i].col === TOTAL) totalCell = cells[i];
        }

        /* A quantity the estimator typed over the calculation stays the number
           they typed - no ROUNDUP, in either branch below. Writing the formula
           anyway would put a cell in the workbook that recalculates itself back
           to the figure somebody had already decided against, which is the
           "inventing a formula for a typed number" this file opens by warning
           about. The stock size is still written beside it, so the sheet shows
           what the calculation would have said. */
        var typedOver = it.orderQtyOverride != null && it.orderQtyOverride !== '';

        if (!typedOver && it.qtyMode === 'formula' && it.qtyExpr && qty != null && qtyCell) {
          pending.push({ kind: 'expr', cell: qtyCell, it: it, g: g, qty: qty });
        } else if (!typedOver && it.qtyMode === 'takeoff' && it.scopeKey && qty != null && qtyCell) {
          // Both cells are patched once the grids exist - see below.
          pending.push({ kind: 'scope', cell: qtyCell, totalCell: totalCell,
                         it: it, qty: qty, total: total, row: r });
        } else if (it.costBasis === 'unit' && req != null && totalCell) {
          /* Priced by the foot rather than by the stick, on a row whose Qty
             cell is not the quantity being paid for - either nobody measured
             it, or somebody typed over what was measured. Either way the total
             cannot be read off the Qty column, so the needed quantity goes into
             the formula as the number it is, leaving the rate live. */
          totalCell.v = { f: num(req) + '*' + rateCol + r, v: total };
        }
      });
    });
    var lastItem = sheet.next - 1;

    /* -- material cost, and the quantity the labour is priced off ---------- */

    var matRow = row(S.matCost, {
      0: 'Material Cost',
      1: { f: 'SUM(' + totalCol + firstItem + ':' + totalCol + Math.max(lastItem, firstItem) + ')',
           v: calc.materialCost }
    });
    sheet.merge(matRow, 1, COLS - 1);
    sheet.blank(S.blank);

    /* A value, not a formula. p.totalLF is typed on the product - it is what
       the estimator says the job runs to, which is not always the sum of what
       is on the drawings. */
    var lfRow = row(S.totalLF, {
      0: p.unit === 'EA' ? 'Total Qty' : 'Total linear feet',
      1: p.totalLF == null ? null : num(p.totalLF)
    });
    sheet.blank(S.blank);

    /* -- finish, labour, equipment, extras -------------------------------- */

    var rates = root.Rates.forType(p.type, t);
    var lfCell = valCol + lfRow;

    /* The three labour hours and the finish quantity are derived from the run
       length unless the estimator has taken one over - p.overrides says which.
       Where they are still derived, the sheet gets the same arithmetic Rates
       .derive() does, so changing the run length in Excel moves the hours. */
    // "+0" is arithmetic nobody wrote: the installation formula has no constant
    // on most product types, and printing one invites somebody to wonder what
    // it was for.
    function hours(factor, base) {
      return lfCell + '*' + num(factor) + (U.n(base) ? '+' + num(base) : '');
    }

    var DERIVED = {
      finish: { path: 'finish.qty', f: function () { return lfCell; } },
      engineering: { path: 'labour.engineering.hrs',
        f: function () { return hours(rates.engFactor, rates.engBase); } },
      fabrication: { path: 'labour.fabrication.hrs',
        f: function () { return hours(rates.fabFactor, rates.fabBase); } },
      installation: { path: 'labour.installation.hrs',
        f: function () { return hours(rates.instFactor, rates.instBase); } }
    };

    var costRows = [];
    var lines = [];

    M.COST_ROWS.forEach(function (def) {
      if (M.isRowHidden(p, def.id)) return;
      var qty = U.n(M.pathGet(p, def.qtyPath));
      var rate = U.n(M.pathGet(p, def.ratePath));
      var d = DERIVED[def.id];
      var qtyCell = num(qty);
      if (d && !(p.overrides || {})[d.path]) qtyCell = { f: d.f(), v: qty };
      lines.push({ label: M.rowLabel(p, def.id), qty: qtyCell, um: M.rowUnit(p, def.id),
        rate: rate, total: calc[def.totalKey], finish: def.id === 'finish' });
    });

    (p.extras || []).forEach(function (e) {
      lines.push({ label: e.label || '', qty: num(U.n(e.qty)), um: e.um || '',
        rate: U.n(e.unitPrice), total: M.extraAmount(e) });
    });

    lines.forEach(function (line, i) {
      var last = i === lines.length - 1;
      var styles = line.finish ? S.finish : last ? S.costLast : S.cost;
      var r = sheet.next;
      var fill = {};
      fill[FEATURE] = line.label;
      fill[QTY] = line.qty;
      fill[UM] = line.um;
      fill[RATE] = num(line.rate);
      fill[TOTAL] = { f: qtyCol + r + '*' + rateCol + r, v: line.total };
      costRows.push(row(styles, fill));
    });

    /* -- the three totals -------------------------------------------------- */

    var parts = [valCol + matRow].concat(costRows.map(function (r) { return totalCol + r; }));
    var subFill = {};
    subFill[FEATURE] = 'Material+Engg+Fab+Install Cost';
    subFill[TOTAL] = { f: parts.join('+'), v: calc.subtotal };
    var subRow = row(S.subtotal, subFill);
    sheet.blank(S.blank);

    var markRow = row(S.pct, {
      0: 'Overall Mark ups + Margine (' + U.n(p.markupPct) + '%)',
      1: { f: totalCol + subRow + '*' + U.n(p.markupPct) + '%', v: calc.markup }
    });
    var overRow = row(S.pct, {
      0: 'Overhead & Profit (' + U.n(p.overheadPct) + '%)',
      1: { f: totalCol + subRow + '*' + U.n(p.overheadPct) + '%', v: calc.overhead }
    });
    var totRow = row(S.total, {
      0: 'Total Cost',
      1: { f: totalCol + subRow + '+' + valCol + markRow + '+' + valCol + overRow, v: calc.total }
    });
    sheet.blank(S.blank);

    /* -- the drawing grids ------------------------------------------------- */

    /* Written last, but their Sub Total row numbers were promised to the
       material block above. Nothing else reads them, so the promise is kept by
       planning the block's height here and filling the rows in as we go. */
    grids.forEach(function (grid) {
      if (!grid.live) return;
      var width = grid.cols.length + 1;
      var pad = function (base) {
        var out = base.slice(0, width);
        while (out.length < width) out.push(base[base.length - 1]);
        return out;
      };

      var titleRow = sheet.add(pad(S.gridTitle),
        [grid.group.name].concat(new Array(width - 1).fill(null)), T.heights.gridTitle);
      sheet.merge(titleRow, 0, width - 1);

      // The unit is a field now, but on paper it still belongs in the heading -
      // that is where the workbook has always carried it.
      sheet.add(pad(S.gridHeader),
        ['Drawing Ref. No'].concat(grid.cols.map(function (c) {
          return c.label + (c.um ? ' (' + c.um + ')' : '');
        })),
        T.heights.gridHeader);

      var first = sheet.next;
      grid.rows.forEach(function (r) {
        sheet.add(pad(S.gridRow), [r.ref || ''].concat(grid.cols.map(function (c) {
          var v = r.values[c.key];
          return v == null || v === '' ? null : num(U.n(v));
        })));
      });
      var last = sheet.next - 1;

      var subs = M.gridSubtotals(grid.group);
      grid.totalRow = sheet.add(pad(S.gridTotal),
        ['Sub Total'].concat(grid.cols.map(function (c, i) {
          var col = colName(i + 1);
          return { f: 'SUM(' + col + first + ':' + col + last + ')', v: subs[c.key] };
        })));
      sheet.blank(pad(S.blank));
    });

    /* Now the Sub Total rows exist, so the quantities that were written as
       plain numbers can become the formulas the estimator actually wrote. One
       that will not translate - an unknown function, or a column that is not on
       any grid - keeps its number, which is still the right answer. */
    pending.forEach(function (q) {
      if (q.kind === 'expr') {
        var f = toExcel(String(q.it.qtyExpr), resolveFor(q.g));
        if (f) q.cell.v = { f: f, v: q.qty };
        return;
      }
      /* A measured row: what to order is what the drawings came to, divided by
         what a stick holds, rounded up. Written out rather than cached, so the
         division is on the face of the sheet where it can be argued with -
         which is the point of recording it at all. The divisor is the sheet's
         own Len/PKT cell, so correcting a stock length in Excel re-orders. */
      var addrs = resolveScope(q.it.scopeKey);
      if (!addrs) return;                          // no grid to point at
      var per = U.n(q.it.packQty);
      q.cell.v = {
        f: 'ROUNDUP(' + addrs + (per > 0 ? '/' + packCol + q.row : '') + ',0)',
        v: q.qty
      };
      if (q.it.costBasis === 'unit' && q.totalCell) {
        q.totalCell.v = { f: addrs + '*' + rateCol + q.row, v: q.total };
      }
    });

    return { xml: sheet.xml(), totalRow: totRow, lfRow: lfRow, calc: calc };
  }

  /* ---- the front sheet --------------------------------------------------- */

  /* The same four identifying rows the template opens with, then a line per
     product pointing at that product's own Total Cost, then the roll-up. Every
     figure below the product lines is a formula, so an estimator can change a
     unit cost three sheets away and watch the bid total move. */
  function summarySheet(t, roll, built) {
    var T = tpl().summary, S = T.s, H = T.heights;
    var bid = t.bidId ? db().bids.filter(function (b) { return b.id === t.bidId; })[0] : null;
    var sheet = new Sheet(T.cols);
    var r = t.rollup || {};

    function meta(styles, label, value, ht, mergeBC) {
      var row = sheet.add(styles, [label, value], ht);
      if (mergeBC) sheet.merge(row, 1, 2);
      return row;
    }

    meta(S.meta0, 'Project Name', t.project.name || '', H.meta0, true);
    meta(S.meta1, 'Location', t.project.location || '', H.meta1, false);
    meta(S.meta2, 'Proposal No',
      (bid && bid.proposalNo) || t.project.proposalNo || '', H.meta2, true);
    // U.date renders an empty date as a dash for the screen; a spreadsheet cell
    // is better left blank than filled with punctuation.
    meta(S.meta3, 'Bid Due Date',
      t.project.bidDueDate ? U.date(t.project.bidDueDate) : '', H.meta3, true);
    sheet.blank([null, null, null]);

    var bandRow = sheet.add(S.band, ['Project Cost Summary'], H.band);
    sheet.merge(bandRow, 0, 2);

    var first = sheet.next;
    built.forEach(function (b) {
      var row = sheet.add(S.product, [
        b.product.type,
        null,
        { f: '\'' + b.sheetName.replace(/'/g, "''") + '\'!' + 'B' + b.totalRow, v: b.calc.total },
        null,
        { f: '\'' + b.sheetName.replace(/'/g, "''") + '\'!' + 'B' + b.lfRow,
          v: U.n(b.product.totalLF) },
        b.product.unit || ''
      ], H.product);
      sheet.merge(row, 0, 1);
    });
    var last = sheet.next - 1;

    function line(styles, label, value, ht, extra) {
      var vals = [label, null, value].concat(extra || []);
      var row = sheet.add(styles, vals, ht);
      sheet.merge(row, 0, 1);
      return row;
    }

    var baseRow = line(S.base, 'Project Base Cost ',
      { f: 'SUM(C' + first + ':C' + last + ')', v: roll.base }, H.base,
      ['Total LF', { f: 'SUM(E' + first + ':E' + last + ')', v: roll.totalLF }, '']);

    /* These four are written in this order and nothing else may go between
       them: the bid total sums the block from the base cost through to the
       roundoff in one range, exactly as the template does. */
    line(S.misc, 'Miscellaneous Items Cost\n(Welding Consumables, Cutting Tools)',
      { f: 'C' + baseRow + '*' + U.n(r.miscPct) + '%', v: roll.misc }, H.misc);
    line(S.freight, 'Delivery & Freight Cost', num(roll.freight), H.freight);
    line(S.tax, 'Tax (' + U.n(r.taxPct) + '%)',
      { f: 'C' + baseRow + '*' + U.n(r.taxPct) + '%', v: roll.tax }, H.tax);
    var roundRow = line(S.round, 'Roundoff', num(roll.roundoff), H.round);
    line(S.grand, 'Total Bid Cost',
      { f: 'SUM(C' + baseRow + ':C' + roundRow + ')', v: roll.total }, H.grand);

    return sheet.xml({ showGridLines: false });
  }

  /* ---- the workbook ------------------------------------------------------ */

  /* Excel refuses a sheet name over 31 characters or one that repeats, and it
     throws rather than renaming - so two products both called "Steel Guardrail
     (Interior Stairwell)" would fail the whole export. Same rule the old
     exporter used. */
  function sheetNamer() {
    var used = {};
    return function (name) {
      var base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet';
      var out = base, n = 2;
      while (used[out.toLowerCase()]) {
        var suffix = ' (' + n++ + ')';
        out = base.slice(0, 31 - suffix.length) + suffix;
      }
      used[out.toLowerCase()] = true;
      return out;
    };
  }

  var NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  function buildWorkbook(t, only) {
    if (!tpl()) throw new Error('The estimate template has not loaded.');
    var products = (t.products || []).filter(function (p) { return !only || p.id === only; });
    if (!products.length) throw new Error('There is nothing to export yet.');

    var roll = M.computeTakeoff(t);
    var name = sheetNamer();

    /* Sheet order: the lookups the estimators work against sit at the two ends,
       hidden where the template hides them, and the work is in the middle. */
    var lookups = tpl().lookups;
    var refs = lookups.filter(function (l) { return l.name !== 'Factors'; });
    var factors = lookups.filter(function (l) { return l.name === 'Factors'; });

    var sheets = [];
    refs.forEach(function (l) {
      if (l.name === 'References') sheets.push({ name: name(l.name), hidden: l.hidden, xml: l.xml });
    });

    var summarySlot = sheets.push({ name: name('Project Cost Summary') }) - 1;

    var built = products.map(function (p) {
      var out = productSheet(p, t);
      var sName = name(p.type || 'Product');
      sheets.push({ name: sName, xml: out.xml });
      return { product: p, sheetName: sName, totalRow: out.totalRow,
        lfRow: out.lfRow, calc: out.calc };
    });

    refs.forEach(function (l) {
      if (l.name !== 'References') sheets.push({ name: name(l.name), hidden: l.hidden, xml: l.xml });
    });
    factors.forEach(function (l) {
      sheets.push({ name: name(l.name), hidden: l.hidden, xml: l.xml });
    });

    sheets[summarySlot].xml = summarySheet(t, roll, built);

    /* -- the container ---------------------------------------------------- */

    var parts = [];
    var sheetRels = [];
    sheets.forEach(function (s, i) {
      var path = 'xl/worksheets/sheet' + (i + 1) + '.xml';
      parts.push({ name: path, data: s.xml });
      sheetRels.push({ id: 'rId' + (i + 1), target: 'worksheets/sheet' + (i + 1) + '.xml' });
    });

    var n = sheets.length;
    var relStyles = 'rId' + (n + 1), relTheme = 'rId' + (n + 2), relStrings = 'rId' + (n + 3);

    /* fullCalcOnLoad because the cached values written beside each formula are
       this app's arithmetic, not Excel's. They agree - the tests check that to
       the cent - but the workbook should not be asked to take our word for it,
       and a recalculated sheet is one nobody has to trust. */
    parts.push({
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
        '<workbookPr defaultThemeVersion="202300"/>' +
        '<bookViews><workbookView activeTab="' + summarySlot + '"/></bookViews>' +
        '<sheets>' + sheets.map(function (s, i) {
          return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '"' +
            (s.hidden ? ' state="hidden"' : '') + ' r:id="rId' + (i + 1) + '"/>';
        }).join('') + '</sheets>' +
        '<calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>'
    });

    parts.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheetRels.map(function (r) {
          return '<Relationship Id="' + r.id + '" Type="' + NS_REL + '/worksheet" Target="' +
            r.target + '"/>';
        }).join('') +
        '<Relationship Id="' + relStyles + '" Type="' + NS_REL + '/styles" Target="styles.xml"/>' +
        '<Relationship Id="' + relTheme + '" Type="' + NS_REL + '/theme" Target="theme/theme1.xml"/>' +
        '<Relationship Id="' + relStrings + '" Type="' + NS_REL +
          '/sharedStrings" Target="sharedStrings.xml"/>' +
        '</Relationships>'
    });

    // Verbatim: these three parts are the formatting.
    Object.keys(tpl().parts).forEach(function (k) {
      parts.push({ name: k, data: tpl().parts[k] });
    });

    parts.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
        'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    });

    var CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
    parts.push({
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.' +
          'relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="' + CT + '.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="' +
            CT + '.worksheet+xml"/>';
        }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="' + CT + '.styles+xml"/>' +
        '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-' +
          'officedocument.theme+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="' + CT + '.sharedStrings+xml"/>' +
        '</Types>'
    });

    return root.Zip.write(parts);
  }

  root.Estimate = {
    buildWorkbook: buildWorkbook,
    sheetNamer: sheetNamer,
    // Exposed for the tests, which check the CEILING/FLOOR rewrite directly.
    toExcel: toExcel,

    /* The whole takeoff, or one product from it. Same file either way - a
       single-product export still carries the lookup sheets and the summary,
       because a sheet with no References behind it cannot be worked on. */
    download: function (t, only, filename) {
      try {
        var bytes = buildWorkbook(t, only);
        root.Store.downloadBlob(new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }), filename);
        return true;
      } catch (e) {
        U.toast('Could not build the workbook: ' + e.message, 'err');
        return false;
      }
    }
  };
})(window);
