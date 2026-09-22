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

  /* Which rows have their empty days showing, by row id.
   *
   * A view state and nothing else: it is about what this person has open on
   * this screen right now, not about the booking. So it lives here and never
   * goes near Store.save - writing it to the record would broadcast "AF opened
   * a row" to every browser in the office as a change to the bid. */
  var expanded = {};

  /* The day most recently added by hand, per row.
   *
   * It has no hours on it yet - that is the point of having just added it - so
   * the fold would hide it the instant it was created, which reads as the
   * button doing nothing. It stays visible until something else happens on that
   * row: typing hours into it (the usual next move), or folding the strip by
   * hand. Same shape as `expanded`, and equally not part of the record. */
  var justAdded = {};

  /* ---- is this task finished -------------------------------------------- */

  /* WHERE A TASK IS UP TO, PER PERSON.
   *
   * The bid already has a status, but that is the bid's - one word for work
   * that three people are doing three parts of. "Is the takeoff done" and "has
   * anybody started estimating" were questions you could only answer by asking
   * the person, which is what this replaces.
   *
   * Three values and no more. A percentage invites arguing about whether
   * something is 60 or 70 done; started/not started/finished is what a
   * standup actually needs, and it rolls up into a count anybody can read.
   *
   * Stored as the key, not the label, so renaming what it says on screen does
   * not rewrite every record. `tone` is the badge colouring, matching the bid
   * statuses in js/bids.js so the same three ideas look the same everywhere.
   */
  var STATUS = {
    todo:    { label: 'Not started', order: 0, cls: 'bg-neutral-soft text-neutral-ink' },
    doing:   { label: 'In progress', order: 1, cls: 'bg-warn-soft text-warn-ink' },
    done:    { label: 'Done',        order: 2, cls: 'bg-ok-soft text-ok-ink' }
  };

  var STATUS_KEYS = ['todo', 'doing', 'done'];

  function statusOf(r) {
    return STATUS[r && r.status] ? r.status : 'todo';
  }

  function isDone(r) { return statusOf(r) === 'done'; }

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
      // A row from before completion was tracked is Not started, which is the
      // only honest reading: nobody said it was done.
      if (!STATUS[r.status]) { r.status = 'todo'; changed = true; }
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
    var est = 0, asgn = 0, done = 0;
    rows(bid).forEach(function (r) {
      est += U.n(r.estHrs);
      asgn += U.n(r.asgnHrs);
      if (isDone(r)) done++;
    });
    return { est: est, asgn: asgn, count: rows(bid).length, done: done };
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
      status: 'todo', completedAt: '',
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
    } else if (field === 'status') {
      /* The completion date is stamped by moving the row to Done and cleared by
         moving it back, rather than being a fourth thing to type. Re-selecting
         Done on a row that is already done leaves the original date alone: the
         task finished when it finished, not when somebody clicked the menu
         again. */
      var next = STATUS[value] ? value : 'todo';
      var was = statusOf(row);
      row.status = next;
      if (next === 'done' && was !== 'done') row.completedAt = U.today();
      if (next !== 'done') row.completedAt = '';
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
    // Whatever was added last has now been answered, one way or the other.
    delete justAdded[rowId];
    if (cell) cell.hrs = value;
    else row.days.push({ date: date, hrs: value });
    row.days.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    syncRow(row);
    save(bid);
  }

  /* Another day on the row.
   *
   * With no date, the next working day after the last one - which is what the
   * keyboard path and every existing caller expect. With one, that day exactly:
   * the picker offers the next few and the calendar reaches anything further
   * out, and neither should have to step through the days in between. */
  function addDay(bidId, rowId, iso) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    if (!Array.isArray(row.days)) row.days = [];

    var date;
    if (iso) {
      date = String(iso);
      if (row.days.some(function (d) { return d.date === date; })) {
        U.toast(U.date(date) + ' is already on this row.', 'warn');
        return;
      }
    } else {
      var last = row.days.length
        ? row.days[row.days.length - 1].date
        : (row.startDate || U.today());
      date = row.days.length ? nextWorkingDay(last) : last;
    }

    begin(bid);
    row.days.push({ date: date, hrs: null });
    row.days.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    /* A day booked before the start IS the new start. Written directly rather
       than through set(), which slides the whole booking to keep its shape -
       here the shape is what just changed. */
    if (!row.startDate || date < row.startDate) row.startDate = date;
    // A day added by hand is one somebody is about to fill in, so it stays on
    // screen until they do - otherwise the fold hides the box they just asked
    // for. The rest of the empties stay folded.
    justAdded[row.id] = date;
    syncRow(row);
    save(bid);
  }

  /* And taking the last one off, for a task that turned out shorter. Hours on
     it go with it, which is why it says so when there are any. */
  function removeDay(bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row || !dayRows(row).length) return;
    removeDayAt(bidId, rowId, row.days[row.days.length - 1].date);
  }

  /* One named day, from the × on its own box. */
  function removeDayAt(bidId, rowId, date) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row || !dayRows(row).length) return;
    var cell = row.days.filter(function (d) { return d.date === date; })[0];
    if (!cell) return;
    if (U.n(cell.hrs) &&
        !confirm('Remove ' + U.date(cell.date) + '?\n\n' +
                 U.qty(U.n(cell.hrs)) + ' hrs come off this row.')) return;
    begin(bid);
    row.days = row.days.filter(function (d) { return d.date !== date; });
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

  /* WHERE THIS PERSON'S TASK IS UP TO.

     A select rather than a checkbox, because "started but not finished" is the
     state most rows are actually in and a tick cannot say it. It is coloured
     like the value it holds - the same three tones the bid statuses use - so a
     card of six rows reads at a glance instead of needing each one opened.

     The completion date sits under it rather than beside it: it is only there
     on a finished row, and giving it a column of its own would leave four out
     of five rows showing an empty cell. */
  function statusCell(bidId, r) {
    var key = statusOf(r);
    var s = STATUS[key];
    return '<select aria-label="Task status" ' +
        'onchange="Assign.set(' + bidId + ',\'' + r.id + '\',\'status\',this.value)" ' +
        'class="w-full px-2 py-1.5 border border-line rounded text-xs font-semibold ' +
        'outline-none focus:border-brand ' + s.cls + '">' +
        STATUS_KEYS.map(function (k) {
          return '<option value="' + k + '"' + (k === key ? ' selected' : '') + '>' +
            U.esc(STATUS[k].label) + '</option>';
        }).join('') +
      '</select>' +
      (key === 'done' && r.completedAt
        ? '<div class="text-3xs text-muted mt-0.5 whitespace-nowrap" title="Completed">' +
          '<i class="fas fa-check text-ok mr-0.5"></i>' + U.esc(U.date(r.completedAt)) + '</div>'
        : '');
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
      '<td class="py-2 pr-2 w-32">' + statusCell(bidId, r) + '</td>' +
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
    var booked = days.filter(function (d) { return U.n(d.hrs) > 0; });
    /* WHAT A SAVED ROW SHOWS: THE DAYS SOMEBODY WORKED.
     *
     * Every booked day used to be a box whether or not anything went in it, so
     * a three-week task was twenty boxes of which five had numbers and the rest
     * were noise - and nothing on screen told the two apart.
     *
     * So the empties fold away behind a count, which opens them again. Two
     * exceptions, both of them about not leaving somebody with nowhere to type:
     * a row with nothing booked yet shows all of its days (that is every new
     * row), and a row somebody has opened stays open until they close it. */
    var open = expanded[r.id] || !booked.length;
    var shown = open ? days : days.filter(function (d) {
      return U.n(d.hrs) > 0 || d.date === justAdded[r.id];
    });
    var hidden = days.length - shown.length;

    return '<tr class="border-t border-line/60">' +
      '<td colspan="6" class="pb-3 pt-1 pl-1">' +
        '<div class="flex items-end gap-3 flex-wrap">' +
          '<div>' +
            '<div class="text-3xs font-bold text-faint uppercase tracking-wider mb-1">Starts</div>' +
            U.dateFieldHTML('asg-start-' + r.id, r.startDate,
              'w-32 px-2 py-1 bg-surface border border-line rounded text-xs outline-none focus:border-brand',
              'Assign.set(' + bidId + ',&quot;' + r.id + '&quot;,&quot;startDate&quot;,this.value)') +
          '</div>' +
          '<div class="flex items-end gap-1 flex-wrap">' +
            shown.map(function (d) { return dayCell(bidId, r, d); }).join('') +
            (hidden
              ? '<button onclick="Assign.toggleEmpty(' + bidId + ',\'' + r.id + '\')" ' +
                'title="' + U.escAttr(hidden + ' booked day(s) with no hours on them yet') + '" ' +
                'class="h-[30px] mb-px px-2 rounded border border-dashed border-line-strong ' +
                'text-3xs font-semibold text-faint hover:text-brand hover:border-brand">' +
                '+' + hidden + ' empty</button>'
              : '') +
            (open && days.length > booked.length && booked.length
              ? '<button onclick="Assign.toggleEmpty(' + bidId + ',\'' + r.id + '\')" ' +
                'title="Show only the days with hours on them" ' +
                'class="h-[30px] mb-px px-2 rounded text-3xs font-semibold text-faint hover:text-ink">' +
                'Hide empty</button>'
              : '') +
            '<button id="asg-addday-' + r.id + '" ' +
              'onclick="Assign.openDayPicker(this,' + bidId + ',\'' + r.id + '\')" ' +
              'title="Book another day" ' +
              'class="w-9 h-[30px] mb-px rounded border border-dashed border-line-strong ' +
              'text-faint hover:text-brand hover:border-brand text-xs">' +
              '<i class="fas fa-plus text-3xs"></i></button>' +
          '</div>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  /* WHICH DAY TO BOOK NEXT, OFFERED RATHER THAN GUESSED.
   *
   * The + used to append the next working day and nothing else, so a task
   * starting a fortnight out was ten clicks and ten boxes to delete
   * afterwards. It opens a short list instead: the next few working days, and
   * the calendar for anything past them.
   *
   * Five, because that is a working week - far enough to cover "some time next
   * week" without becoming a second calendar to read. */
  var PICK_AHEAD = 5;

  function nextWorkingDays(r, count) {
    var days = dayRows(r);
    var from = days.length ? days[days.length - 1].date : (r.startDate || U.today());
    var out = [];
    var day = from;
    while (out.length < count) {
      day = nextWorkingDay(day);
      out.push(day);
    }
    return out;
  }

  function dayPickerHTML(bidId, r) {
    var have = {};
    dayRows(r).forEach(function (d) { have[d.date] = true; });

    return '<div class="w-48">' +
      '<div class="px-2 pt-1 pb-1.5 text-3xs font-bold text-muted uppercase tracking-wider">' +
        'Book a day</div>' +
      nextWorkingDays(r, PICK_AHEAD).map(function (iso) {
        var dt = U.parseDate(iso);
        var label = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] + ' ' +
          dt.getDate() + ' ' +
          ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()];
        // A day already on the row is shown greyed rather than left out, so the
        // list does not quietly renumber itself between two openings.
        if (have[iso]) {
          return '<div class="px-2 py-1.5 text-xs text-faint flex items-center justify-between">' +
            U.esc(label) + '<span class="text-3xs">booked</span></div>';
        }
        // Closes first: the row re-renders underneath, and a panel left hanging
        // over it would be pointing at boxes that have been replaced.
        return '<button onclick="UI.closePopover();Assign.addDay(' + bidId + ',\'' + r.id +
            '\',\'' + iso + '\')" ' +
          'class="w-full text-left px-2 py-1.5 rounded text-xs text-ink hover:bg-raised">' +
          U.esc(label) + '</button>';
      }).join('') +
      '<div class="border-t border-line mt-1 pt-1">' +
        '<button onclick="Assign.pickDayFromCalendar(' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full text-left px-2 py-1.5 rounded text-xs text-brand hover:bg-raised">' +
          '<i class="fas fa-calendar-days mr-1.5"></i>Pick a date...</button>' +
      '</div></div>';
  }

  /* HOW MUCH OF THIS PERSON'S DAY IS LEFT, under the box you book into.
   *
   * The figure that decides whether somebody can take this work, and until now
   * the only way to get it was to open every other active bid and add up. It is
   * their shift length minus everything they have booked that day ACROSS THE
   * WHOLE DATABASE - the hours that fill someone's Friday are usually on a
   * project you are not looking at, so counting only this bid would produce a
   * confident wrong answer, which is worse than none.
   *
   * Blank on a row with nobody on it: hours remaining for nobody is not a
   * number, and a 9 sitting under an empty engineer box reads as a promise.
   *
   * The id is what preview() repaints through while somebody is typing - see
   * there - so the figure moves with the keystrokes rather than waiting for the
   * change event.
   */
  function remainingCell(r, d) {
    if (!String(r.engineer || '').trim()) {
      return '<span class="block h-3 mt-0.5" id="asg-left-' + r.id + '-' + d.date + '"></span>';
    }
    return '<span class="block text-3xs mt-0.5 font-mono leading-none ' +
      'whitespace-nowrap ' + remainingClass(r.engineer, d.date) + '" ' +
      'id="asg-left-' + r.id + '-' + d.date + '" ' +
      'title="' + U.escAttr(remainingTitle(r.engineer, d.date)) + '">' +
      remainingText(r.engineer, d.date) + '</span>';
  }

  function remainingText(engineer, iso) {
    var left = root.Schedule.remainingFor(engineer, iso);
    if (left == null) return '';
    return left < 0 ? '+' + U.qty(-left) + ' over' : U.qty(left) + ' left';
  }

  function remainingClass(engineer, iso) {
    var left = root.Schedule.remainingFor(engineer, iso);
    if (left == null) return 'text-faint';
    if (left < 0) return 'text-danger font-bold';
    if (left === 0) return 'text-faint';
    return 'text-ok-ink';
  }

  /* The arithmetic, spelled out. Without it a "0 left" sitting under a box
     showing 4.5 looks like a bug - the missing half is on another project, and
     this is the only place that can say so. */
  function remainingTitle(engineer, iso) {
    var shift = root.Schedule.dayHoursFor(engineer);
    var booked = root.Schedule.bookedFor(engineer, iso);
    var n = root.Schedule.projectsOn(engineer, iso);
    var left = shift - booked;
    return engineer + ' on ' + U.date(iso) + ': ' +
      U.qty(shift) + ' hr day, ' + U.qty(booked) + ' booked' +
      (n > 1 ? ' across ' + n + ' projects' : n === 1 ? ' on 1 project' : '') + ', ' +
      (left < 0 ? U.qty(-left) + ' over' : U.qty(left) + ' left') + '.';
  }

  function dayCell(bidId, r, d) {
    var weekend = isWeekend(d.date);
    var dt = U.parseDate(d.date);
    var dow = dt ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : '';
    var dom = dt ? String(dt.getDate()) : '';
    /* Each day carries its own delete, on hover - the same arrangement the
       takeoff's grid columns use. It replaced a "drop the last day" button at
       the end of the strip, which stopped making sense once the last day can be
       one of the hidden empties. */
    return '<label class="group/day block text-center relative" title="' +
        U.escAttr(U.date(d.date)) + '">' +
      '<button onclick="event.preventDefault();Assign.removeDayAt(' + bidId + ',\'' + r.id +
          '\',\'' + d.date + '\')" ' +
        'title="Remove this day" tabindex="-1" ' +
        'class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface border border-line ' +
        'text-3xs text-faint hover:text-danger hover:border-danger leading-none ' +
        'opacity-0 group-hover/day:opacity-100 transition">&times;</button>' +
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
      remainingCell(r, d) +
    '</label>';
  }

  function footer(bid) {
    var t = totals(bid);
    return '<tr class="border-t-2 border-line bg-raised/60">' +
      '<td colspan="2" class="py-2.5 pr-2 text-xs font-semibold text-muted uppercase tracking-wider">' +
        (t.count ? t.count + ' row' + (t.count > 1 ? 's' : '') +
          ' &middot; ' + engineerList(bid).length + ' engineer' + (engineerList(bid).length === 1 ? '' : 's')
        : '') + '</td>' +
      // The completion count sits under the column it counts, which is what
      // makes it read as a total of that column rather than a stray figure.
      '<td class="py-2.5 pr-2 text-xs font-semibold ' +
        (t.count && t.done === t.count ? 'text-ok-ink' : 'text-muted') + '">' +
        (t.count ? t.done + ' of ' + t.count + ' done' : '') + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-ink-strong" id="asgTotalEst">' +
        U.qty(t.est) + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-ink-strong" id="asgTotalAsgn">' +
        U.qty(t.asgn) + '</td>' +
      '<td class="py-2.5 text-center text-3xs text-faint">hrs</td>' +
    '</tr>';
  }

  /* How much of the team's work is finished, on the card header - so the answer
     is there before the card is read, and still there when it is collapsed into
     a screenshot. Absent on a card with no rows, where 0 of 0 would be noise. */
  function progressPill(bid) {
    var t = totals(bid);
    if (!t.count) return '';
    var all = t.done === t.count;
    return '<span class="px-2 py-0.5 rounded-full text-3xs font-semibold ' +
      (all ? 'bg-ok-soft text-ok-ink' : 'bg-neutral-soft text-muted') + '" ' +
      'title="Tasks marked done on this project">' +
      (all ? '<i class="fas fa-check mr-1"></i>' : '') +
      t.done + '/' + t.count + ' done</span>';
  }

  function card(bid) {
    ensure(bid);
    var body = rows(bid).length
      ? '<div class="overflow-x-auto"><table class="w-full text-sm">' +
          '<thead><tr class="text-3xs font-bold text-faint uppercase tracking-wider text-left">' +
            '<th class="pb-2 pr-2 w-28">Engineer</th>' +
            '<th class="pb-2 pr-2">Description</th>' +
            '<th class="pb-2 pr-2 w-32">Status</th>' +
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
          progressPill(bid) +
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
        previewRemaining(r, d, cell);
      });
      var a = U.$('asg-asgnHrs-' + r.id);
      if (a) a.textContent = U.qty(rowAsgn);
      asgn += rowAsgn;
    });
    var te = U.$('asgTotalEst'), ta = U.$('asgTotalAsgn');
    if (te) te.textContent = U.qty(est);
    if (ta) ta.textContent = U.qty(asgn);
  }

  /* The hours-left figure, moved to match what is in the box right now.
   *
   * The stored index still holds the SAVED hours for this cell, so typing 6
   * over a saved 4 has to swap one for the other rather than add: take what is
   * booked everywhere, remove this cell's saved contribution, add what is
   * typed. Anything booked on another project stays in the figure, which is the
   * whole point of it. */
  function previewRemaining(r, d, cell) {
    var host = U.$('asg-left-' + r.id + '-' + d.date);
    if (!host) return;
    var engineer = String(r.engineer || '').trim();
    if (!engineer) { host.textContent = ''; host.className = 'block h-3 mt-0.5'; return; }

    var typed = U.n(cell ? cell.value : d.hrs);
    var left = root.Schedule.dayHoursFor(engineer) -
      (root.Schedule.bookedFor(engineer, d.date) - U.n(d.hrs) + typed);

    host.textContent = left < 0 ? '+' + U.qty(-left) + ' over' : U.qty(left) + ' left';
    host.className = 'block text-3xs mt-0.5 font-mono leading-none whitespace-nowrap ' +
      (left < 0 ? 'text-danger font-bold' : left === 0 ? 'text-faint' : 'text-ok-ink');
  }

  root.Assign = {
    rows: rows,
    totals: totals,
    engineerList: engineerList,

    /* Completion, for the callers outside this card: the bids table marks a
       finished engineer's chip, the change log names the state, and the
       workbook export carries both columns. */
    STATUS: STATUS,
    statusOf: statusOf,
    isDone: isDone,
    statusLabel: function (r) { return STATUS[statusOf(r)].label; },
    /* Every row this person has on this bid is finished. One engineer can hold
       two tasks, and a chip must not say done while half their work is open. */
    engineerDone: function (bid, initials) {
      var mine = rows(bid).filter(function (r) {
        return U.low(r.engineer) === U.low(initials);
      });
      return mine.length > 0 && mine.every(isDone);
    },
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
    removeDayAt: removeDayAt,

    /* Show or fold this row's days with nothing booked to them. */
    toggleEmpty: function (bidId, rowId) {
      expanded[rowId] = !expanded[rowId];
      // Folding by hand is an explicit "I am done with these", including the
      // one just added.
      delete justAdded[rowId];
      render(bidById(bidId));
    },

    /* The next few working days, and a way to reach any other one. */
    openDayPicker: function (anchor, bidId, rowId) {
      var row = rowById(bidById(bidId), rowId);
      if (!row) return;
      root.UI.popover(anchor, dayPickerHTML(bidId, row), { cls: 'p-1' });
    },

    pickDayFromCalendar: function (bidId, rowId) {
      var row = rowById(bidById(bidId), rowId);
      if (!row) return;
      var anchor = U.$('asg-addday-' + rowId);
      if (!anchor) return;
      var days = dayRows(row);
      U.openDatePicker(anchor, {
        // Opens on the month the booking is in rather than on this one, which
        // is where the next day to book almost always is.
        value: days.length ? days[days.length - 1].date : (row.startDate || U.today()),
        onPick: function (iso) {
          root.UI.closePopover();
          if (iso) addDay(bidId, rowId, iso);
        }
      });
    },
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
