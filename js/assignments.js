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

  function save(bid) {
    root.Store.save();
    render(bid);
    if (root.Bids) root.Bids.filterTable();
  }

  function add(bidId) {
    var bid = bidById(bidId);
    if (!bid) return;
    if (!Array.isArray(bid.assignments)) bid.assignments = [];
    bid.assignments.push({
      id: root.Store.uid('asg'), engineer: '', taskType: '', estHrs: 0, asgnHrs: 0
    });
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

    if (field === 'estHrs' || field === 'asgnHrs') {
      row[field] = U.n(value);
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
      'class="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-sm font-mono text-right ' +
      'outline-none focus:border-blue-400">';
  }

  function row(bidId, r) {
    var types = db().taskTypes || [];
    // A value that predates the managed list stays selectable on its own row
    // instead of being dropped when the select is rebuilt.
    var known = types.indexOf(r.taskType) >= 0;

    return '<tr class="border-t border-slate-100">' +
      '<td class="py-2 pr-2">' +
        '<input value="' + U.escAttr(r.engineer) + '" list="engineerOptions" autocomplete="off" ' +
          'placeholder="Initials" aria-label="Engineer initials" ' +
          'id="asg-engineer-' + r.id + '" ' +
          'onchange="Assign.onEngineerBlur(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-sm font-semibold ' +
          'uppercase outline-none focus:border-blue-400">' +
      '</td>' +
      '<td class="py-2 pr-2">' +
        '<select aria-label="Task type" ' +
          'onchange="Assign.onTaskTypeChange(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-sm outline-none focus:border-blue-400">' +
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
      '<td class="py-2 pr-2 w-24">' + hoursInput(bidId, r, 'asgnHrs', 'Assigned hours') + '</td>' +
      '<td class="py-2 w-10 text-center">' +
        '<button onclick="Assign.remove(' + bidId + ',\'' + r.id + '\')" title="Remove this row" ' +
          'class="btn-icon w-7 h-7 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 inline-flex items-center justify-center">' +
          '<i class="fas fa-trash text-xs"></i></button>' +
      '</td>' +
    '</tr>';
  }

  function footer(bid) {
    var t = totals(bid);
    return '<tr class="border-t-2 border-slate-200 bg-slate-50/60">' +
      '<td colspan="2" class="py-2.5 pr-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">' +
        (t.count ? t.count + ' row' + (t.count > 1 ? 's' : '') +
          ' &middot; ' + engineerList(bid).length + ' engineer' + (engineerList(bid).length === 1 ? '' : 's')
        : '') + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-slate-800" id="asgTotalEst">' +
        U.qty(t.est) + '</td>' +
      '<td class="py-2.5 pr-2 text-right font-mono text-sm font-bold text-slate-800" id="asgTotalAsgn">' +
        U.qty(t.asgn) + '</td>' +
      '<td class="py-2.5 text-center text-[10px] text-slate-400">hrs</td>' +
    '</tr>';
  }

  function card(bid) {
    var body = rows(bid).length
      ? '<div class="overflow-x-auto"><table class="w-full text-sm">' +
          '<thead><tr class="text-[10px] font-bold text-slate-400 uppercase tracking-wider text-left">' +
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
          '<div class="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mx-auto mb-3">' +
            '<i class="fas fa-user-clock text-slate-400"></i></div>' +
          '<p class="text-sm text-slate-500 max-w-sm mx-auto">Nobody booked to this project yet. ' +
          'Add a row per engineer and task &mdash; the hours on the bids table come from these rows.</p>' +
        '</div>';

    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden" id="assignCard">' +
      '<div class="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">' +
        '<h3 class="text-sm font-bold text-slate-700 flex items-center gap-2">' +
          '<i class="fas fa-users text-slate-400"></i>Team &amp; Hours' +
        '</h3>' +
        '<button onclick="Assign.add(' + bid.id + ')" ' +
          'class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
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
      var e = U.$('asg-estHrs-' + r.id), a = U.$('asg-asgnHrs-' + r.id);
      est += U.n(e ? e.value : r.estHrs);
      asgn += U.n(a ? a.value : r.asgnHrs);
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
    preview: preview,
    add: add,
    set: set,
    remove: remove,
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
