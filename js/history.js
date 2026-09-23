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

  /* ---- the two documents ------------------------------------------------- */

  /* WHAT IS WORTH RECORDING ABOUT A TAKEOFF AND A PROPOSAL.
   *
   * The log knew about the bid record and nothing else, so the takeoff and the
   * proposal - where the work is and where all of the money is - moved without
   * leaving a trace. A price that changed by forty thousand between Tuesday and
   * Thursday was unattributable.
   *
   * SAME CONTRACT AS FIELDS: a key, a label, and a fmt that reduces the thing
   * to one comparable line. These are digests, deliberately, not a diff of the
   * document. A takeoff is thousands of cells; recording every one would bury
   * the entry that says the total moved, and would put a copy of the document
   * inside the bid on every keystroke - see the size note on compact() below.
   *
   * So what is kept is what somebody reading back asks: how big did it get, and
   * what did it come to.
   */
  var DOC_FIELDS = {
    takeoff: [
      { key: 'products', label: 'Products', fmt: function (t) {
          return (t.products || []).map(function (p) { return p.name || 'unnamed'; }).join(', ');
        } },
      { key: 'productCount', label: 'Product count', fmt: function (t) {
          return String((t.products || []).length);
        } },
      { key: 'totalLF', label: 'Total LF', fmt: function (t, roll) {
          return roll.totalLF ? U.qty(roll.totalLF) : '';
        } },
      { key: 'base', label: 'Base cost', fmt: function (t, roll) {
          return roll.base ? U.currency(roll.base) : '';
        } },
      { key: 'miscPct', label: 'Misc %', fmt: function (t) {
          return String(U.n((t.rollup || {}).miscPct) || '');
        } },
      { key: 'taxPct', label: 'Tax %', fmt: function (t) {
          return String(U.n((t.rollup || {}).taxPct) || '');
        } },
      { key: 'freight', label: 'Freight', fmt: function (t) {
          var v = U.n((t.rollup || {}).freight);
          return v ? U.currency(v) : '';
        } },
      { key: 'roundMode', label: 'Rounding', fmt: function (t) {
          return (t.rollup || {}).roundMode === 'manual' ? 'manual' : 'to the next 10';
        } },
      /* THE ONE EVERYBODY OPENS THE LOG FOR. */
      { key: 'total', label: 'Takeoff total', fmt: function (t, roll) {
          return roll.total ? U.currency(roll.total) : '';
        } }
    ],

    proposal: [
      { key: 'proposalNo', label: 'Proposal No.', fmt: function (p) {
          return (p.proposalData || {}).proposalNo || '';
        } },
      { key: 'submittedDate', label: 'Submitted', fmt: function (p) {
          var v = (p.proposalData || {}).submittedDate;
          return v ? U.date(v) : '';
        } },
      { key: 'approvalDeadline', label: 'Approval deadline', fmt: function (p) {
          var v = (p.proposalData || {}).approvalDeadline;
          return v ? U.date(v) : '';
        } },
      { key: 'projectName', label: 'Project name', fmt: function (p) {
          return (p.proposalData || {}).projectName || '';
        } },
      { key: 'projectAddress', label: 'Project address', fmt: function (p) {
          return (p.proposalData || {}).projectAddress || '';
        } },
      { key: 'scopeCount', label: 'Scope items', fmt: function (p) {
          return String((p.scopeItems || []).length);
        } },
      /* The scope as one line - "Guardrail $12,400, Handrail $8,100" - so a
         line item that moved is visible without storing the whole array. */
      { key: 'scope', label: 'Scope', fmt: function (p) {
          return (p.scopeItems || []).map(function (s) {
            return (s.description || 'item') + ' ' + U.currency(U.n(s.cost));
          }).join(', ');
        } },
      { key: 'total', label: 'Proposal total', fmt: function (p) {
          var n = (p.scopeItems || []).reduce(function (s, x) { return s + U.n(x.cost); }, 0);
          return n ? U.currency(n) : '';
        } },
      { key: 'style', label: 'Layout', fmt: function (p) {
          return p.selectedStyle == null ? '' : String(p.selectedStyle);
        } }
    ]
  };

  /* Each value is capped. The only fields that can run long are the two name
     lists, and "which forty products" is a question for the takeoff itself -
     the log only has to say that the list changed. Without this a single entry
     can carry two kilobytes of product names twice over. */
  var VALUE_MAX = 80;

  function clip(v) {
    var s = v == null ? '' : String(v);
    return s.length > VALUE_MAX ? s.slice(0, VALUE_MAX - 1) + '…' : s;
  }

  function docFieldValue(def, doc, roll) {
    var out = def.fmt ? def.fmt(doc, roll) : doc[def.key];
    return clip(out == null ? '' : out);
  }

  /* The rollup is computed once per snapshot and handed to every field, rather
     than each of the four money fields recomputing the whole takeoff. */
  function rollupOf(kind, doc) {
    if (kind !== 'takeoff') return {};
    try { return root.TakeoffModel.computeTakeoff(doc) || {}; }
    catch (e) { return {}; }
  }

  function snapshotDoc(doc, kind) {
    var defs = DOC_FIELDS[kind];
    if (!doc || !defs) return null;
    var roll = rollupOf(kind, doc);
    var out = {};
    defs.forEach(function (f) { out[f.key] = docFieldValue(f, doc, roll); });
    return out;
  }

  /* The compact change shape: f(ield), a(fter... no - from), b(to). Two letters
     rather than {field,label,from,to} because the label is derivable and these
     are the entries there are most of. It is about a third the bytes. */
  function diffDoc(before, doc, kind) {
    var defs = DOC_FIELDS[kind];
    if (!before || !doc || !defs) return [];
    var roll = rollupOf(kind, doc);
    var changes = [];
    defs.forEach(function (f) {
      var after = docFieldValue(f, doc, roll);
      if (before[f.key] === after) return;
      changes.push({ f: f.key, a: before[f.key], b: after });
    });
    return changes;
  }

  function docLabel(kind, key) {
    var defs = DOC_FIELDS[kind] || [];
    for (var i = 0; i < defs.length; i++) if (defs[i].key === key) return defs[i].label;
    return key;
  }

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

  /* WHEN THIS BID LAST MOVED, AND WHO MOVED IT.
   *
   * Read by the Last Modified column on the bid lists, which is what answers
   * "what changed today" without opening thirty projects one at a time.
   *
   * Stamped on the record rather than taken from the server's updated_at
   * column: that column exists (see server/db.js) but is never sent - the
   * bootstrap selects id, json and rev - so the client has never seen it.
   * Living in the bid's own JSON, this needs no server change, no schema step,
   * and works on the no-server path too.
   *
   * FROM THE ENTRY'S OWN TIMESTAMP, not from Date.now(). That is what makes it
   * right in every case rather than in most: a bid being created stamps the
   * moment it was created, a coalesced edit stamps the moment the session
   * moved to, and the column can never disagree with the top line of the
   * History card - because this is the call that writes both.
   */
  function touch(bid, entry) {
    if (!bid || !entry) return entry;
    bid.updatedAt = entry.at;
    bid.updatedBy = entry.by || '';
    return entry;
  }

  function push(bid, entry) {
    if (!Array.isArray(bid.history)) bid.history = [];
    bid.history.push(entry);
    touch(bid, entry);
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
      // Merged rather than pushed, so push() never saw it - the stamp has to be
      // taken here or every second edit inside the window would leave Last
      // Modified reading the one before it.
      return touch(bid, last);
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

  /* ---- recording the documents ------------------------------------------- */

  /* THE SIZE PROBLEM, AND THE FOUR RULES THAT ANSWER IT.
   *
   * bid.history lives inside the bid's JSON blob, and that blob has a ceiling
   * that is not disk: server/db.js drops a record's body from the change log
   * once it passes LOG_BODY_MAX (32KB), after which every save makes every
   * connected browser refetch the record instead of being handed it. A takeoff
   * under active editing writes constantly, so a naive log crosses that line
   * and quietly turns a live-sync app into a polling one. Schema step 4 exists
   * because this already happened once: 98MB of a 107MB database.
   *
   * A bid without history is 2-5KB, so the budget is 16KB - half the ceiling,
   * deliberately, so the record stays well clear of it.
   *
   *   1  COMPACT ENCODING   {f,a,b}, label looked up at render. See diffDoc.
   *   2  TRUNCATION         80 characters a value. See clip.
   *   3  SESSION COALESCING a quarter of an hour of edits is one entry.
   *   4  ROLLUP, THEN FOLD  yesterday's entries collapse to one a day per
   *                         document; past the budget, the oldest fold into a
   *                         running summary.
   *
   * NOTHING IS EVER SILENTLY DROPPED. The rollup changes the RESOLUTION of old
   * entries, never their existence, and the fold leaves a visible line saying
   * how many edits it stands for, over what dates, and the net from -> to. Same
   * principle the deletion marker follows: the log may be pruned visibly, never
   * emptied quietly.
   */
  var DOC_COALESCE_MS = 15 * 60 * 1000;
  var HISTORY_BUDGET = 16 * 1024;
  var HISTORY_WARN = 12 * 1024;

  function docEntries(bid, doc) {
    return entries(bid).filter(function (e) {
      return kindOf(e) === 'doc' && e.doc === doc;
    });
  }

  /* Merge b's changes into a's, keeping the EARLIEST from and the LATEST to -
     so a session reads "the total moved from where it started to where it
     ended", which is the only thing anybody asks it. A field whose two ends
     have converged is dropped: somebody typed a figure, thought better of it,
     and put the original back, which is not a change. */
  function mergeChanges(into, add) {
    var by = {};
    (into || []).forEach(function (c) { by[c.f] = c; });
    (add || []).forEach(function (c) {
      if (by[c.f]) by[c.f].b = c.b;            // earliest `a` stays
      else { by[c.f] = { f: c.f, a: c.a, b: c.b }; into.push(by[c.f]); }
    });
    return into.filter(function (c) { return c.a !== c.b; });
  }

  function dayOf(iso) { return U.stampISO(iso) || String(iso || '').slice(0, 10); }

  /* Everything older than today, one entry per document per day. Today is left
     at full detail: the log is at its most precise exactly when somebody is
     looking at it, and coarsens only once the day is over. */
  function rollUpDays(bid) {
    var today = U.today();
    var keep = [];
    var byKey = {};
    entries(bid).forEach(function (e) {
      if (kindOf(e) !== 'doc' || e.rolled || dayOf(e.at) >= today || e.event) {
        keep.push(e);
        return;
      }
      var key = e.doc + '|' + dayOf(e.at);
      var hit = byKey[key];
      if (!hit) {
        byKey[key] = e;
        e.rolled = { n: 1, from: dayOf(e.at), to: dayOf(e.at), by: e.by ? [e.by] : [] };
        keep.push(e);
        return;
      }
      hit.rolled.n += 1;
      if (e.by && hit.rolled.by.indexOf(e.by) < 0) hit.rolled.by.push(e.by);
      hit.at = e.at;
      hit.c = mergeChanges(hit.c || [], e.c || []);
    });
    bid.history = keep;
  }

  function sizeOf(bid) {
    try { return JSON.stringify(entries(bid)).length; } catch (e) { return 0; }
  }

  /* Past the budget, the oldest doc entries per document fold into ONE running
     summary that keeps the net movement and says what it stands for. Runs
     oldest-first and stops the moment it is back inside the budget, so it takes
     the least it can rather than flattening the whole log. */
  function foldOldest(bid) {
    var guard = 0;
    while (sizeOf(bid) > HISTORY_BUDGET && guard++ < 200) {
      var list = entries(bid);
      var i = -1;
      for (var n = 0; n < list.length; n++) {
        if (kindOf(list[n]) === 'doc' && !list[n].event) { i = n; break; }
      }
      // Nothing left that may be folded. Stage moves and bid edits are the
      // record the office is answerable to and are never touched.
      if (i < 0) return;

      var oldest = list[i];
      var next = null;
      for (var m = i + 1; m < list.length; m++) {
        if (kindOf(list[m]) === 'doc' && !list[m].event && list[m].doc === oldest.doc) {
          next = list[m];
          break;
        }
      }
      if (!next) return;      // only one entry for this document; folding it into nothing would lose it

      var a = oldest.rolled || { n: 1, from: dayOf(oldest.at), to: dayOf(oldest.at),
                                 by: oldest.by ? [oldest.by] : [] };
      var b = next.rolled || { n: 1, from: dayOf(next.at), to: dayOf(next.at),
                               by: next.by ? [next.by] : [] };
      next.rolled = {
        n: a.n + b.n,
        from: a.from < b.from ? a.from : b.from,
        to: a.to > b.to ? a.to : b.to,
        by: a.by.concat(b.by.filter(function (x) { return a.by.indexOf(x) < 0; }))
      };
      next.c = mergeChanges((oldest.c || []).map(function (c) {
        return { f: c.f, a: c.a, b: c.b };
      }), next.c || []);
      next.by = '';           // it is several people now; `rolled.by` names them
      bid.history = list.filter(function (e) { return e.id !== oldest.id; });
    }
  }

  function compact(bid) {
    if (!bid || !Array.isArray(bid.history)) return bid;
    rollUpDays(bid);
    if (sizeOf(bid) > HISTORY_BUDGET) foldOldest(bid);
    if (sizeOf(bid) > HISTORY_WARN && root.console) {
      // Observed rather than discovered in the office. If this fires routinely
      // the log wants its own synced record instead of riding in the bid.
      console.warn('bid ' + bid.id + ' history is ' + sizeOf(bid) +
        ' bytes, past the ' + HISTORY_WARN + ' watermark');
    }
    return bid;
  }

  /* One entry for a document edit, coalescing into the previous one when it is
     the same person still working the same document a few minutes ago. */
  function recordDoc(bid, doc, changes) {
    if (!bid || !changes || !changes.length) return null;
    var now = new Date();
    var who = actor();
    var list = entries(bid);
    var last = list[list.length - 1];

    if (DOC_COALESCE_MS && last && kindOf(last) === 'doc' && last.doc === doc &&
        !last.event && !last.rolled && last.by === who &&
        (now - new Date(last.at)) < DOC_COALESCE_MS) {
      last.c = mergeChanges(last.c || [], changes);
      last.at = now.toISOString();
      // Merged down to nothing: the session put everything back where it was.
      if (!last.c.length) {
        bid.history = list.filter(function (e) { return e.id !== last.id; });
        return null;
      }
      compact(bid);
      // Same reason as the coalescing branch of recordEdit: merged, not
      // pushed, so the stamp is taken here.
      return touch(bid, last);
    }

    var entry = push(bid, {
      id: root.Store.uid('h'),
      at: now.toISOString(),
      by: who,
      kind: 'doc',
      doc: doc,
      c: changes
    });
    compact(bid);
    return entry;
  }

  /* The things that are not a diff: a document created, regenerated, or sent.
     An export is what the client actually saw, which is a fact the log should
     hold even though nothing on the record moved. */
  var DOC_EVENTS = {
    created:       'created',
    regenerated:   'regenerated from the takeoff',
    'exported-pdf':  'exported to PDF',
    'exported-xlsx': 'exported to Excel'
  };

  function recordDocEvent(bid, doc, event) {
    if (!bid || !DOC_EVENTS[event]) return null;
    var entry = push(bid, {
      id: root.Store.uid('h'),
      at: new Date().toISOString(),
      by: actor(),
      kind: 'doc',
      doc: doc,
      event: event
    });
    compact(bid);
    return entry;
  }

  /* Snapshot, mutate, diff, record - the documents' twin of track(). Returns
     whatever fn returned so it can wrap an existing expression. */
  function trackDoc(bid, doc, kind, fn) {
    if (!bid || !doc) return fn();
    var before = snapshotDoc(doc, kind);
    var result = fn();
    recordDoc(bid, kind, diffDoc(before, doc, kind));
    return result;
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

  /* One "Field from X to Y" line. Shared by bid edits and document edits, which
     differ only in where the label comes from - stored on the old shape,
     looked up from DOC_FIELDS on the compact one. */
  function changeLine(label, from, to) {
    return '<span class="block">' +
      '<span class="text-muted">' + U.esc(label) + '</span> ' +
      val(from) + ' <span class="text-faint">&rarr;</span> ' + val(to) +
    '</span>';
  }

  var DOC_NAMES = { takeoff: 'TakeOff', proposal: 'Proposal' };

  function headline(e) {
    if (kindOf(e) === 'created') {
      return '<span class="font-semibold">Bid created</span>';
    }
    if (kindOf(e) === 'deletion') {
      return '<span class="text-danger font-semibold">History entry deleted</span>';
    }

    /* A DOCUMENT CHANGED - and it says which one, because "the price moved" and
       "the takeoff's total moved" are different facts even when they happen in
       the same minute. */
    if (kindOf(e) === 'doc') {
      var name = DOC_NAMES[e.doc] || e.doc;
      var tag = '<span class="text-3xs font-bold uppercase tracking-wider text-muted ' +
        'bg-raised rounded px-1 py-px mr-1">' + U.esc(name) + '</span>';

      if (e.event) {
        return tag + '<span class="font-semibold">' +
          U.esc(name + ' ' + (DOC_EVENTS[e.event] || e.event)) + '</span>';
      }

      // A folded or rolled-up run says what it stands for before its figures,
      // so it cannot be misread as one person's single edit.
      var head = '';
      if (e.rolled && e.rolled.n > 1) {
        head = '<span class="block text-3xs text-muted mb-0.5">' +
          e.rolled.n + ' edits' +
          (e.rolled.from === e.rolled.to
            ? ' on ' + U.esc(U.date(e.rolled.from))
            : ', ' + U.esc(U.date(e.rolled.from)) + ' &ndash; ' + U.esc(U.date(e.rolled.to))) +
          (e.rolled.by && e.rolled.by.length
            ? ' by ' + U.esc(e.rolled.by.join(', ')) : '') +
          '</span>';
      }

      var cs = e.c || [];
      if (!cs.length) return tag + 'Edited';
      return tag + head + cs.map(function (c) {
        return changeLine(docLabel(e.doc, c.f), c.a, c.b);
      }).join('');
    }

    if (kindOf(e) === 'edit') {
      var list = e.changes || [];
      if (!list.length) return 'Edited';
      return list.map(function (c) {
        return changeLine(c.label || c.field, c.from, c.to);
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

  var DOC_ICON = {
    takeoff:  { icon: 'fa-calculator', tint: 'text-brand' },
    proposal: { icon: 'fa-file-contract', tint: 'text-brand' }
  };

  function iconOf(e) {
    var k = kindOf(e);
    if (k === 'stage') return STAGES[e.to] || {};
    if (k === 'doc') {
      // A run of folded edits is a summary and is marked as one, so it does not
      // read as a single thing somebody did.
      if (e.rolled && e.rolled.n > 1) return { icon: 'fa-layer-group', tint: 'text-muted' };
      return DOC_ICON[e.doc] || { icon: 'fa-pen', tint: 'text-muted' };
    }
    return KIND_ICON[k] || {};
  }

  function entryRow(bid, e) {
    var k = kindOf(e);
    var s = iconOf(e);
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
  /* Twenty rather than ten: a day of estimating is a handful of entries now
     that a session coalesces, so the cap can show more of the story before it
     offers the rest. */
  var SHOW_LIMIT = 20;
  var expanded = {};

  /* WHETHER THE CARD IS OPEN, AND IT STARTS SHUT.
   *
   * The log is reference material, not a dashboard. Open by default it was the
   * tallest thing on the project page - nine entries pushing the estimate and
   * the proposal, which is what somebody actually came for, below the fold.
   *
   * KEYED BY BID ID RATHER THAN A BARE BOOLEAN, and that is the whole subtlety
   * here. The card re-renders on every save - Assign.save calls History.render
   * - so a flag cleared on each render would snap the card shut the moment
   * somebody typed an hours box with the log open. Holding the id instead means
   * a repaint of the SAME bid leaves it open, and opening a DIFFERENT one comes
   * back collapsed, which is the behaviour asked for.
   *
   * View state, like `expanded` and `filters`: it never goes near Store.save,
   * because what somebody has open on their screen is not a change to the bid.
   */
  var openFor = null;

  function isOpen(bid) { return !!bid && openFor === bid.id; }

  /* WHICH ENTRIES THE CARD IS SHOWING. On a job that has been worked, the
     document edits outnumber everything else - which is what the log was
     missing, but it means the stage moves the card was built for get buried.
     So they can be narrowed to.

     View state, per bid, for as long as the page is open - like `expanded`
     above. It never goes near the record: what somebody is looking at is not a
     change to the bid, and writing it would broadcast "AF opened the takeoff
     filter" to every browser in the office. */
  var filters = {};

  var FILTERS = [
    { key: 'all',      label: 'All',      match: function () { return true; } },
    { key: 'bid',      label: 'Bid',      match: function (e) { return kindOf(e) !== 'doc'; } },
    { key: 'takeoff',  label: 'TakeOff',  match: function (e) { return e.doc === 'takeoff'; } },
    { key: 'proposal', label: 'Proposal', match: function (e) { return e.doc === 'proposal'; } }
  ];

  function filterOf(bidId) { return filters[bidId] || 'all'; }

  function filterFor(key) {
    for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === key) return FILTERS[i];
    return FILTERS[0];
  }

  /* Only offered where it would do something: a bid with no documents touched
     yet has nothing to narrow, and four chips over one kind of entry is a
     control that can only ever hide things. */
  function filterChips(bid, list) {
    var counts = {};
    FILTERS.forEach(function (f) {
      counts[f.key] = list.filter(f.match).length;
    });
    if (!counts.takeoff && !counts.proposal) return '';

    var on = filterOf(bid.id);
    return '<span class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-line/60">' +
      FILTERS.filter(function (f) { return f.key === 'all' || counts[f.key]; })
        .map(function (f) {
          var is = f.key === on;
          return '<button onclick="History.setFilter(' + bid.id + ',\'' + f.key + '\')" ' +
            'title="' + U.escAttr(counts[f.key] + ' entr' + (counts[f.key] === 1 ? 'y' : 'ies')) + '" ' +
            'class="px-2 py-0.5 rounded-md text-3xs font-semibold transition ' +
            (is ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink') + '">' +
            U.esc(f.label) +
            '<span class="ml-1 text-faint font-normal">' + counts[f.key] + '</span>' +
          '</button>';
        }).join('') +
    '</span>';
  }

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
    var picked = list.filter(filterFor(filterOf(bid.id)).match);
    var newest = picked.slice().reverse();
    var shown = expanded[bid.id] ? newest : newest.slice(0, SHOW_LIMIT);
    var hidden = newest.length - shown.length;

    var body = newest.length
      ? '<ul class="-my-1">' + shown.map(function (e) { return entryRow(bid, e); }).join('') + '</ul>' +
        (hidden > 0
          ? '<button onclick="History.showAll(' + bid.id + ')" ' +
            'class="mt-3 text-xs font-semibold text-brand hover:text-brand-ink">' +
            'Show all ' + newest.length + ' entries</button>'
          : '')
      : (list.length
        ? '<p class="text-sm text-muted">Nothing under this filter yet.</p>'
        : '<p class="text-sm text-muted">Nothing recorded yet. Every change to this ' +
          'bid is logged here from now on &mdash; who made it, when, and what moved. ' +
          'That includes the takeoff and the proposal.</p>');

    var open = isOpen(bid);

    /* WHAT THE BAR SAYS WHEN IT IS SHUT.
       A collapsed card that only says "History" is a row of nothing somebody
       has to open to find out whether it was worth opening. The last entry's
       age and author is the question most people came with - "has anybody
       touched this" - so it is answered without the click. */
    var last = list[list.length - 1];
    var summary = !open && last
      ? '<span class="text-2xs text-muted font-normal whitespace-nowrap" title="' +
        U.escAttr(when(last.at) + (last.by ? ' · ' + last.by : '')) + '">' +
        'Last change ' + U.esc(U.ago(last.at)) +
        (last.by ? ' &middot; ' + U.esc(last.by) : '') + '</span>'
      : '';

    /* The title block is the toggle, and it is a real <button> rather than a
       div with an onclick - that is what gets Enter and Space, the focus ring
       and the screen-reader announcement for free.

       Deliberately NOT the whole header bar. The reverse action and the filter
       chips sit in it too, and making the bar itself clickable would put a
       toggle underneath them - so reaching for "Back to All Bids" and missing
       it by two pixels would collapse the card instead. As siblings of the
       button rather than children, they need no stopPropagation guard: there
       is nothing above them to bubble to. */
    return '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden" id="historyCard">' +
      '<div class="px-5 py-3 ' + (open ? 'border-b border-line ' : '') +
           'bg-raised flex items-center justify-between gap-3 flex-wrap">' +
        '<button type="button" onclick="History.toggle(' + bid.id + ')" ' +
          'aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="historyBody" ' +
          'title="' + (open ? 'Hide the history' : 'Show what has happened to this bid') + '" ' +
          'class="flex items-center gap-2 min-w-0 text-left rounded ' +
          'hover:text-brand focus:outline-none focus:ring-2 focus:ring-brand/40">' +
          '<i class="fas fa-chevron-' + (open ? 'down' : 'right') +
            ' text-3xs text-faint w-2.5"></i>' +
          '<i class="fas fa-clock-rotate-left text-muted"></i>' +
          '<span class="text-sm font-bold text-ink">History</span>' +
          (list.length ? '<span class="text-3xs font-normal text-muted">' + list.length + '</span>' : '') +
          summary +
        '</button>' +
        // Only while open: they narrow a list that is not on screen otherwise.
        '<span class="flex items-center gap-2">' +
          (open ? filterChips(bid, list) : '') + action +
        '</span>' +
      '</div>' +
      (open ? '<div class="p-5" id="historyBody">' + body + '</div>' : '') +
    '</div>';
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

    /* When this bid last moved, and who moved it - written by every record*
       call above. The Last Modified column reads it. */
    touch: touch,
    lastMovedAt: function (bid) {
      return (bid && (bid.updatedAt || bid.createdAt)) || '';
    },

    /* The same four, for the takeoff and the proposal. trackDoc is what the
       two documents' save paths wrap themselves in. */
    DOC_FIELDS: DOC_FIELDS,
    trackDoc: trackDoc,
    recordDoc: recordDoc,
    recordDocEvent: recordDocEvent,
    snapshotDoc: snapshotDoc,
    diffDoc: diffDoc,
    /* The human name for a stored field key. The compact entry shape does not
       carry it, so the card and the XLSX export both look it up here. */
    docLabel: docLabel,

    /* Keeping the log inside the bid record's size budget without losing
       anything: roll yesterday up by day, then fold the oldest into a running
       summary. See the note above it. */
    compact: compact,
    HISTORY_BUDGET: HISTORY_BUDGET,
    DOC_COALESCE_MS: DOC_COALESCE_MS,
    size: sizeOf,

    /* Open or shut, for this bid. Starts shut on every project - see openFor. */
    toggle: function (bidId) {
      openFor = (openFor === bidId) ? null : bidId;
      // Closing and reopening is how somebody gets back to the top of a long
      // log, so the "show all" goes with it rather than persisting invisibly.
      if (openFor !== bidId) delete expanded[bidId];
      render(db().bids.filter(function (b) { return b.id === bidId; })[0]);
    },
    isOpen: isOpen,

    setFilter: function (bidId, key) {
      filters[bidId] = key;
      // A narrowed list is short again, so the "show all" it was on does not
      // carry over - otherwise switching filters silently un-caps the card.
      delete expanded[bidId];
      render(db().bids.filter(function (b) { return b.id === bidId; })[0]);
    },

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
        // Through push() rather than straight onto the array, so pruning the
        // log is stamped like every other change to the record. Editing the
        // audit trail is a change to the bid, and arguably the one most worth
        // having a timestamp against.
        push(bid, {
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
