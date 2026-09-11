/* assignments.js - who worked a bid, on what, for how long.
 *
 * The active stage keeps its own hours, one row per engineer per task:
 *
 *   bid.assignments = [ { id, engineer, taskType, estHrs, asgnHrs }, ... ]
 *
 * These are deliberately NOT the bid's estHrs/assignedHrs. Those are the
 * first-pass figures put on a bid at intake, on All Bids, and they stay there:
 * a guess made before anyone picked the job up is not the effort the job took.
 * The two stages are separate numbers so neither can quietly become the other.
 *
 * totals() is the only place the sums are worked out - the grid columns, the
 * project card and the XLSX export all read it - so a total cannot drift away
 * from the rows it came from.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  function rows(bid) {
    return (bid && Array.isArray(bid.assignments)) ? bid.assignments : [];
  }

  function bidById(id) {
    return db().bids.filter(function (b) { return b.id === id; })[0] || null;
  }

  function rowById(bid, rowId) {
    return rows(bid).filter(function (r) { return r.id === rowId; })[0] || null;
  }

  /* ---- the day booking --------------------------------------------------- */

  /* A row's hours are booked against dates:
   *
   *   days: [ { date: '2026-07-13', hrs: 5 }, ... ]
   *
   * and `asgnHrs` is their sum. It is still a stored field, because the grid
   * columns, the project card, the totals and the XLSX export all read it and
   * none of them had to change - but it is written by syncRow() and nowhere
   * else, so the total and the days it came from cannot disagree. The same
   * arrangement bid.products has over productLines.
   *
   * Estm Hrs is untouched and still typed: it is the estimate made up front,
   * and the days are the booking made afterwards. They are different facts.
   */
  var DEFAULT_DAYS = 3;

  function dayRows(r) {
    return (r && Array.isArray(r.days)) ? r.days : [];
  }

  function syncRow(r) {
    if (!r) return r;
    r.asgnHrs = dayRows(r).reduce(function (s, d) { return s + U.n(d.hrs); }, 0);
    return r;
  }

  /* Saturday and Sunday are shown, so the strip reads as a calendar, but
     "add a day" steps over them - the next day somebody is expected to work. */
  function isWeekend(iso) {
    var d = U.parseDate(iso);
    if (!d) return false;
    var n = d.getDay();
    return n === 0 || n === 6;
  }

  function addDays(iso, n) {
    var d = U.parseDate(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function nextWorkingDay(iso) {
    var next = addDays(iso, 1);
    var guard = 0;
    while (isWeekend(next) && guard++ < 7) next = addDays(next, 1);
    return next;
  }

  /* The first `count` working days from a start date, weekends skipped. Used to
     lay out a new row and to spread a migrated total. */
  function workingRun(startISO, count) {
    var out = [];
    var day = startISO;
    if (isWeekend(day)) day = nextWorkingDay(addDays(day, -1));
    while (out.length < count) {
      out.push(day);
      day = nextWorkingDay(day);
    }
    return out;
  }

  /* WHEN A ROW STARTS, IF NOBODY HAS SAID.

     The day the task was created: for a row added just now that is today, and
     for one that came in from an older record it is the day the bid was picked
     up - or failing that the day it arrived. createdAt is a moment rather than
     a date, so it is converted through IST rather than sliced, or a bid entered
     after midnight starts its tasks the day before it existed. */
  function defaultStart(bid) {
    var iso = (bid && bid.activatedAt) || U.stampISO(bid && bid.createdAt) || U.today();
    return isWeekend(iso) ? nextWorkingDay(iso) : iso;
  }

  /* A ROW WITH NO DAYS ON IT IS A ROW YOU CANNOT BOOK HOURS TO.

     Every row created since the day booking arrived opens with a start date and
     three working days (see add), and the schema 14 migration gave the existing
     ones the same. But a record can still reach the card without them - one
     synced from a session running the older code, one restored from a backup
     taken before the migration - and it renders as an empty strip with nothing
     but an Add day button: no way in, and no hint that anything is missing.

     So the card fills them in as it draws. Only when something is actually
     absent, and quietly: laying out three empty days is not a change anybody
     made, so it writes no history entry. */
  function ensure(bid) {
    var changed = false;
    rows(bid).forEach(function (r) {
      if (!r.startDate) { r.startDate = defaultStart(bid); changed = true; }
      if (!Array.isArray(r.days) || !r.days.length) {
        r.days = workingRun(r.startDate, DEFAULT_DAYS).map(function (d) {
          return { date: d, hrs: null };
        });
        syncRow(r);
        changed = true;
      }
    });
    if (changed) root.Store.save();
    return bid;
  }

  /* The start date is a text field with a calendar behind it, and both need
     wiring after the card lands in the DOM - the auto-dashing as you type, and
     the validation styling on a date that does not exist. Called by whoever put
     the card on screen. */
  function wire(bid) {
    rows(bid).forEach(function (r) { U.wireDateField('asg-start-' + r.id); });
  }

  /* The one place team hours are added up.
   *
   * Deliberately no combined figure. Estm and Asgn are two measurements of the
   * same work - what it was expected to take, and what was booked to it - so
   * adding them counts the job twice. Each column totals down its own rows and
   * nothing totals across them.
   */
  function totals(bid) {
    var est = 0, asgn = 0;
    rows(bid).forEach(function (r) { est += U.n(r.estHrs); asgn += U.n(r.asgnHrs); });
    return { est: est, asgn: asgn, count: rows(bid).length };
  }

  /* Distinct initials, in the order they were added - one engineer with three
     tasks is one name in the table, not three. */
  function engineerList(bid) {
    var seen = {}, out = [];
    rows(bid).forEach(function (r) {
      var v = String(r.engineer || '').trim();
      if (!v || seen[v.toLowerCase()]) return;
      seen[v.toLowerCase()] = true;
      out.push(v);
    });
    return out;
  }

  /* ---- mutations -------------------------------------------------------- */

  /* RECORDING A CHANGE TO THIS CARD.

     Every mutation ends at save(), but save() runs *after* the record has
     already been altered - so the "before" has to be taken at the top of each
     mutator. begin() does that and save() consumes it. One added line per
     entry point, and a mutation that forgets it writes no entry rather than a
     wrong one.

     The diff is over the whole card at once: Team & Hours summarises itself
     into a single line in History.FIELDS, so adding a row and typing its hours
     reads as one change to the team rather than four. */
  var pending = null;

  function begin(bid) {
    pending = bid ? root.History.snapshot(bid) : null;
  }

  function save(bid) {
    if (pending && bid) {
      root.History.recordEdit(bid, root.History.diff(pending, bid));
    }
    pending = null;
    root.Store.save();
    render(bid);
    if (root.Bids) root.Bids.filterTable();
  }

  function add(bidId) {
    var bid = bidById(bidId);
    if (!bid) return;
    begin(bid);
    if (!Array.isArray(bid.assignments)) bid.assignments = [];
    // The task starts today - the day somebody sat down and assigned it - and
    // opens with three working days to book against. Longer tasks get more via
    // Add day; three is what most of them need and an empty fortnight of
    // columns is worse than a button.
    var start = U.today();
    if (isWeekend(start)) start = nextWorkingDay(start);
    bid.assignments.push(syncRow({
      id: root.Store.uid('asg'), engineer: '', taskType: '', estHrs: 0, asgnHrs: 0,
      startDate: start,
      days: workingRun(start, DEFAULT_DAYS).map(function (d) {
        return { date: d, hrs: null };
      })
    }));
    save(bid);
    // Land the cursor in the row that was just added rather than making the
    // estimator hunt for it.
    var last = bid.assignments[bid.assignments.length - 1];
    var el = U.$('asg-engineer-' + last.id);
    if (el) el.focus();
  }

  function set(bidId, rowId, field, value) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    begin(bid);

    if (field === 'asgnHrs') {
      // Derived from the day cells now - see syncRow. Writing it directly would
      // put the total and the days it is meant to be the sum of into
      // disagreement, with no way to tell which was right.
      pending = null;
      return;
    }
    if (field === 'estHrs') {
      row[field] = U.n(value);
    } else if (field === 'startDate') {
      // Moving the start slides the whole booking, keeping the hours on the
      // same working day of the task: a job pushed back a week is the same
      // plan, later.
      var iso = U.inputToDate(value);
      if (iso === null) { pending = null; render(bid); return; }
      var from = row.startDate;
      row.startDate = iso || from;
      if (iso && from && iso !== from) {
        var run = workingRun(iso, Math.max(dayRows(row).length, 1));
        row.days = dayRows(row).map(function (d, i) {
          return { date: run[i] || d.date, hrs: d.hrs };
        });
      }
    } else if (field === 'engineer') {
      // Normalise so "af" and "AF" are one person rather than two chips in the
      // team cell: the register's spelling if it knows them, upper case if not,
      // since these are initials either way.
      var typed = String(value || '').trim();
      var known = root.Bids.findEngineer(typed);
      row.engineer = known ? known.initials : typed.toUpperCase();
    } else {
      row[field] = String(value == null ? '' : value).trim();
    }
    syncRow(row);
    save(bid);
  }

  /* One day cell. The only way hours get onto a row. */
  function setDay(bidId, rowId, date, hrs) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    begin(bid);
    if (!Array.isArray(row.days)) row.days = [];
    var cell = row.days.filter(function (d) { return d.date === date; })[0];
    var value = hrs === '' || hrs == null ? null : U.n(hrs);
    if (cell) cell.hrs = value;
    else row.days.push({ date: date, hrs: value });
    row.days.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    syncRow(row);
    save(bid);
  }

  /* Another working day on the end of the run. */
  function addDay(bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    begin(bid);
    if (!Array.isArray(row.days)) row.days = [];
    var last = row.days.length
      ? row.days[row.days.length - 1].date
      : (row.startDate || U.today());
    row.days.push({ date: row.days.length ? nextWorkingDay(last) : last, hrs: null });
    syncRow(row);
    save(bid);
  }

  /* And taking the last one off, for a task that turned out shorter. Hours on
     it go with it, which is why it says so when there are any. */
  function removeDay(bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row || !dayRows(row).length) return;
    var last = row.days[row.days.length - 1];
    if (U.n(last.hrs) &&
        !confirm('Remove ' + U.date(last.date) + '?\n\n' +
                 U.qty(U.n(last.hrs)) + ' hrs come off this row.')) return;
    begin(bid);
    row.days.pop();
    syncRow(row);
    save(bid);
  }

  function remove(bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    // Only ask when there is something to lose; confirming an empty row is
    // friction for nothing.
    var hasWork = U.n(row.estHrs) || U.n(row.asgnHrs);
    if (hasWork && !confirm('Remove ' + (row.engineer || 'this row') + '?\n\n' +
      U.n(row.estHrs) + ' estm and ' + U.n(row.asgnHrs) + ' asgn hrs come off this project.')) return;
    // After the confirm, not before: a cancelled removal must not leave a
    // snapshot behind for the next save to diff against.
    begin(bid);
    bid.assignments = rows(bid).filter(function (r) { return r.id !== rowId; });
    save(bid);
  }

  /* A task type added from here goes into the shared list, so it is on the
     Settings page and on every other bid from now on - the same bargain the
     product picker makes on the bid form. */
  function onTaskTypeChange(sel, bidId, rowId) {
    if (sel.value !== '__add') { set(bidId, rowId, 'taskType', sel.value); return; }

    var name = (prompt('Name for the new task type:', '') || '').trim();
    var d = db();
    if (!name) { render(bidById(bidId)); return; }

    var existing = d.taskTypes.filter(function (t) {
      return t.toLowerCase() === name.toLowerCase();
    })[0];
    if (existing) {
      U.toast('"' + existing + '" is already in the list - selected it.', 'warn');
      set(bidId, rowId, 'taskType', existing);
      return;
    }
    d.taskTypes.push(name);
    set(bidId, rowId, 'taskType', name);
    U.toast('"' + name + '" added to the task type list.', 'ok');
  }

  /* Initials the register has never seen are offered as an addition rather than
     silently accepted, so the register stays the list of who works here. */
  function onEngineerBlur(input, bidId, rowId) {
    set(bidId, rowId, 'engineer', input.value);
    var v = input.value.trim();
    if (!v || root.Bids.findEngineer(v)) return;
    if (confirm('"' + v + '" is not in the engineers register.\n\nAdd them?')) {
      root.Bids.addEngineer(v, '');
      root.Bids.populateEngineerList();
      render(bidById(bidId));
    }
  }

  /* ---- the card --------------------------------------------------------- */

  function hoursInput(bidId, r, field, label) {
    return '<input type="number" step="0.5" min="0" value="' + U.escAttr(U.n(r[field])) + '" ' +
      'aria-label="' + U.escAttr(label) + '" ' +
      'oninput="Assign.preview(' + bidId + ')" ' +
      'onchange="Assign.set(' + bidId + ',\'' + r.id + '\',\'' + field + '\',this.value)" ' +
      'id="asg-' + field + '-' + r.id + '" ' +
      'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-sm font-mono text-right ' +
      'outline-none focus:border-brand">';
  }

  function row(bidId, r) {
    var types = db().taskTypes || [];
    // A value that predates the managed list stays selectable on its own row
    // instead of being dropped when the select is rebuilt.
    var known = types.indexOf(r.taskType) >= 0;

    return '<tr class="border-t border-line">' +
      '<td class="py-2 pr-2">' +
        '<input value="' + U.escAttr(r.engineer) + '" list="engineerOptions" autocomplete="off" ' +
          'placeholder="Initials" aria-label="Engineer initials" ' +
          'id="asg-engineer-' + r.id + '" ' +
          'onchange="Assign.onEngineerBlur(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-sm font-semibold ' +
          'uppercase outline-none focus:border-brand">' +
      '</td>' +
      '<td class="py-2 pr-2">' +
        '<select aria-label="Task type" ' +
          'onchange="Assign.onTaskTypeChange(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
          '<option value="">Select task...</option>' +
          (r.taskType && !known
            ? '<option value="' + U.escAttr(r.taskType) + '" selected>' + U.esc(r.taskType) + '</option>'
            : '') +
          types.map(function (t) {
            return '<option value="' + U.escAttr(t) + '"' + (t === r.taskType ? ' selected' : '') + '>' +
              U.esc(t) + '</option>';
          }).join('') +
          '<option value="__add">+ Add new task type...</option>' +
        '</select>' +
      '</td>' +
      '<td class="py-2 pr-2 w-24">' + hoursInput(bidId, r, 'estHrs', 'Estimation hours') + '</td>' +
      // Read-only: this is the sum of the day cells below, and typing over it
      // would put the two into disagreement. See syncRow.
      '<td class="py-2 pr-2 w-24 text-right">' +
        '<span class="font-mono text-sm font-semibold text-ink-strong" ' +
          'id="asg-asgnHrs-' + r.id + '" ' +
          'title="Booked across ' + dayRows(r).length + ' day(s) below">' +
          U.qty(U.n(r.asgnHrs)) + '</span>' +
      '</td>' +
      '<td class="py-2 w-10 text-center">' +
        '<button onclick="Assign.remove(' + bidId + ',\'' + r.id + '\')" title="Remove this row" ' +
          'class="btn-icon w-7 h-7 rounded-lg bg-danger-soft text-danger-ink hover:bg-danger-soft/60 inline-flex items-center justify-center">' +
          '<i class="fas fa-trash text-xs"></i></button>' +
      '</td>' +
    '</tr>' + dayStrip(bidId, r);
  }

  /* THE DAYS THIS ROW IS BOOKED ACROSS.

     A second row under each engineer, spanning the table, holding one small box
     per day. It is where the hours actually go - the Asgn Hrs figure above is
     their total - and it is what the Employee view on Active Bids reads to draw
     the calendar.

     Weekends are shown and shaded rather than hidden, so the strip reads as a
     real week; Add day steps over them. */
  function dayStrip(bidId, r) {
    var days = dayRows(r);
    return '<tr class="border-t border-line/60">' +
      '<td colspan="5" class="pb-3 pt-1 pl-1">' +
        '<div class="flex items-end gap-3 flex-wrap">' +
          '<div>' +
            '<div class="text-3xs font-bold text-faint uppercase tracking-wider mb-1">Starts</div>' +
            U.dateFieldHTML('asg-start-' + r.id, r.startDate,
              'w-32 px-2 py-1 bg-surface border border-line rounded text-xs outline-none focus:border-brand',
              'Assign.set(' + bidId + ',&quot;' + r.id + '&quot;,&quot;startDate&quot;,this.value)') +
          '</div>' +
          '<div class="flex items-end gap-1 flex-wrap">' +
            days.map(function (d) { return dayCell(bidId, r, d); }).join('') +
            '<button onclick="Assign.addDay(' + bidId + ',\'' + r.id + '\')" ' +
              'title="Book another working day" ' +
              'class="w-9 h-[30px] mb-px rounded border border-dashed border-line-strong ' +
              'text-faint hover:text-brand hover:border-brand text-xs">' +
              '<i class="fas fa-plus text-3xs"></i></button>' +
            (days.length > 1
              ? '<button onclick="Assign.removeDay(' + bidId + ',\'' + r.id + '\')" ' +
                'title="Drop the last day" ' +
                'class="w-6 h-[30px] mb-px text-faint hover:text-danger text-xs">' +
                '<i class="fas fa-minus text-3xs"></i></button>'
              : '') +
          '</div>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  function dayCell(bidId, r, d) {
    var weekend = isWeekend(d.date);
    var dt = U.parseDate(d.date);
    var dow = dt ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : '';
    var dom = dt ? String(dt.getDate()) : '';
    return '<label class="block text-center" title="' + U.escAttr(U.date(d.date)) + '">' +
      '<span class="block text-3xs uppercase tracking-wider ' +
        (weekend ? 'text-faint' : 'text-muted') + '">' + dow + '</span>' +
      '<span class="block text-3xs ' + (weekend ? 'text-faint' : 'text-muted') + ' mb-0.5">' +
        dom + '</span>' +
      '<input type="number" step="0.5" min="0" ' +
        'value="' + (d.hrs == null ? '' : U.escAttr(d.hrs)) + '" ' +
        'aria-label="Hours on ' + U.escAttr(U.date(d.date)) + '" ' +
        'oninput="Assign.preview(' + bidId + ')" ' +
        'onchange="Assign.setDay(' + bidId + ',\'' + r.id + '\',\'' + d.date + '\',this.value)" ' +
        'id="asg-day-' + r.id + '-' + d.date + '" ' +
        'class="w-11 px-1 py-1 border rounded text-xs font-mono text-center outline-none ' +
        'focus:border-brand ' +
        (weekend ? 'bg-raised border-line text-muted' : 'bg-surface border-line') + '">' +
    '</label>';
  }

  function footer(bid) {
    var t = totals(bid);
    return '<tr class="border-t-2 border-line bg-raised/60">' +
      '<td colspan="2" class="py-2.5 pr-2 text-xs font-semibold text-muted uppercase tracking-wider">' +
        (t.count ? t.count + ' row' + (t.count > 1 ? 's' : '') +
          ' &middot; ' + engineerList(bid).length + ' engineer' + (engineerList(bid).length === 1 ? '' : 's')
        : '') + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-ink-strong" id="asgTotalEst">' +
        U.qty(t.est) + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-ink-strong" id="asgTotalAsgn">' +
        U.qty(t.asgn) + '</td>' +
      '<td class="py-2.5 text-center text-3xs text-faint">hrs</td>' +
    '</tr>';
  }

  function card(bid) {
    ensure(bid);
    var body = rows(bid).length
      ? '<div class="overflow-x-auto"><table class="w-full text-sm">' +
          '<thead><tr class="text-3xs font-bold text-faint uppercase tracking-wider text-left">' +
            '<th class="pb-2 pr-2 w-28">Engineer</th>' +
            '<th class="pb-2 pr-2">Description</th>' +
            '<th class="pb-2 pr-2 text-right">Estm Hrs</th>' +
            '<th class="pb-2 pr-2 text-right">Asgn Hrs</th>' +
            '<th class="pb-2"></th>' +
          '</tr></thead><tbody>' +
          rows(bid).map(function (r) { return row(bid.id, r); }).join('') +
          footer(bid) +
          '</tbody></table></div>'
      : '<div class="text-center py-8">' +
          '<div class="w-12 h-12 bg-neutral-soft rounded-xl flex items-center justify-center mx-auto mb-3">' +
            '<i class="fas fa-user-clock text-faint"></i></div>' +
          '<p class="text-sm text-muted max-w-sm mx-auto">Nobody booked to this project yet. ' +
          'Add a row per engineer and task &mdash; the hours on the bids table come from these rows.</p>' +
        '</div>';

    return '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden" id="assignCard">' +
      '<div class="px-5 py-3 border-b border-line bg-raised flex items-center justify-between gap-3">' +
        '<h3 class="text-sm font-bold text-ink flex items-center gap-2">' +
          '<i class="fas fa-users text-faint"></i>Team &amp; Hours' +
        '</h3>' +
        '<button onclick="Assign.add(' + bid.id + ')" ' +
          'class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-plus"></i>Add engineer</button>' +
      '</div>' +
      '<div class="p-5">' + body + '</div></div>';
  }

  /* Repaint just this card. The project page owns the host, so re-rendering the
     whole page from here would fight it for the DOM. */
  function render(bid) {
    var host = U.$('assignCard');
    if (!host || !bid) return;
    host.outerHTML = card(bid);
    wire(bid);
    if (root.Bids) root.Bids.populateEngineerList();
  }

  /* Totals follow the keystrokes rather than waiting for the change event, so
     the arithmetic is visibly live while you type. Reads the inputs, not the
     record, because the record has not been written yet. */
  function preview(bidId) {
    var bid = bidById(bidId);
    if (!bid) return;
    var est = 0, asgn = 0;
    rows(bid).forEach(function (r) {
      var e = U.$('asg-estHrs-' + r.id);
      est += U.n(e ? e.value : r.estHrs);
      // The row's assigned figure is the sum of its day boxes, so it is read
      // from those rather than from a field of its own - and the row's own
      // total is repainted on the way past, since it is derived too.
      var rowAsgn = 0;
      dayRows(r).forEach(function (d) {
        var cell = U.$('asg-day-' + r.id + '-' + d.date);
        rowAsgn += U.n(cell ? cell.value : d.hrs);
      });
      var a = U.$('asg-asgnHrs-' + r.id);
      if (a) a.textContent = U.qty(rowAsgn);
      asgn += rowAsgn;
    });
    var te = U.$('asgTotalEst'), ta = U.$('asgTotalAsgn');
    if (te) te.textContent = U.qty(est);
    if (ta) ta.textContent = U.qty(asgn);
  }

  root.Assign = {
    rows: rows,
    totals: totals,
    engineerList: engineerList,
    card: card,
    render: render,
    wire: wire,
    defaultStart: defaultStart,
    preview: preview,
    add: add,
    set: set,
    remove: remove,

    /* The day booking. asgnHrs is their sum and is never written directly. */
    dayRows: dayRows,
    setDay: setDay,
    addDay: addDay,
    removeDay: removeDay,
    syncRow: syncRow,
    isWeekend: isWeekend,
    nextWorkingDay: nextWorkingDay,
    workingRun: workingRun,
    onTaskTypeChange: onTaskTypeChange,
    onEngineerBlur: onEngineerBlur,

    /* Carries a task type rename onto every row that used it - see the same
       rule for engineer initials in Bids.updateEngineer. */
    renameTaskType: function (from, to) {
      var n = 0;
      db().bids.forEach(function (b) {
        rows(b).forEach(function (r) {
          if (r.taskType === from) { r.taskType = to; n++; }
        });
      });
      return n;
    },
    countTaskType: function (name) {
      var n = 0;
      db().bids.forEach(function (b) {
        rows(b).forEach(function (r) { if (r.taskType === name) n++; });
      });
      return n;
    }
  };
})(window);
