/* bids.report.js - the bid list, as a workbook.
 *
 * WHAT THE BUTTON USED TO DO. It walked db.bids and wrote every bid in the
 * database, whichever tab you were on and whatever you had filtered to, plus a
 * sheet per takeoff and the whole rate library. Two problems with that: it was
 * not the list you were looking at, and the per-takeoff sheets were NAMED AFTER
 * THE PROJECT, truncated to 28 characters - so two projects sharing a prefix
 * crashed the export outright.
 *
 * That crash stopped being hypothetical when re-opening arrived: a revision
 * entry deliberately carries the same project name as the bid it came from, so
 * a job bid twice guarantees the collision the moment both have takeoffs.
 * NOTHING HERE IS NAMED AFTER A PROJECT. The estimate detail is one flat sheet
 * keyed by proposal number, which the database already guarantees is unique.
 *
 * WHAT IT DOES NOW. Exports the tab you are on, with the columns you have
 * showing, the filters you have set and the sort you are in - read through
 * BidGrid.visibleRows and BidGrid.activeColumns, which are the same calls the
 * table renders from. The workbook and the screen cannot disagree, because
 * there is only one list.
 *
 * js/report.xlsx.js is the writer: styles, the sheet builder, the container.
 * This file is only what goes in the sheets.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }
  function R() { return root.Report; }
  function S() { return root.Report.S; }

  /* ---- reading one cell off the grid's own column definitions ------------ */

  /* Columns the workbook has no use for. `actions` is a column of buttons; the
     calendar day-columns on the Employee view are generated per render and are
     not part of the saved layout - the Bookings sheet carries those hours in a
     shape a spreadsheet can actually pivot. */
  function exportable(c) {
    return c && c.key !== 'actions';
  }

  var MONEY_COLS = { price: 1 };
  var HOUR_COLS = { estHrs: 1, assignedHrs: 1, activeEstHrs: 1, activeAsgnHrs: 1 };
  var STAMP_COLS = { createdAt: 1, lastModified: 1 };

  var WIDTHS = {
    sr: 6, proposalNo: 18, project: 38, portal: 16, region: 18, location: 22,
    products: 22, material: 14, team: 14, task: 30, price: 15,
    estHrs: 10, assignedHrs: 10, activeEstHrs: 10, activeAsgnHrs: 10,
    dueDate: 13, status: 20, result: 14, revision: 8,
    createdAt: 19, lastModified: 19
  };

  function widthOf(c) { return WIDTHS[c.key] || 16; }

  /* WHAT A COLUMN IS CALLED AT THE TOP OF THE SHEET.
   *
   * Two pairs of columns share a heading on screen - Engineer and Estm/Asgn
   * Hrs each exist for the intake stage and for the team - and each view shows
   * one of the pair, so on any given tab it reads as one column. The grid keeps
   * a `panelLabel` ("Engineer (team)") for the column chooser, where both are
   * listed at once and the bare label would be ambiguous.
   *
   * A sheet is the tab, not the chooser: normally only one of a pair is there
   * and "Engineer (team)" is clutter on something going to a client. But both
   * CAN be switched on, and two columns headed "Engineer" in a spreadsheet -
   * where the autofilter dropdown shows nothing but the heading - is worse
   * than clutter. So the plain label is used unless it collides, and the
   * disambiguated one only where it earns its keep. */
  function headings(cols) {
    var count = {};
    cols.forEach(function (c) {
      var l = c.label || c.key;
      count[l] = (count[l] || 0) + 1;
    });
    return cols.map(function (c) {
      var l = c.label || c.key;
      return count[l] > 1 ? (c.panelLabel || l) : l;
    });
  }

  /* THE TONE A STATUS IS DRAWN IN, matched to the app so the sheet and the
     screen read alike. The seven built-in statuses carry a badge class; a
     status the shop added carries a tone directly. */
  var BADGE_TONE = {
    'status-notstarted': 'neutral', 'status-progress': 'warn',
    'status-submitted': 'brand', 'status-completed': 'ok',
    'status-noscope': 'info', 'status-awarded': 'ok',
    'status-lost': 'danger', 'status-reopen': 'warn'
  };

  function statusStyle(status) {
    var def = root.Bids.statusOf(status);
    var tone = def ? (def.tone || BADGE_TONE[def.badge]) : null;
    return S()['tone-' + (tone || 'neutral')];
  }

  function isOverdue(b) {
    var due = root.Bids.effectiveDueDate(b);
    return !!due && due < U.today() && root.Bids.bucketOf(b) === 'open';
  }

  /* One cell: its value in the type Excel understands, and the style that
     formats it. `band` alternates the row fill - OOXML has no every-other-row
     rule short of conditional formatting, which is a lot of XML for a stripe. */
  function cell(c, b, index, band) {
    var s = S();
    var B = band ? 'B' : '';

    if (c.key === 'sr') return [index + 1, s['int' + B]];

    if (c.key === 'status' || c.key === 'result') {
      var text = root.BidGrid.cellText(c, b);
      return [text, text ? statusStyle(b.status) : s['text' + B]];
    }

    if (MONEY_COLS[c.key]) {
      var money = c.value(b);
      return [money == null || money === '' ? null : U.n(money), s['money' + B]];
    }

    if (HOUR_COLS[c.key]) {
      var hrs = U.n(c.value(b));
      return [hrs || null, s['hours' + B]];
    }

    if (STAMP_COLS[c.key]) {
      return [U.excelStamp(c.value(b)), s['stamp' + B]];
    }

    if (c.type === 'date') {
      var serial = U.excelDate(c.value(b));
      if (serial == null) return [null, s['date' + B]];
      return [serial, c.key === 'dueDate' && isOverdue(b)
        ? s['overdue' + B] : s['date' + B]];
    }

    if (c.type === 'number') {
      var n = c.value(b);
      return [n == null || n === '' ? null : U.n(n), s['int' + B]];
    }

    return [root.BidGrid.cellText(c, b), s['text' + B]];
  }

  /* ---- the sheets -------------------------------------------------------- */

  var VIEW_TITLE = { all: 'All Bids', active: 'Active Bids', awarded: 'Awarded Bids' };

  /* What the person reading this in three weeks needs before they read a
     number: which list it is, when it was taken, and - the part that matters -
     WHETHER IT IS ALL OF THEM. A sheet holding twelve of ninety-five bids must
     say so, or it gets read as the whole register. */
  function filterSummary() {
    var g = root.BidGrid.cfg();
    var out = [];
    Object.keys(g.filters || {}).forEach(function (k) {
      var f = g.filters[k], c = root.BidGrid.column(k);
      if (!c || !f) return;
      var label = c.panelLabel || c.label;
      if (f.contains) out.push(label + ' contains "' + f.contains + '"');
      if (f.values && f.values.length) {
        out.push(label + ' = ' + f.values.map(function (v) {
          return v === '' ? '(none)' : v;
        }).join(', '));
      }
    });
    if (g.sort && g.sort.key) {
      var sc = root.BidGrid.column(g.sort.key);
      if (sc) {
        out.push('sorted by ' + (sc.panelLabel || sc.label) +
          (g.sort.dir === 'desc' ? ' (descending)' : ''));
      }
    }
    return out;
  }

  function summarySheet(rows, view, total) {
    var s = S();
    var sh = new (R().Sheet)('Summary');
    sh.setWidths([26, 18, 4, 24, 16]);

    sh.row([['DiVerse Industrial Solutions', s.title]], { ht: 22 });
    sh.row([[VIEW_TITLE[view] || 'Bids', s.subKey]]);
    sh.row([['Exported ' + U.stamp(new Date()) +
      (actor() ? ' by ' + actor() : ''), s.sub]]);

    var filters = filterSummary();
    sh.row([[filters.length
      ? 'Showing ' + filters.join(' · ')
      : 'Showing every bid on this list — no filters applied', s.sub]]);
    if (filters.length) {
      sh.row([['This is a filtered view: ' + rows.length + ' of ' + total +
        ' bids on the list.', s.sub]]);
    }
    sh.blank();

    /* Counted off the EXPORTED rows, not the database, so the figures describe
       the sheet the reader is holding. */
    var byStatus = {};
    var value = 0, est = 0, asgn = 0, due7 = 0, over = 0;
    var today = U.today(), horizon = U.addDays(today, 7);
    rows.forEach(function (b) {
      var k = b.status || 'Not Started';
      byStatus[k] = (byStatus[k] || 0) + 1;
      value += U.n(b.price);
      var t = root.Assign.totals(b);
      est += t.est;
      asgn += t.asgn;
      var d = root.Bids.effectiveDueDate(b);
      if (d && root.Bids.bucketOf(b) === 'open') {
        if (d < today) over++;
        else if (d <= horizon) due7++;
      }
    });

    sh.row([['Bids', s.subKey], [rows.length, s.int], null,
            ['Total bid value', s.subKey], [value, s.money]]);

    /* In LIFECYCLE order - Not Started, In Progress, Submitted, Completed,
       then the outcomes - rather than alphabetically, which interleaves a
       won job with work nobody has started. Bids.allStatuses is already in
       that order and carries the shop's own added stages after the built-in
       seven, so a status invented last week lands in a sensible place without
       this needing to know about it. */
    var order = root.Bids.allStatuses().map(function (x) { return x.key; });
    Object.keys(byStatus).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = order.length;         // a status no longer on the list
      if (ib < 0) ib = order.length;
      return ia === ib ? a.localeCompare(b) : ia - ib;
    }).forEach(function (k) {
      sh.row([['   ' + k, s.muted], [byStatus[k], s.int],
              null, null, null], { style: null });
    });
    sh.blank();
    sh.row([['Estimated hrs', s.subKey], [est, s.hours], null,
            ['Due within 7 days', s.subKey], [due7, s.int]]);
    sh.row([['Booked hrs', s.subKey], [asgn, s.hours], null,
            ['Overdue', s.subKey], [over, over ? s.intAlarm : s.int]]);
    return sh;
  }

  function actor() {
    var u = root.Auth && root.Auth.user;
    if (!u) return '';
    return u.initials || u.name || u.username || '';
  }

  /* The register. The columns are whatever the table is showing, in its order,
     so this sheet IS the screen. */
  function bidsSheet(rows, cols, view) {
    var s = S();
    var sh = new (R().Sheet)('Bids');
    sh.setWidths(cols.map(widthOf));

    sh.row([[VIEW_TITLE[view] || 'Bids', s.title]], { ht: 22 });
    sh.merge(1, 0, Math.min(cols.length - 1, 4));
    var headerRow = sh.row(headings(cols).map(function (h) {
      return [h, s.header];
    }), { ht: 28 });

    var first = headerRow + 1;
    rows.forEach(function (b, i) {
      sh.row(cols.map(function (c) { return cell(c, b, i, i % 2 === 1); }));
    });
    var last = headerRow + rows.length;

    /* A TOTALS ROW OF FORMULAS, not baked figures. The recipient will sort it,
       hide rows and delete the ones they do not care about; a frozen number
       would quietly stop matching the column above it. */
    if (rows.length) {
      sh.row(cols.map(function (c, i) {
        var letter = root.Zip.colName(i);
        if (MONEY_COLS[c.key]) {
          return [{ f: 'SUM(' + letter + first + ':' + letter + last + ')' }, s.totMoney];
        }
        if (HOUR_COLS[c.key]) {
          return [{ f: 'SUM(' + letter + first + ':' + letter + last + ')' }, s.totHours];
        }
        if (c.key === 'sr') return [rows.length, s.totInt];
        if (c.key === 'project') return ['TOTAL — ' + rows.length + ' bids', s.totLabel];
        return [null, s.totLabel];
      }));
    }

    // Frozen under the header and to the right of the identity columns, so a
    // wide sheet still says which bid a figure belongs to.
    var idCols = 0;
    cols.forEach(function (c, i) {
      if (c.key === 'sr' || c.key === 'proposalNo' || c.key === 'project') {
        idCols = Math.max(idCols, i + 1);
      }
    });
    sh.freeze = { x: Math.min(idCols, 3), y: headerRow };
    if (rows.length) {
      sh.filter = 'A' + headerRow + ':' +
        root.Zip.colName(cols.length - 1) + last;
    }
    return sh;
  }

  function label(b) { return b.proposalNo || ('#' + b.id); }

  function teamSheet(rows) {
    var s = S();
    var sh = new (R().Sheet)('Team & Hours');
    sh.setWidths([18, 34, 18, 12, 26, 14, 12, 11, 11, 13]);
    sh.row([['Team & Hours', s.title]], { ht: 22 });
    sh.row([['Proposal No', s.header], ['Project', s.header], ['Status', s.header],
            ['Engineer', s.header], ['Task', s.header], ['Task Status', s.header],
            ['Completed', s.header], ['Estm Hrs', s.header], ['Asgn Hrs', s.header],
            ['Days Booked', s.header]], { ht: 28 });

    var n = 0;
    rows.forEach(function (b) {
      root.Assign.rows(b).forEach(function (r) {
        var band = (n++ % 2 === 1) ? 'B' : '';
        sh.row([
          [label(b), s['text' + band]], [b.project || '', s['text' + band]],
          [b.status || '', statusStyle(b.status)],
          [r.engineer || '', s['text' + band]], [r.taskType || '', s['text' + band]],
          [root.Assign.statusLabel(r), s['text' + band]],
          [U.excelDate(r.completedAt), s['date' + band]],
          [U.n(r.estHrs) || null, s['hours' + band]],
          [U.n(r.asgnHrs) || null, s['hours' + band]],
          [root.Assign.dayRows(r).filter(function (d) { return U.n(d.hrs) > 0; }).length || null,
           s['int' + band]]
        ]);
      });
    });
    sh.freeze = { x: 2, y: 2 };
    if (n) sh.filter = 'A2:J' + (2 + n);
    return sh;
  }

  /* ONE ROW PER PERSON PER DAY. This is the sheet that makes a workload pivot
     possible - hours by person by week is a two-click pivot table on this and
     is not reachable from any of the others. */
  function bookingsSheet(rows) {
    var s = S();
    var sh = new (R().Sheet)('Bookings');
    sh.setWidths([18, 34, 12, 26, 13, 10, 12]);
    sh.row([['Day-by-day bookings', s.title]], { ht: 22 });
    sh.row([['Proposal No', s.header], ['Project', s.header], ['Engineer', s.header],
            ['Task', s.header], ['Date', s.header], ['Hours', s.header],
            ['Weekday', s.header]], { ht: 28 });

    var n = 0;
    rows.forEach(function (b) {
      root.Schedule.bookings(b).forEach(function (k) {
        if (!k.hrs) return;          // a day box nobody has typed into is not a booking
        var band = (n++ % 2 === 1) ? 'B' : '';
        var dt = U.parseDate(k.date);
        sh.row([
          [label(b), s['text' + band]], [b.project || '', s['text' + band]],
          [k.engineer || '(unassigned)', s['text' + band]],
          [k.taskType || '', s['text' + band]],
          [U.excelDate(k.date), s['date' + band]],
          [k.hrs, s['hours' + band]],
          [dt ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : '',
           s['text' + band]]
        ]);
      });
    });
    sh.freeze = { x: 2, y: 2 };
    if (n) sh.filter = 'A2:G' + (2 + n);
    return sh;
  }

  /* Replaces the sheet-per-takeoff that used to crash. One row per product per
     bid, keyed by proposal number - flat, pivotable, and incapable of colliding
     with itself. The full estimate, with its formatting and its formulas, is
     the takeoff's own Export to Excel; this is the roll-up beside the bid. */
  function estimateSheet(rows) {
    var s = S();
    var sh = new (R().Sheet)('Estimate Lines');
    sh.setWidths([18, 34, 26, 16, 12, 10, 16, 16]);
    sh.row([['Estimate lines', s.title]], { ht: 22 });
    sh.row([['Proposal No', s.header], ['Project', s.header], ['Product', s.header],
            ['Material', s.header], ['Qty', s.header], ['U/M', s.header],
            ['Product Cost', s.header], ['Bid Total', s.header]], { ht: 28 });

    var n = 0;
    rows.forEach(function (b) {
      var t = b.takeoffId && db().takeoffs[b.takeoffId];
      if (!t) return;
      var roll;
      try { roll = root.TakeoffModel.computeTakeoff(t); } catch (e) { return; }
      (roll.products || []).forEach(function (x) {
        var band = (n++ % 2 === 1) ? 'B' : '';
        sh.row([
          [label(b), s['text' + band]], [b.project || '', s['text' + band]],
          [x.product.type || '', s['text' + band]],
          [x.product.material || '', s['text' + band]],
          [U.n(x.product.totalLF) || null, s['hours' + band]],
          [x.product.unit || '', s['text' + band]],
          [U.n(x.calc.total) || null, s['money' + band]],
          [U.n(roll.total) || null, s['money' + band]]
        ]);
      });
    });
    sh.freeze = { x: 2, y: 2 };
    if (n) sh.filter = 'A2:H' + (2 + n);
    return sh;
  }

  function historySheet(rows) {
    var s = S();
    var sh = new (R().Sheet)('History');
    sh.setWidths([18, 30, 19, 10, 12, 12, 24, 26, 26, 30]);
    sh.row([['Change log', s.title]], { ht: 22 });
    sh.row([['Proposal No', s.header], ['Project', s.header], ['When', s.header],
            ['Who', s.header], ['Kind', s.header], ['Document', s.header],
            ['What', s.header], ['From', s.header], ['To', s.header],
            ['Comment', s.header]], { ht: 28 });

    var n = 0;
    function line(b, e, what, from, to) {
      var band = (n++ % 2 === 1) ? 'B' : '';
      sh.row([
        [label(b), s['text' + band]], [b.project || '', s['text' + band]],
        [U.excelStamp(e.at), s['stamp' + band]], [e.by || '', s['text' + band]],
        [e.kind || 'stage', s['text' + band]], [e.doc || '', s['text' + band]],
        [what, s['text' + band]], [from == null ? '' : from, s['text' + band]],
        [to == null ? '' : to, s['text' + band]],
        [e.comment || '', s['text' + band]]
      ]);
    }

    rows.forEach(function (b) {
      root.History.entries(b).forEach(function (e) {
        if (e.kind === 'doc' && e.event) { line(b, e, e.event, '', ''); return; }
        if (e.kind === 'doc') {
          (e.c || []).forEach(function (c) {
            line(b, e, root.History.docLabel(e.doc, c.f), c.a, c.b);
          });
          return;
        }
        if (e.kind === 'edit') {
          (e.changes || []).forEach(function (c) {
            line(b, e, c.label || c.field, c.from, c.to);
          });
          return;
        }
        line(b, e, e.kind === 'created' ? 'Bid created'
          : 'Moved to ' + root.History.label(e.to), e.fromStatus || '', e.toStatus || '');
      });
    });
    sh.freeze = { x: 2, y: 2 };
    if (n) sh.filter = 'A2:J' + (2 + n);
    return sh;
  }

  /* ---- the workbook ------------------------------------------------------ */

  function workbook() {
    var view = root.Bids.currentView();
    var base = root.Bids.baseList();
    var rows = root.BidGrid.visibleRows(base);
    var cols = root.BidGrid.activeColumns().filter(exportable);

    var sheets = [
      summarySheet(rows, view, base.length),
      bidsSheet(rows, cols, view),
      teamSheet(rows),
      bookingsSheet(rows),
      estimateSheet(rows),
      historySheet(rows)
    ];

    /* Belt and braces. Nothing above is named after anything a user typed, so
       these cannot collide - but a workbook that throws rather than exporting
       is exactly the bug this replaced, and the guard costs one line. */
    var taken = {};
    sheets.forEach(function (sh) { sh.name = R().sheetName(sh.name, taken); });

    return { sheets: sheets, rows: rows, view: view, total: base.length };
  }

  function download() {
    if (!root.Report || !root.Zip) {
      U.toast('The workbook writer did not load.', 'err');
      return null;
    }
    var wb = workbook();
    var bytes = R().build(wb.sheets);
    var name = 'DiVerse-' + (VIEW_TITLE[wb.view] || 'Bids').replace(/\s+/g, '-') +
      '-' + U.stampDate(new Date()) + '.xlsx';
    root.Store.downloadBlob(new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), name);
    return wb;
  }

  root.BidsReport = {
    download: download,
    workbook: workbook,
    filterSummary: filterSummary,
    statusStyle: statusStyle,
    cell: cell
  };
})(window);
