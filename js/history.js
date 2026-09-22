/* history.js - how a bid got to where it is.
 *
 *   bid.history = [ { id, at, by, from, to, fromStatus, toStatus, comment }, ... ]
 *
 * A bid moves All Bids -> Active Bids -> Awarded (or Lost), and until now
 * nothing recorded that it had: the record showed where a bid was, never how it
 * got there, who moved it or why. When an award is rescinded three weeks later
 * that is exactly the question everybody asks.
 *
 * Two things follow from keeping the log:
 *
 *   REVERSING IS POSSIBLE. A stage can be undone because the entry that made it
 *   says what the bid looked like before - fromStatus - so putting it back is
 *   restoring a recorded state rather than guessing at one.
 *
 *   THE NUMBER NEVER MOVES. Whatever the stage does, bid.proposalNo stays. It
 *   was issued when the bid was picked up and it is on paper; a bid that goes
 *   back to intake and forward again is the same project, not a new one.
 *
 * Every entry is kept, including the ones recording a reversal. Deleting one is
 * behind bid.history.delete and is itself recorded, so the trail cannot be
 * quietly emptied - only visibly pruned.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  /* The four places a bid can be. Keys are stored; labels are shown. */
  var STAGES = {
    intake:  { label: 'All Bids', icon: 'fa-inbox', tint: 'text-muted' },
    active:  { label: 'Active Bids', icon: 'fa-bolt', tint: 'text-brand' },
    awarded: { label: 'Awarded', icon: 'fa-trophy', tint: 'text-ok' },
    lost:    { label: 'Lost', icon: 'fa-xmark', tint: 'text-danger' },
    /* NOT A PLACE A BID CAN BE - which is why stageOf never returns it. It is
       a thing that happened TO a finished bid: the client brought the job back
       and a fresh revision entry opened beside this one. The bid itself has not
       moved, and it is not going to. */
    reopened: { label: 'Re-opened', icon: 'fa-rotate-right', tint: 'text-warn-ink' }
  };

  function label(key) {
    return (STAGES[key] && STAGES[key].label) || key || 'unknown';
  }

  /* Where a bid is now, derived from the record rather than stored - so it can
     never disagree with the status and the active flag it is derived from. */
  function stageOf(bid) {
    if (!bid) return 'intake';
    if (bid.status === 'Awarded') return 'awarded';
    if (bid.status === 'Lost') return 'lost';
    if (bid.active && root.Bids.onActiveOf(bid)) return 'active';
    return 'intake';
  }

  function entries(bid) {
    return (bid && Array.isArray(bid.history)) ? bid.history : [];
  }

  /* Who is doing this. Empty on the single-user path, where there is nobody to
     be and attributing the move to a name would be an invention. */
  function actor() {
    var u = root.Auth && root.Auth.user;
    if (!u) return '';
    return u.initials || u.name || u.username || '';
  }

  /* ---- what a change to a bid looks like --------------------------------- */

  /* THE FIELDS WORTH RECORDING, and what to call them to somebody reading the
     log later. A whitelist rather than "diff everything": most of a bid record
     is derived, internal, or the log itself, and an entry saying `month: 5 -> 6`
     is noise that buries the entry saying the price moved by forty thousand.

     `fmt` turns a stored value into what the log should say. Without it a due
     date reads as 2026-07-22 in a log that shows 07-22-2026 everywhere else. */
  var FIELDS = [
    { key: 'project',        label: 'Project' },
    { key: 'proposalNo',     label: 'Proposal No.' },
    { key: 'status',         label: 'Status' },
    { key: 'dueDate',        label: 'Due Date',      fmt: function (v) { return v ? U.date(v) : ''; } },
    { key: 'revisedDueDate', label: 'Revised Due',   fmt: function (v) { return v ? U.date(v) : ''; } },
    { key: 'portal',         label: 'Portal' },
    { key: 'region',         label: 'Region' },
    { key: 'location',       label: 'Location' },
    { key: 'price',          label: 'Bid Price',     fmt: function (v) { return v == null || v === '' ? '' : U.currency(v); } },
    { key: 'priceLocked',    label: 'Price lock',    fmt: function (v) { return v ? 'locked' : 'unlocked'; } },
    { key: 'engineer',       label: 'Engineer' },
    { key: 'estHrs',         label: 'Estm Hrs (intake)' },
    { key: 'assignedHrs',    label: 'Asgn Hrs (intake)' },
    { key: 'link',           label: 'Platform Link' },
    { key: 'comments',       label: 'Comments' },

    /* Three that are lists rather than values. A reader wants "Team & Hours:
       AF 8 hrs, MGJ 4 hrs -> AF 12 hrs, MGJ 4 hrs", not two JSON blobs, so each
       summarises itself into one comparable line. */
    { key: 'assignments', label: 'Team & Hours', fmt: function (v, bid) {
        return (root.Assign.rows(bid) || []).map(function (r) {
          return (r.engineer || '?') + ' ' + U.qty(U.n(r.asgnHrs)) + ' hrs' +
                 (r.taskType ? ' (' + r.taskType + ')' : '') +
                 // So marking a task finished is an entry in the log rather
                 // than a change nobody can see afterwards. Plain words, no
                 // brackets: this line is read by a person, and a bracket in it
                 // makes the log look like it is quoting JSON at them.
                 ' - ' + root.Assign.statusLabel(r).toLowerCase();
        }).join(', ');
      } },
    { key: 'productLines', label: 'Products & Materials', fmt: function (v, bid) {
        return (root.Products.rows(bid) || []).map(function (r) {
          return (r.product || '?') +
                 (root.Products.materialsOf(r).length
                   ? ' [' + root.Products.materialsOf(r).join(' + ') + ']' : '');
        }).join(', ');
      } }
  ];

  function fieldValue(def, bid) {
    var raw = bid ? bid[def.key] : undefined;
    var out = def.fmt ? def.fmt(raw, bid) : raw;
    return out == null ? '' : String(out);
  }

  /* A flat snapshot of everything above, taken before a mutation. */
  function snapshot(bid) {
    var out = {};
    FIELDS.forEach(function (f) { out[f.key] = fieldValue(f, bid); });
    return out;
  }

  function diff(before, bid) {
    var changes = [];
    FIELDS.forEach(function (f) {
      var after = fieldValue(f, bid);
      if (before[f.key] === after) return;
      changes.push({ field: f.key, label: f.label, from: before[f.key], to: after });
    });
    return changes;
  }

  /* ---- recording --------------------------------------------------------- */

  /* Two consecutive edits to the same field, by the same person, within this
     window are merged into one entry: the `to` and the timestamp move, the
     `from` stays. The inline editor commits on blur, so correcting a price
     twice in ten seconds would otherwise write three entries and bury the one
     that matters. Set to 0 to record literally every commit. */
  var COALESCE_MS = 2 * 60 * 1000;

  function push(bid, entry) {
    if (!Array.isArray(bid.history)) bid.history = [];
    bid.history.push(entry);
    return entry;
  }

  /* Appended by the transitions in js/bids.js. A move that does not change the
     stage is not a move and is not recorded - saving a bid twice should not
     fill its history with noise. */
  function record(bid, from, to, o) {
    if (!bid || from === to) return null;
    o = o || {};
    return push(bid, {
      id: root.Store.uid('h'),
      at: new Date().toISOString(),
      by: actor(),
      kind: 'stage',
      from: from,
      to: to,
      // The status either side, so a reversal can restore what was actually
      // there instead of picking a plausible-looking one.
      fromStatus: o.fromStatus || null,
      toStatus: o.toStatus || bid.status || null,
      comment: String(o.comment || '').trim(),
      reversal: !!o.reversal
    });
  }

  /* The bid came into existence. One entry, not a diff against nothing. */
  function recordCreated(bid) {
    if (!bid) return null;
    return push(bid, {
      id: root.Store.uid('h'),
      at: bid.createdAt || new Date().toISOString(),
      by: actor(),
      kind: 'created',
      comment: ''
    });
  }

  /* Everything else. Records only fields that actually moved, and merges into
     the previous entry when that entry is this person still editing the same
     one field a moment ago. */
  function recordEdit(bid, changes) {
    if (!bid || !changes || !changes.length) return null;
    var now = new Date();
    var who = actor();
    var list = entries(bid);
    var last = list[list.length - 1];

    if (COALESCE_MS && last && last.kind === 'edit' && last.by === who &&
        last.changes && last.changes.length === 1 && changes.length === 1 &&
        last.changes[0].field === changes[0].field &&
        (now - new Date(last.at)) < COALESCE_MS) {
      last.changes[0].to = changes[0].to;
      last.at = now.toISOString();
      // The whole point of merging is that it collapsed to nothing: somebody
      // typed a value, thought better of it, and put the original back.
      if (last.changes[0].from === last.changes[0].to) {
        bid.history = list.filter(function (e) { return e.id !== last.id; });
        return null;
      }
      return last;
    }

    return push(bid, {
      id: root.Store.uid('h'),
      at: now.toISOString(),
      by: who,
      kind: 'edit',
      changes: changes,
      comment: ''
    });
  }

  /* THE API THE REST OF THE APP USES.

     Snapshot, mutate, diff, record - in one call, so the three halves cannot
     drift apart the way a hand-written before/after pair does. Returns whatever
     the callback returned, so it can wrap an existing expression without the
     call site having to be restructured around it. */
  function track(bid, fn) {
    if (!bid) return fn();
    var before = snapshot(bid);
    var result = fn();
    recordEdit(bid, diff(before, bid));
    return result;
  }

  /* The most recent FORWARD move into a stage. Reversing reads its fromStatus
     to know what to go back to.

     Reversals are skipped deliberately, and it matters. A reversal's fromStatus
     is the state it was undoing, not the state the bid was in before it first
     arrived - so a bid awarded, moved back to Active, then moved back again to
     intake would read the reversal's fromStatus of "Awarded" and be restored to
     Awarded on its way to All Bids. Which is where it had just come from. */
  function arrivalAt(bid, stage) {
    var list = entries(bid);
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].to === stage && !list[i].reversal) return list[i];
    }
    return null;
  }

  /* ---- reversing --------------------------------------------------------- */

  /* Which stage a bid can be sent back to, or null when it is already at the
     beginning. Lost and Awarded both go back to Active: they are the two ways
     of leaving it. */
  function previousStage(bid) {
    /* A JOB THAT HAS BEEN RE-OPENED CANNOT BE MOVED BACK.
       There is a second entry pointing at this one as the thing it is a
       revision of. Walking this one back a stage would leave that pointer
       aimed at a bid in a state it never had, and the revision's number was
       derived from this one's - so the pair would disagree about what the job
       is called. Re-opening is not undone by moving the original; it is undone
       by deleting the revision, which is its own decision. */
    if (bid && bid.reopenedInto) return null;
    var now = stageOf(bid);
    if (now === 'awarded' || now === 'lost') return 'active';
    if (now === 'active') return 'intake';
    return null;
  }

  function canReverse(bid) {
    return !!previousStage(bid) && root.Auth.can('bid.edit');
  }

  /* Put the bid back a stage, and record that it happened.

     Applied here rather than in js/bids.js because undoing a transition is the
     history's business: it is the only thing that knows what the bid looked
     like before the move it is undoing. */
  function reverse(bid, comment) {
    var to = previousStage(bid);
    if (!bid || !to) return false;
    var from = stageOf(bid);
    var fromStatus = bid.status;
    var arrival = arrivalAt(bid, from);

    if (to === 'active') {
      // Coming back from Awarded or Lost. The award markers go; the number does
      // not, because it is on the proposal that was sent.
      bid.active = true;
      bid.awardedAt = null;
      bid.awardNo = null;
      bid.decidedAt = null;
      bid.status = (arrival && arrival.fromStatus) || 'Submitted to review';
    } else {
      // Back to intake. It was never picked up after all.
      bid.active = false;
      bid.activatedAt = null;
      bid.status = (arrival && arrival.fromStatus) || 'Not Started';
    }

    record(bid, from, to, {
      fromStatus: fromStatus, toStatus: bid.status,
      comment: comment, reversal: true
    });
    return true;
  }

  /* ---- the card ---------------------------------------------------------- */

  /* Entries are stamped UTC and read in IST - see U.stamp. An audit log is the
     one place a timestamp must not quietly mean something else depending on
     which machine is reading it. */
  function when(iso) {
    if (!iso) return '';
    var s = U.stamp(iso);
    return s === '-' ? '' : s;
  }

  /* Entries written before the log held anything but stage moves have no
     `kind`. They were all stage moves, so that is what they are read as. */
  function kindOf(e) { return e.kind || 'stage'; }

  /* A value as it appears in "from X to Y". Empty reads as "empty" rather than
     as a gap, because "changed the Revised Due to 07-22-2026" leaves out that
     there was nothing there before, which is the interesting half. */
  function val(v) {
    return v === '' || v == null
      ? '<span class="text-faint italic">empty</span>'
      : '<span class="font-medium">' + U.esc(v) + '</span>';
  }

  function headline(e) {
    if (kindOf(e) === 'created') {
      return '<span class="font-semibold">Bid created</span>';
    }
    if (kindOf(e) === 'deletion') {
      return '<span class="text-danger font-semibold">History entry deleted</span>';
    }
    if (kindOf(e) === 'edit') {
      var list = e.changes || [];
      if (!list.length) return 'Edited';
      return list.map(function (c) {
        return '<span class="block">' +
          '<span class="text-muted">' + U.esc(c.label || c.field) + '</span> ' +
          val(c.from) + ' <span class="text-faint">&rarr;</span> ' + val(c.to) +
        '</span>';
      }).join('');
    }
    return (e.reversal ? '<span class="text-warn-ink font-semibold">Moved back</span> to ' : 'Moved to ') +
      '<span class="font-semibold">' + U.esc(label(e.to)) + '</span>' +
      '<span class="text-muted"> from ' + U.esc(label(e.from)) + '</span>';
  }

  var KIND_ICON = {
    created:  { icon: 'fa-plus', tint: 'text-brand' },
    edit:     { icon: 'fa-pen', tint: 'text-muted' },
    deletion: { icon: 'fa-trash', tint: 'text-danger' }
  };

  function entryRow(bid, e) {
    var k = kindOf(e);
    var s = k === 'stage' ? (STAGES[e.to] || {}) : (KIND_ICON[k] || {});
    return '<li class="flex gap-3 py-2.5 border-t border-line first:border-t-0">' +
      '<span class="w-6 h-6 rounded-full bg-raised flex items-center justify-center shrink-0 mt-0.5">' +
        '<i class="fas ' + (s.icon || 'fa-arrow-right') + ' text-3xs ' + (s.tint || 'text-muted') + '"></i>' +
      '</span>' +
      '<span class="min-w-0 flex-1">' +
        '<span class="block text-xs text-ink">' + headline(e) + '</span>' +
        '<span class="block text-3xs text-muted mt-0.5">' +
          U.esc(when(e.at)) +
          (e.by ? ' &middot; ' + U.esc(e.by) : ' &middot; unattributed') +
          (k === 'stage' && e.toStatus ? ' &middot; ' + U.esc(e.toStatus) : '') +
        '</span>' +
        (e.comment
          ? '<span class="block mt-1 text-2xs text-ink bg-raised rounded px-2 py-1 break-words">' +
            U.esc(e.comment) + '</span>'
          : '') +
      '</span>' +
      (root.Auth.can('bid.history.delete')
        ? '<button onclick="History.promptDelete(' + bid.id + ',\'' + e.id + '\')" ' +
          'title="Delete this entry" class="text-faint hover:text-danger text-3xs shrink-0">' +
          '<i class="fas fa-trash"></i></button>'
        : '') +
    '</li>';
  }

  /* How many entries the card shows before it offers the rest. Per bid, and
     only for as long as the page is open - "show all" is a thing you do once
     to answer a question, not a preference worth storing. */
  var SHOW_LIMIT = 10;
  var expanded = {};

  function card(bid) {
    var list = entries(bid);
    var back = previousStage(bid);

    var action = canReverse(bid)
      ? '<button onclick="History.promptReverse(' + bid.id + ')" ' +
        'class="px-3 py-1.5 bg-warn-soft hover:bg-warn-soft/60 text-warn-ink rounded-lg ' +
        'text-xs font-semibold flex items-center gap-1.5">' +
        '<i class="fas fa-rotate-left"></i>Back to ' + U.esc(label(back)) + '</button>'
      : '';

    /* Newest first - the last thing that happened is what you opened this to
       find - and capped, because a bid worked over for a month has a lot of
       entries and none of the old ones is what you came for. */
    var newest = list.slice().reverse();
    var shown = expanded[bid.id] ? newest : newest.slice(0, SHOW_LIMIT);
    var hidden = newest.length - shown.length;

    var body = list.length
      ? '<ul class="-my-1">' + shown.map(function (e) { return entryRow(bid, e); }).join('') + '</ul>' +
        (hidden > 0
          ? '<button onclick="History.showAll(' + bid.id + ')" ' +
            'class="mt-3 text-xs font-semibold text-brand hover:text-brand-ink">' +
            'Show all ' + newest.length + ' entries</button>'
          : '')
      : '<p class="text-sm text-muted">Nothing recorded yet. Every change to this ' +
        'bid is logged here from now on &mdash; who made it, when, and what moved.</p>';

    return '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden" id="historyCard">' +
      '<div class="px-5 py-3 border-b border-line bg-raised flex items-center justify-between gap-3">' +
        '<h3 class="text-sm font-bold text-ink flex items-center gap-2">' +
          '<i class="fas fa-clock-rotate-left text-muted"></i>History' +
          (list.length ? '<span class="text-3xs font-normal text-muted">' + list.length + '</span>' : '') +
        '</h3>' + action +
      '</div>' +
      '<div class="p-5">' + body + '</div></div>';
  }

  function render(bid) {
    var host = U.$('historyCard');
    if (!host || !bid) return;
    host.outerHTML = card(bid);
  }

  /* ---- the confirmation -------------------------------------------------- */

  var pending = null;

  function close() {
    var el = U.$('historyModal');
    if (el) el.classList.add('hidden');
    pending = null;
  }

  function bidById(id) {
    return db().bids.filter(function (b) { return b.id === id; })[0] || null;
  }

  root.History = {
    STAGES: STAGES,
    FIELDS: FIELDS,
    stageOf: stageOf,
    label: label,
    entries: entries,
    record: record,

    /* The API every mutation goes through: snapshot, run, diff, record. */
    track: track,
    recordCreated: recordCreated,
    recordEdit: recordEdit,
    snapshot: snapshot,
    diff: diff,

    showAll: function (bidId) {
      expanded[bidId] = true;
      render(db().bids.filter(function (b) { return b.id === bidId; })[0]);
    },
    previousStage: previousStage,
    canReverse: canReverse,
    reverse: reverse,
    card: card,
    render: render,
    closeModal: close,

    /* Moving a bid back asks why. The comment is optional - sometimes it was
       simply a mis-click - but it is asked for at the moment the reason is
       known, which is the only moment anybody has it. */
    promptReverse: function (bidId) {
      var bid = bidById(bidId);
      if (!bid || !canReverse(bid)) return;
      var to = previousStage(bid);
      pending = { kind: 'reverse', bidId: bidId };

      U.$('historyTitle').textContent = 'Move back to ' + label(to) + '?';
      U.$('historyNote').innerHTML =
        '<span class="font-semibold text-ink">' + U.esc(bid.project || 'This bid') + '</span> ' +
        'goes back to ' + U.esc(label(to)) + '.' +
        (stageOf(bid) === 'awarded'
          ? ' The award is undone, but it keeps project number <span class="font-mono">' +
            U.esc(bid.proposalNo || '') + '</span> - that is on the proposal already.'
          : ' It keeps its project number.');
      U.$('historyComment').value = '';
      U.$('historyConfirm').textContent = 'Move back';
      U.$('historyConfirm').className =
        'px-5 py-2.5 bg-warn hover:bg-warn-hover text-white rounded-lg text-sm font-medium transition';
      U.$('historyCommentRow').classList.remove('hidden');
      U.$('historyModal').classList.remove('hidden');
      U.$('historyComment').focus();
    },

    promptDelete: function (bidId, entryId) {
      if (!root.Auth.can('bid.history.delete')) return;
      pending = { kind: 'delete', bidId: bidId, entryId: entryId };
      U.$('historyTitle').textContent = 'Delete this history entry?';
      U.$('historyNote').textContent =
        'The entry is removed, and a note that it was removed takes its place. ' +
        'The bid itself does not move.';
      U.$('historyConfirm').textContent = 'Delete entry';
      U.$('historyConfirm').className =
        'px-5 py-2.5 bg-danger hover:bg-danger-hover text-white rounded-lg text-sm font-medium transition';
      U.$('historyCommentRow').classList.add('hidden');
      U.$('historyModal').classList.remove('hidden');
    },

    confirm: function () {
      if (!pending) return;
      var bid = bidById(pending.bidId);
      if (!bid) { close(); return; }

      if (pending.kind === 'reverse') {
        var comment = U.$('historyComment').value;
        var to = previousStage(bid);
        reverse(bid, comment);
        close();
        root.Store.save();
        root.Bids.refresh();
        // The stage decides which list the project page belongs to, so it has
        // to be told - otherwise Back goes to a list this bid is no longer on.
        root.Project.openFrom(bid.id, to === 'intake' ? 'all' : 'active');
        U.toast('Moved back to ' + label(to) + '.', 'ok');
        return;
      }

      // A deletion replaces the entry rather than erasing it. Somebody reading
      // the history later can see that it is not the whole story.
      var gone = entries(bid).filter(function (e) { return e.id === pending.entryId; })[0];
      if (gone) {
        bid.history = entries(bid).filter(function (e) { return e.id !== pending.entryId; });
        bid.history.push({
          id: root.Store.uid('h'),
          at: new Date().toISOString(),
          by: actor(),
          from: gone.from, to: gone.to,
          fromStatus: null, toStatus: null,
          comment: 'An entry recorded ' + when(gone.at) + ' was deleted.',
          deletion: true
        });
      }
      close();
      root.Store.save();
      render(bid);
      U.toast('History entry deleted.', 'ok');
    }
  };
})(window);
