/* bids.js - the original bid tracker, moved out of the HTML and pointed at the
   store. Behaviour is unchanged apart from two fixes: search now goes through
   U.low() instead of a bare .toLowerCase() (safe once a record has no region or
   material at all, which the Add Bid form can now produce), and the region list
   is sorted on a copy rather than in place. */
(function (root) {
  'use strict';

  var U = root.U;
  var selectedMonth = null;
  var deleteTarget = null;
  var charts = {};

  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function db() { return root.Store.db; }
  function bids() { return db().bids; }

  /* ---- statuses --------------------------------------------------------- */

  /* One table rather than the same six strings written out in the badge map,
     the KPI counts, the view filters and the form's <select>. Same treatment
     BidGrid.COLUMNS and Nav.MENU already get: adding a status is one entry.

     bucket - 'open'   still being worked
              'won'    awarded; carries a Job No.
              'closed' decided against

     onActive - does a bid with this status still belong on Active Bids?
     Deliberately not the same question as the bucket. Lost stays: the work went
     into it, and dropping it off the list the estimators actually read hides
     that history. No Scope is an intake verdict, reached on All Bids before a
     bid is ever picked up, so it never belongs on Active. Awarded leaves
     because it has stopped being a bid and become a job.

     settable - whether it can be chosen on the Add/Edit Bid form. Awarded and
     Lost are the outcome of the Award/Lost decision, which issues the job
     number, so they are not values you type. */
  var STATUSES = [
    { key: 'Not Started',         badge: 'status-notstarted', bucket: 'open',   settable: true,  onActive: true },
    { key: 'In Progress',         badge: 'status-progress',   bucket: 'open',   settable: true,  onActive: true },
    { key: 'Submitted to review', badge: 'status-submitted',  bucket: 'open',   settable: true,  onActive: true },
    { key: 'Completed',           badge: 'status-completed',  bucket: 'open',   settable: true,  onActive: true },
    { key: 'No Scope',            badge: 'status-noscope',    bucket: 'closed', settable: true,  onActive: false },
    { key: 'Awarded',             badge: 'status-awarded',    bucket: 'won',    settable: false, onActive: false },
    { key: 'Lost',                badge: 'status-lost',       bucket: 'closed', settable: false, onActive: true }
  ];

  function statusOf(key) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === key) return STATUSES[i];
    return null;
  }

  /* An unrecognised status - from a hand-edited file - is treated as open
     rather than swallowed, so the bid stays visible and fixable. */
  function bucketOf(bid) {
    var s = statusOf(bid && bid.status);
    return s ? s.bucket : 'open';
  }

  function onActiveOf(bid) {
    var s = statusOf(bid && bid.status);
    return s ? s.onActive : true;
  }

  function settableStatuses() {
    return STATUSES.filter(function (s) { return s.settable; });
  }

  function statusBadge(status) {
    var s = statusOf(status);
    return '<span class="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ' +
      (s ? s.badge : 'status-notstarted') + '">' + U.esc(status || 'Not Started') + '</span>';
  }

  /* ---- shared bits ----------------------------------------------------- */

  /* Products as chips, capped so one bid with six of them cannot blow the row
     height out. The title attribute carries the full list. */
  function productCell(bid, max) {
    var list = (bid.products || []).filter(Boolean);
    if (!list.length) return '<span class="text-slate-300">-</span>';
    var shown = list.slice(0, max);
    var rest = list.length - shown.length;
    return '<span class="flex flex-wrap gap-1" title="' + U.escAttr(list.join(', ')) + '">' +
      shown.map(function (p) {
        return '<span class="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] max-w-[150px] truncate">' +
          U.esc(p) + '</span>';
      }).join('') +
      (rest > 0 ? '<span class="px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded text-[10px] font-semibold">+' +
        rest + '</span>' : '') + '</span>';
  }

  /* Initials keep the column narrow; the full name rides along as a tooltip. */
  function engineerCell(bid) {
    var i = (bid.engineer || '').trim();
    if (!i) return '<span class="text-slate-300">&mdash;</span>';
    var name = engineerName(i);
    return '<span class="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[11px] font-semibold"' +
      (name ? ' title="' + U.escAttr(name) + '"' : ' title="Not in the engineers register"') + '>' +
      U.esc(i) + '</span>';
  }

  /* The team assigned in the active stage. Capped like the product chips so one
     bid with six people cannot blow the row height out; the tooltip carries the
     full list with each engineer's hours, which is the question you actually
     open a bid to answer. */
  function teamCell(bid) {
    var list = root.Assign.engineerList(bid);
    if (!list.length) return '<span class="text-slate-300">&mdash;</span>';

    var byEngineer = {};
    root.Assign.rows(bid).forEach(function (r) {
      var k = String(r.engineer || '').trim();
      if (!k) return;
      byEngineer[k] = (byEngineer[k] || 0) + U.n(r.estHrs) + U.n(r.asgnHrs);
    });
    var title = list.map(function (i) { return i + ' - ' + U.qty(byEngineer[i]) + ' hrs'; }).join(', ');

    var shown = list.slice(0, 3);
    var rest = list.length - shown.length;
    return '<span class="inline-flex flex-wrap gap-1 justify-center" title="' + U.escAttr(title) + '">' +
      shown.map(function (i) {
        return '<span class="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[11px] font-semibold">' +
          U.esc(i) + '</span>';
      }).join('') +
      (rest > 0 ? '<span class="px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded text-[11px] font-semibold">+' +
        rest + '</span>' : '') + '</span>';
  }

  /* The proposal button next to the takeoff one. It opens the document that was
     generated; regenerating is a deliberate act done from the proposal itself,
     where the wording you might overwrite is on screen. */
  function proposalButton(bid) {
    var d = db();
    var has = bid.proposalId && d.proposals[bid.proposalId];
    if (has) {
      return '<button onclick="Proposal.open(\'' + bid.proposalId + '\')" title="View the bid proposal" ' +
        'class="btn-icon w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 flex items-center justify-center">' +
        '<i class="fas fa-file-contract text-xs"></i></button>';
    }
    if (root.Takeoff.hasTakeoff(bid)) {
      return '<button onclick="Proposal.generateFromTakeoff(\'' + bid.takeoffId + '\')" title="Generate a bid proposal from the takeoff" ' +
        'class="btn-icon w-7 h-7 rounded-lg bg-slate-50 text-slate-400 hover:bg-slate-100 flex items-center justify-center">' +
        '<i class="fas fa-file-contract text-xs"></i></button>';
    }
    return '<span title="Start a takeoff first" ' +
      'class="w-7 h-7 rounded-lg bg-slate-50 text-slate-200 flex items-center justify-center cursor-not-allowed">' +
      '<i class="fas fa-file-contract text-xs"></i></span>';
  }

  /* Awarding or losing a bid is a decision with consequences - one issues a job
     number, both take the bid off Active - so it is a menu with a confirmation
     behind each choice rather than a button that acts on the first click.
     Hidden once the bid is decided, since there is nothing left to decide. */
  function decisionMenu(bid) {
    if (!root.Auth.can('bid.award')) return '';
    // Offered while the bid is on Active Bids, which now includes Lost ones: a
    // lost job that comes back should be awardable from where you are looking
    // at it rather than needing the status unpicked first.
    if (!onActiveOf(bid)) {
      return '<span title="' + U.escAttr(bid.awardNo ? 'Awarded as ' + bid.awardNo : 'Already decided') + '" ' +
        'class="w-7 h-7 rounded-lg bg-slate-50 text-slate-200 flex items-center justify-center cursor-not-allowed">' +
        '<i class="fas fa-trophy text-xs"></i></span>';
    }
    return '<span class="relative inline-flex">' +
      '<button onclick="Bids.toggleDecisionMenu(event,' + bid.id + ')" title="Award or mark lost" ' +
        'class="btn-icon w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center justify-center">' +
        '<i class="fas fa-trophy text-xs"></i></button>' +
      '<span id="decide-' + bid.id + '" class="hidden absolute right-0 top-8 z-30 bg-white border border-slate-200 rounded-lg shadow-xl py-1 w-40 text-left">' +
        decisionMenuItem(bid.id, 'Awarded', 'fa-trophy', 'Award', 'text-emerald-700') +
        decisionMenuItem(bid.id, 'Lost', 'fa-xmark', 'Mark Lost', 'text-red-600') +
      '</span></span>';
  }

  /* Any open row menu closes on the next click anywhere, the way the grid's
     filter popovers already behave. */
  function closeDecisionMenus() {
    var open = document.querySelectorAll('[id^="decide-"]:not(.hidden)');
    Array.prototype.forEach.call(open, function (el) { el.classList.add('hidden'); });
  }

  function decisionMenuItem(id, outcome, icon, label, cls) {
    return '<button onclick="Bids.decide(' + id + ',\'' + outcome + '\')" ' +
      'class="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ' + cls + '">' +
      '<i class="fas ' + icon + ' w-4 mr-1.5"></i>' + label + '</button>';
  }

  /* All Bids is an intake register, so its rows offer the one thing you do with
     an intake record - pick it up - rather than the estimating controls, which
     belong to a bid somebody is actually working. */
  function promoteButton(bid) {
    if (!root.Auth.can('bid.edit')) return '';
    if (bid.active && onActiveOf(bid)) {
      return '<span title="Already in Active Bids" ' +
        'class="w-7 h-7 rounded-lg bg-slate-50 text-slate-200 flex items-center justify-center cursor-not-allowed">' +
        '<i class="fas fa-bolt text-xs"></i></span>';
    }
    return '<button onclick="Bids.addToActive(' + bid.id + ')" title="Add to Active Bids" ' +
      'class="btn-icon w-7 h-7 rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 flex items-center justify-center">' +
      '<i class="fas fa-bolt text-xs"></i></button>';
  }

  /* The row itself opens the project page, so every control in here has to stop
     the click from reaching it - one guard on the container covers the lot. */
  function actionCell(bid) {
    var hasT = root.Takeoff.hasTakeoff(bid);
    var estimating = view === 'all'
      ? promoteButton(bid)
      : '<button onclick="Takeoff.openForBid(' + bid.id + ')" title="' +
          (hasT ? 'Open takeoff' : 'Start a takeoff') + '" class="btn-icon w-7 h-7 rounded-lg flex items-center justify-center ' +
          (hasT ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-slate-50 text-slate-400 hover:bg-slate-100') +
          '"><i class="fas fa-calculator text-xs"></i></button>' +
        proposalButton(bid) +
        decisionMenu(bid);

    return '<div class="flex items-center gap-1.5" onclick="event.stopPropagation()">' +
      estimating +
      (root.Auth.can('bid.edit')
        ? '<button onclick="Bids.edit(' + bid.id + ')" title="Edit" class="btn-icon w-7 h-7 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center"><i class="fas fa-pen text-xs"></i></button>'
        : '') +
      // Deleting a bid is the one row action the screenshots mark as belonging
      // to specific roles rather than everybody. The server refuses it too.
      (root.Auth.can('bid.delete')
        ? '<button onclick="Bids.promptDelete(' + bid.id + ')" title="Delete" class="btn-icon w-7 h-7 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 flex items-center justify-center"><i class="fas fa-trash text-xs"></i></button>'
        : '') +
      (bid.link ? '<a href="' + U.escAttr(bid.link) + '" target="_blank" rel="noopener" title="Open portal link" class="btn-icon w-7 h-7 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 flex items-center justify-center"><i class="fas fa-external-link-alt text-xs"></i></a>' : '') +
      '</div>';
  }

  /* ---- award numbering -------------------------------------------------- */

  /* An awarded job is known by DIS-<yy>-<0001>, where yy is the year it was
     awarded and the sequence restarts each year.

     Allocated as "highest existing for that year + 1" rather than from a stored
     counter: a number that has been on paper must never be handed to a second
     job, and deleting a bid must not make its number available again. Counting
     the bids gives both for free, with nothing to keep in sync. */
  function nextAwardNo(dateISO) {
    var yy = String(dateISO || U.today()).slice(2, 4);
    var re = new RegExp('^DIS-' + yy + '-(\\d{4})$');
    var max = bids().reduce(function (m, b) {
      var hit = re.exec(b.awardNo || '');
      return hit ? Math.max(m, Number(hit[1])) : m;
    }, 0);
    return 'DIS-' + yy + '-' + String(max + 1).padStart(4, '0');
  }

  /* The single way a bid becomes Awarded. Idempotent: a bid that already has a
     number keeps it, so re-awarding, or moving out of Awarded and back, never
     renumbers the job. */
  function applyAward(bid, dateISO) {
    bid.status = 'Awarded';
    if (!bid.awardedAt) bid.awardedAt = dateISO || U.today();
    if (!bid.awardNo) bid.awardNo = nextAwardNo(bid.awardedAt);
    return bid.awardNo;
  }

  /* The other outcome. No number is issued - job numbers identify work we are
     actually doing, and a lost bid never becomes one. */
  function applyLost(bid, dateISO) {
    bid.status = 'Lost';
    if (!bid.decidedAt) bid.decidedAt = dateISO || U.today();
  }

  /* ---- the Award / Lost decision ---------------------------------------- */

  /* Both outcomes go through one modal: they are the same decision with
     different consequences, and two near-identical confirmations would drift. */
  /* Class names are written out in full rather than assembled from a colour
     name: Tailwind only ships the classes it can see, and 'bg-' + tone + '-600'
     is not one of them. */
  var DECISIONS = {
    Awarded: {
      verb: 'Award', icon: 'fa-trophy',
      wrapClass: 'w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4',
      iconClass: 'fas fa-trophy text-emerald-600 text-2xl',
      buttonClass: 'px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition',
      title: 'Move to Awarded?',
      note: 'It moves off Active Bids into Awarded Bids. The number is permanent — ' +
            'it is not reissued if the status changes again.',
      apply: applyAward
    },
    Lost: {
      verb: 'Mark Lost', icon: 'fa-xmark',
      wrapClass: 'w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4',
      iconClass: 'fas fa-xmark text-red-600 text-2xl',
      buttonClass: 'px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition',
      title: 'Mark this bid as Lost?',
      note: 'It moves off Active Bids and stays in All Bids. No job number is issued — ' +
            'those identify work we are doing.',
      apply: applyLost
    }
  };

  var decisionTarget = null;
  var decisionOutcome = null;

  function promptDecision(id, outcome) {
    var b = bids().filter(function (x) { return x.id === id; })[0];
    var d = DECISIONS[outcome];
    if (!b || !d) return;
    if (b.status === outcome) {
      U.toast('That bid is already ' + outcome.toLowerCase() + '.', 'warn');
      return;
    }
    decisionTarget = id;
    decisionOutcome = outcome;

    U.$('decisionTitle').textContent = d.title;
    U.$('decisionProject').textContent = b.project || 'This bid';
    U.$('decisionIcon').className = d.iconClass;
    U.$('decisionIconWrap').className = d.wrapClass;
    U.$('decisionNote').textContent = d.note;
    U.$('decisionConfirm').className = d.buttonClass;
    U.$('decisionConfirm').textContent = d.verb;

    // Only the award issues a number, and it is named before the fact so nobody
    // is surprised by which one they got.
    var numberRow = U.$('decisionNumberRow');
    if (outcome === 'Awarded') {
      numberRow.classList.remove('hidden');
      U.$('decisionNumber').textContent = b.awardNo || nextAwardNo(U.today());
      U.$('decisionNumberLabel').textContent = b.awardNo
        ? 'keeps its existing job number' : 'will be given job number';
    } else {
      numberRow.classList.add('hidden');
      // The label sits outside the hidden row, beside the project name, so it
      // has to be cleared too or Lost would read "will be given job number".
      U.$('decisionNumberLabel').textContent = 'will be marked as lost.';
    }

    U.$('decisionModal').classList.remove('hidden');
  }

  function confirmDecision() {
    var b = bids().filter(function (x) { return x.id === decisionTarget; })[0];
    var d = DECISIONS[decisionOutcome];
    U.$('decisionModal').classList.add('hidden');
    if (!b || !d) return;
    d.apply(b);
    root.Store.save();
    refresh();
    repaintProject();
    U.toast(decisionOutcome === 'Awarded'
      ? 'Awarded as ' + b.awardNo + '.'
      : 'Marked as lost.', 'ok');
  }

  /* ---- promotion into Active Bids --------------------------------------- */

  /* All Bids is the register of everything received; a bid only reaches Active
     Bids when someone picks it up.

     The reset is keyed on onActive, not the bucket: a No Scope or Awarded bid
     would be invisible on the list it was just added to, so it reopens at the
     start. A Lost bid belongs on Active as it stands, so promoting one leaves
     its status alone rather than quietly erasing the outcome. */
  function addToActive(bid) {
    if (!bid) return false;
    if (bid.active && onActiveOf(bid)) return false;
    bid.active = true;
    if (!onActiveOf(bid)) bid.status = 'Not Started';
    if (!bid.activatedAt) bid.activatedAt = U.today();
    return true;
  }

  /* Two bids can legitimately carry the same project name - a rebid, a second
     package, a revised scope - so this is a warning, not a rule. But finding out
     afterwards means duplicated estimating work, so it is raised at the moment
     the bid is picked up, with the existing ones named. */
  function nameKey(v) {
    return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function duplicateProjects(bid) {
    var key = nameKey(bid.project);
    if (!key) return [];
    return bids().filter(function (b) {
      return b.id !== bid.id && nameKey(b.project) === key;
    });
  }

  /* Which list a bid is sitting in, for the duplicate warning - the first thing
     you want to know about the one already on file. */
  function stageOf(b) {
    if (b.status === 'Awarded') return 'Awarded Bids';
    if (b.active && onActiveOf(b)) return 'Active Bids';
    return 'All Bids';
  }

  var activateTarget = null;
  var activateThen = null;

  /* The one way into Active Bids. Both the row button and the project page go
     through here so neither can skip the duplicate check. */
  function requestAddToActive(id, then) {
    var b = bids().filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    if (b.active && onActiveOf(b)) { U.toast('That bid is already active.', 'warn'); return; }

    var dups = duplicateProjects(b);
    if (!dups.length) { commitAddToActive(b, then); return; }

    activateTarget = id;
    activateThen = then || null;
    U.$('duplicateProject').textContent = b.project || 'This bid';
    U.$('duplicateCount').textContent = dups.length === 1
      ? 'A bid with this project name is already on file:'
      : dups.length + ' bids with this project name are already on file:';
    U.$('duplicateList').innerHTML = dups.map(function (d) {
      return '<div class="flex items-center justify-between gap-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-left">' +
        '<div class="min-w-0">' +
          '<div class="text-sm font-semibold text-slate-800 truncate">' + U.esc(d.project) + '</div>' +
          '<div class="text-[11px] text-slate-500">' + U.esc(stageOf(d)) +
            (d.proposalNo ? ' &middot; <span class="font-mono">' + U.esc(d.proposalNo) + '</span>' : ' &middot; no proposal no.') +
            (d.awardNo ? ' &middot; <span class="font-mono text-emerald-700">' + U.esc(d.awardNo) + '</span>' : '') +
          '</div>' +
        '</div>' +
        root.Bids.statusBadge(d.status) +
      '</div>';
    }).join('');
    U.$('duplicateModal').classList.remove('hidden');
  }

  function commitAddToActive(b, then) {
    if (!addToActive(b)) { U.toast('That bid is already active.', 'warn'); return; }
    root.Store.save();
    refresh();
    repaintProject();
    U.toast('"' + (b.project || 'Bid') + '" added to Active Bids.' +
      (b.proposalNo ? '' : ' Give it a Proposal No. to identify it.'), 'ok');
    if (then) then(b);
  }

  function confirmAddToActive() {
    U.$('duplicateModal').classList.add('hidden');
    var b = bids().filter(function (x) { return x.id === activateTarget; })[0];
    var then = activateThen;
    activateTarget = null;
    activateThen = null;
    if (b) commitAddToActive(b, then);
  }

  function cancelAddToActive() {
    U.$('duplicateModal').classList.add('hidden');
    activateTarget = null;
    activateThen = null;
  }

  /* The project page shows the bid it is on, so anything that changes one has
     to repaint it - it may well be the screen you are looking at. */
  function repaintProject() {
    if (!root.Project) return;
    root.Project.renderHeader();
    if (root.App.currentTab === 'project') root.Project.render();
  }

  /* ---- KPIs and month grid --------------------------------------------- */

  function updateKPIs() {
    var b = bids();
    U.$('kpiTotal').textContent = b.length;
    U.$('kpiSubmitted').textContent = b.filter(function (x) { return x.status === 'Submitted to review'; }).length;
    U.$('kpiProgress').textContent = b.filter(function (x) { return x.status === 'In Progress'; }).length;
    U.$('kpiAwarded').textContent = b.filter(function (x) { return x.status === 'Awarded'; }).length;
    U.$('kpiValue').textContent = U.currency(b.reduce(function (s, x) { return s + U.n(x.price); }, 0));

    // js/nav.js draws these from viewCount whenever it renders the strip; this
    // keeps them current after a mutation that does not re-render it.
    Object.keys(VIEWS).forEach(function (k) {
      var el = U.$('badge-' + k);
      if (el) el.textContent = viewCount(k);
    });

    var rec = U.$('totalRecords');
    if (rec) rec.textContent = b.length;
  }

  function renderMonthGrid() {
    var host = U.$('monthGrid');
    if (!host) return;
    var counts = new Array(12).fill(0);
    bids().forEach(function (b) { if (b.month >= 0 && b.month < 12) counts[b.month]++; });
    host.innerHTML = monthNames.map(function (name, i) {
      return '<div onclick="Bids.selectMonth(' + i + ')" class="month-card ' +
        (selectedMonth === i ? 'active' : '') + ' bg-white rounded-lg p-3 text-center border border-slate-200 shadow-sm">' +
        '<p class="text-xs font-semibold text-slate-500 uppercase">' + name + '</p>' +
        '<p class="text-xl font-bold ' + (counts[i] > 0 ? 'text-blue-600' : 'text-slate-300') + '">' + counts[i] + '</p>' +
        '<p class="text-[10px] text-slate-400">bids</p></div>';
    }).join('');
  }

  /* ---- tables ---------------------------------------------------------- */

  /* The three tabs are three stages of a bid's life, not three filters over one
     status field:

       All Bids     every bid received - the intake register
       Active Bids  the ones someone has picked up and is working
       Awarded Bids the job register

     Active is `promoted AND still open` rather than a flag that gets cleared
     when a bid is decided. The flag records "someone picked this up" and the
     status records "is it still open"; keeping them as two independent facts
     means they cannot disagree - marking a bid Lost takes it off Active with
     nothing having to remember to clear a second field, and reopening it puts
     it back. */
  var VIEWS = {
    all: {
      label: 'All Bids',
      match: function () { return true; },
      options: function () { return STATUSES.map(function (s) { return s.key; }); }
    },
    active: {
      label: 'Active Bids',
      match: function (b) { return !!b.active && onActiveOf(b); },
      options: function () {
        return STATUSES.filter(function (s) { return s.onActive; })
          .map(function (s) { return s.key; });
      }
    },
    awarded: {
      label: 'Awarded Bids',
      match: function (b) { return b.status === 'Awarded'; },
      options: function () { return ['Awarded']; }
    }
  };
  var view = 'active';

  /* How many bids are in one list, ignoring the search box and the column
     filters - a tab badge counts what the tab holds, not what you have narrowed
     it to. Read by js/nav.js for the sub-menu badges. */
  function viewCount(key) {
    if (!VIEWS[key]) return null;
    return bids().filter(VIEWS[key].match).length;
  }

  /* The set of bids the grid works over, before any column filter. The grid's
     filter popovers read their distinct values from this, so the options do not
     shrink as you narrow the table. */
  function baseList() {
    var search = U.low(U.$('searchActive').value);
    var status = U.$('filterStatus').value;
    var region = U.$('filterRegion').value;
    var month = U.$('filterMonth').value;

    var list = bids().filter(VIEWS[view].match);

    if (search) {
      list = list.filter(function (b) {
        return U.low(b.project).indexOf(search) >= 0 ||
          U.low(b.region).indexOf(search) >= 0 ||
          U.low(b.material).indexOf(search) >= 0 ||
          U.low(b.engineer).indexOf(search) >= 0 ||
          U.low((b.products || []).join(' ')).indexOf(search) >= 0;
      });
    }
    if (status) list = list.filter(function (b) { return b.status === status; });
    if (region) list = list.filter(function (b) { return b.region === region; });
    if (month !== '') list = list.filter(function (b) { return b.month === parseInt(month, 10); });
    return list;
  }

  function filterTable() {
    root.BidGrid.render(baseList());
    var n = root.BidGrid.filterCount();
    var badge = U.$('gridFilterBadge');
    if (badge) {
      badge.textContent = n ? String(n) : '';
      badge.classList.toggle('hidden', !n);
    }
  }

  /* Switching view swaps the status choices too: offering "Awarded" on the
     Active list, or "In Progress" on the Awarded list, would filter to nothing
     and look like a bug. */
  function setView(v) {
    if (!VIEWS[v]) return;
    view = v;
    var sel = U.$('filterStatus');
    if (sel) {
      var cur = sel.value;
      var options = VIEWS[v].options();
      sel.innerHTML = '<option value="">All Status</option>' +
        options.map(function (o) {
          return '<option value="' + U.escAttr(o) + '">' + U.esc(o) + '</option>';
        }).join('');
      if (options.indexOf(cur) >= 0) sel.value = cur;
    }
    var search = U.$('searchActive');
    if (search) search.placeholder = 'Search ' + VIEWS[v].label.toLowerCase() + '...';
    filterTable();
  }

  /* ---- analytics ------------------------------------------------------- */

  function renderCharts() {
    if (!root.Chart) return;
    // Chart.js keeps a registry per canvas; without destroying first, repeated
    // tab switches stack instances and leak.
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); charts[k] = null; }
    });

    var b = bids();
    var palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
      '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'];

    var monthCounts = new Array(12).fill(0);
    b.forEach(function (x) { if (x.month >= 0 && x.month < 12) monthCounts[x.month]++; });
    charts.month = new root.Chart(U.$('monthChart'), {
      type: 'bar',
      data: {
        labels: monthNames,
        datasets: [{ label: 'Bids', data: monthCounts, backgroundColor: '#3b82f6', borderRadius: 4 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    charts.status = pie('statusChart', tally(b, 'status'), palette);
    charts.material = pie('materialChart', tally(b, 'material'), palette);
    charts.region = pie('regionChart', tally(b, 'region', 8), palette);
  }

  function tally(list, field, limit) {
    var counts = {};
    list.forEach(function (x) {
      var k = (x[field] || '').trim() || 'Unspecified';
      counts[k] = (counts[k] || 0) + 1;
    });
    var pairs = Object.keys(counts).map(function (k) { return [k, counts[k]]; })
      .sort(function (a, c) { return c[1] - a[1]; });
    if (limit && pairs.length > limit) {
      var rest = pairs.slice(limit).reduce(function (s, p) { return s + p[1]; }, 0);
      pairs = pairs.slice(0, limit);
      if (rest) pairs.push(['Other', rest]);
    }
    return pairs;
  }

  function pie(canvasId, pairs, palette) {
    var el = U.$(canvasId);
    if (!el) return null;
    return new root.Chart(el, {
      type: 'doughnut',
      data: {
        labels: pairs.map(function (p) { return p[0]; }),
        datasets: [{ data: pairs.map(function (p) { return p[1]; }), backgroundColor: palette }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }

  /* ---- regions --------------------------------------------------------- */

  function populateRegionSelects() {
    // Sort a copy: the original mutated the shared array on every call.
    var sorted = db().regions.slice().sort();
    ['mRegion', 'filterRegion'].forEach(function (id) {
      var sel = U.$(id);
      if (!sel) return;
      var cur = sel.value;
      sel.innerHTML = id === 'mRegion' ? '<option value="">Select Region</option>' : '<option value="">All Regions</option>';
      sorted.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r; o.textContent = r;
        sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    });
  }

  /* The host only exists while the Settings > Regions panel is showing, and
     these are called from mutations that can happen from elsewhere. */
  function renderRegionList() {
    var d = db();
    var host = U.$('regionList');
    if (!host) return;
    host.innerHTML = d.regions.slice().sort().map(function (r) {
      var used = d.bids.filter(function (b) { return b.region === r; }).length;
      return '<div class="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg">' +
        '<span class="text-sm text-slate-700">' + U.esc(r) +
          (used ? ' <span class="text-xs text-slate-400">(' + used + ')</span>' : '') + '</span>' +
        '<button onclick="Bids.removeRegion(\'' + U.escAttr(r).replace(/'/g, "\\'") + '\')" class="text-red-500 hover:text-red-700 text-xs"><i class="fas fa-trash"></i></button></div>';
    }).join('');
  }

  /* ---- modal ----------------------------------------------------------- */

  /* The job number is issued by the app, never typed, so the form shows it as a
     fact rather than a field. */
  function renderAwardNoHint(b) {
    var host = U.$('awardNoHint');
    if (!host) return;
    host.innerHTML = b && b.awardNo
      ? '<span class="px-2 py-1 rounded bg-emerald-50 text-emerald-700 font-mono font-semibold text-sm">' +
        U.esc(b.awardNo) + '</span>'
      : '<span class="text-slate-400 text-xs">Issued on award</span>';
  }

  /* An active bid's real hours are on its Team & Hours card, not in this form.
     Saying so - with the figure - stops the first-pass boxes above being read
     as the project's total. */
  function renderTeamHrsHint(b) {
    var host = U.$('teamHrsHint');
    if (!host) return;
    if (!b || !b.active) { host.innerHTML = ''; return; }
    var t = root.Assign.totals(b);
    host.innerHTML = t.count
      ? 'Team hours: <span class="font-mono font-semibold text-slate-700">' + U.qty(t.est) +
        '</span> estm &middot; <span class="font-mono font-semibold text-slate-700">' + U.qty(t.asgn) +
        '</span> asgn &mdash; edit on the project page'
      : '<span class="text-slate-400">No team hours yet &mdash; add them on the project page</span>';
  }

  /* Awarded and Lost are outcomes of the Award/Lost decision, not values you
     type, so they are not offered. A bid that already holds one keeps it as a
     selected option: without that, opening an awarded job and pressing Save
     would silently demote it to whatever happened to be first in the list. */
  function populateStatusSelect(current) {
    var sel = U.$('mStatus');
    if (!sel) return;
    var options = settableStatuses().map(function (s) { return s.key; });
    if (current && options.indexOf(current) < 0) options.push(current);
    sel.innerHTML = options.map(function (o) {
      return '<option value="' + U.escAttr(o) + '">' + U.esc(o) + '</option>';
    }).join('');
    sel.value = current && options.indexOf(current) >= 0 ? current : options[0];
  }

  /* The Proposal No. is only on the form for a bid that has been picked up. A
     new bid, or one still sitting in All Bids, is identified by its name and
     its place in the list - the Sr. No. - and nothing else; asking for a
     proposal number before there is going to be a proposal invites one being
     invented and then changed. */
  function showProposalNoBlock(b) {
    var block = U.$('proposalNoBlock');
    if (block) block.classList.toggle('hidden', !(b && b.active));
  }

  function openAdd() {
    populateEngineerList();
    U.$('modalTitle').textContent = 'Add New Bid';
    U.$('bidForm').reset();
    setProducts([]);             // after reset(), which would clear the picker
    U.setDateField('mDueDate', '');
    U.$('editId').value = '';
    populateStatusSelect(null);
    showProposalNoBlock(null);
    U.$('mProposalNo').classList.remove('border-red-400', 'bg-red-50');
    renderAwardNoHint(null);
    renderTeamHrsHint(null);
    U.$('bidModal').classList.remove('hidden');
  }

  function edit(id) {
    var b = bids().filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    populateEngineerList();
    U.$('modalTitle').textContent = 'Edit Bid';
    U.$('editId').value = b.id;
    U.$('mProposalNo').value = b.proposalNo || '';
    U.$('mProposalNo').classList.remove('border-red-400', 'bg-red-50');
    showProposalNoBlock(b);
    renderAwardNoHint(b);
    renderTeamHrsHint(b);
    U.$('mProject').value = b.project || '';
    U.$('mPortal').value = b.portal || 'PlanHub';
    U.$('mRegion').value = b.region || '';
    setProducts(b.products);
    U.$('mMaterial').value = b.material || '';
    U.$('mEngineer').value = b.engineer || '';
    U.$('mPrice').value = b.price == null ? '' : b.price;
    U.$('mAssignedHrs').value = b.assignedHrs == null ? '' : b.assignedHrs;
    U.$('mEstHrs').value = b.estHrs == null ? '' : b.estHrs;
    U.setDateField('mDueDate', b.dueDate);
    populateStatusSelect(b.status || 'Not Started');
    U.$('mLink').value = b.link || '';
    U.$('mComments').value = b.comments || '';
    U.$('mPriceLocked').checked = !!b.priceLocked;
    U.$('bidModal').classList.remove('hidden');
  }

  /* ---- Product multi-select ------------------------------------------- */

  /* A bid can cover several products, so this is a chip list plus an "add"
     dropdown rather than a single select. Selection lives here while the modal
     is open and is written to the record on save. */
  var pickedProducts = [];

  function setProducts(list) {
    pickedProducts = (list || []).filter(Boolean).slice();
    renderProductPicker();
  }

  function selectedProducts() { return pickedProducts.slice(); }

  function renderProductPicker() {
    var chips = U.$('mProductChips');
    var sel = U.$('mProductAdd');
    if (!chips || !sel) return;
    var known = db().productTypes;

    chips.innerHTML = pickedProducts.length
      ? pickedProducts.map(function (p, i) {
          // Values carried over from before the managed list get a muted style
          // so it is obvious they are one-offs rather than list entries.
          var legacy = known.indexOf(p) < 0;
          return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ' +
            (legacy ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-blue-50 text-blue-700') +
            '" title="' + U.escAttr(p) + (legacy ? ' (entry from before the product list)' : '') + '">' +
            '<span class="max-w-[150px] truncate">' + U.esc(p) + '</span>' +
            '<button type="button" onclick="Bids.removeProduct(' + i + ')" ' +
            'class="hover:text-red-600 leading-none" aria-label="Remove">&times;</button></span>';
        }).join('')
      : '<span class="text-[11px] text-slate-400">No products selected</span>';

    var available = known.filter(function (p) { return pickedProducts.indexOf(p) < 0; });
    sel.innerHTML = '<option value="">+ Add product...</option>' +
      available.map(function (p) {
        return '<option value="' + U.escAttr(p) + '">' + U.esc(p) + '</option>';
      }).join('') +
      '<option value="__add">+ Add new product...</option>';
    sel.value = '';
  }

  /* Fires when the add-dropdown changes; intercepts the "+ Add new" sentinel. */
  function onProductChange(sel) {
    var val = sel.value;
    sel.value = '';                       // always return it to the prompt state
    if (!val) return;

    if (val !== '__add') {
      if (pickedProducts.indexOf(val) < 0) pickedProducts.push(val);
      renderProductPicker();
      return;
    }

    var name = prompt('Name for the new product type:', '');
    name = (name || '').trim();
    if (!name) { renderProductPicker(); return; }

    var d = db();
    var existing = d.productTypes.filter(function (p) {
      return p.toLowerCase() === name.toLowerCase();
    })[0];
    if (existing) {
      if (pickedProducts.indexOf(existing) < 0) {
        pickedProducts.push(existing);
        U.toast('"' + existing + '" was already in the list - selected it.', 'warn');
      } else {
        U.toast('"' + existing + '" is already selected.', 'warn');
      }
      renderProductPicker();
      return;
    }
    d.productTypes.push(name);
    pickedProducts.push(name);
    root.Store.save();
    renderProductPicker();
    U.toast('"' + name + '" added to the product list.', 'ok');
  }

  function removeProduct(i) {
    pickedProducts.splice(i, 1);
    renderProductPicker();
  }

  /* ---- engineers register ---------------------------------------------- */

  /* Bids store the engineer's initials. The register carries the full name so
     the table can stay narrow while still being readable on hover, and so
     "AF" and "A.F." do not become two people. Phase 2 links `userId` to an
     account and this list becomes the user list. */
  function engineers() { return db().engineers; }

  function findEngineer(initials) {
    var key = String(initials || '').trim().toLowerCase();
    if (!key) return null;
    return engineers().filter(function (e) {
      return e.initials.toLowerCase() === key;
    })[0] || null;
  }

  function engineerName(initials) {
    var e = findEngineer(initials);
    return e && e.name ? e.name : '';
  }

  function populateEngineerList() {
    var host = U.$('engineerOptions');
    if (!host) return;
    var list = engineers().filter(function (e) { return e.active !== false; })
      .slice().sort(function (a, b) { return a.initials.localeCompare(b.initials); });
    host.innerHTML = list.map(function (e) {
      return '<option value="' + U.escAttr(e.initials) + '">' +
        U.esc(e.name || '') + '</option>';
    }).join('');
  }

  /* Typing initials the register does not know offers to add them, rather than
     silently accepting a value that will never autofill again. */
  function onEngineerChange(input) {
    var v = input.value.trim();
    var hint = U.$('engineerHint');
    if (!v) { hint.innerHTML = ''; return; }
    var e = findEngineer(v);
    if (e) {
      input.value = e.initials;   // normalise casing to the register's
      hint.innerHTML = e.name
        ? '<span class="text-slate-500">' + U.esc(e.name) + '</span>'
        : '<span class="text-slate-400">In the register</span>';
      return;
    }
    hint.innerHTML = '<button type="button" onclick="Bids.addEngineerFromForm()" ' +
      'class="text-blue-600 hover:text-blue-800 font-medium">' +
      '<i class="fas fa-plus mr-1"></i>Add "' + U.esc(v) + '" to engineers</button>';
  }

  function addEngineer(initials, name) {
    var v = String(initials || '').trim();
    if (!v) return null;
    var existing = findEngineer(v);
    if (existing) return existing;
    var rec = {
      id: root.Store.uid('eng'), initials: v, name: String(name || '').trim(),
      active: true, userId: null
    };
    engineers().push(rec);
    root.Store.save();
    return rec;
  }

  function renderEngineerList() {
    var d = db();
    var host = U.$('engineerList');
    if (!host) return;
    var list = engineers().slice().sort(function (a, b) {
      return a.initials.localeCompare(b.initials);
    });
    host.innerHTML = list.length ? list.map(function (e) {
      var used = d.bids.filter(function (b) {
        return (b.engineer || '').toLowerCase() === e.initials.toLowerCase();
      }).length;
      return '<div class="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">' +
        '<input value="' + U.escAttr(e.initials) + '" onchange="Bids.updateEngineer(\'' + e.id + '\',\'initials\',this.value)" ' +
          'class="w-20 px-2 py-1 bg-white border border-slate-200 rounded text-sm font-semibold uppercase outline-none focus:border-blue-400">' +
        '<input value="' + U.escAttr(e.name) + '" placeholder="Full name (optional)" ' +
          'onchange="Bids.updateEngineer(\'' + e.id + '\',\'name\',this.value)" ' +
          'class="flex-1 px-2 py-1 bg-white border border-slate-200 rounded text-sm outline-none focus:border-blue-400">' +
        // An entry that belongs to an account is not free-standing: renaming
        // the initials here moves the link with it, and deleting it would
        // orphan somebody who can still sign in.
        (e.userId
          ? '<span title="Has an account - manage it under Settings &rsaquo; People" ' +
            'class="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">' +
            'account</span>'
          : '') +
        '<span class="text-xs text-slate-400 w-16 text-right">' + (used ? used + ' bid' + (used > 1 ? 's' : '') : '') + '</span>' +
        '<button onclick="Bids.removeEngineer(\'' + e.id + '\')" class="text-red-500 hover:text-red-700 text-xs"><i class="fas fa-trash"></i></button></div>';
    }).join('') : '<p class="text-sm text-slate-400 text-center py-6">No engineers yet.</p>';
  }

  /* The proposal number belongs to the bid and flows outward from it, so there
     is one place to change it. Without this, editing it on the bid would leave
     the old number printed on a document that had already been generated. */
  function pushProposalNo(bid) {
    var d = db();
    var t = bid.takeoffId ? d.takeoffs[bid.takeoffId] : null;
    if (t) t.project.proposalNo = bid.proposalNo || '';
    var p = bid.proposalId ? d.proposals[bid.proposalId] : null;
    if (p) p.proposalData.proposalNo = bid.proposalNo || '';
  }

  /* The proposal number is what identifies a project everywhere it appears -
     on the bid, its takeoff and the document that goes to the client - so two
     projects sharing one would make every one of those references ambiguous.
     Matched case- and space-insensitively, because "dis-p-1042 " and
     "DIS-P-1042" are the same number to everyone except a string compare. */
  function proposalNoOwner(value, exceptId) {
    var key = U.low(String(value || '').trim());
    if (!key) return null;                 // blank is not a duplicate
    return bids().filter(function (b) {
      return b.id !== exceptId && U.low(String(b.proposalNo || '').trim()) === key;
    })[0] || null;
  }

  function saveBid(e) {
    e.preventDefault();
    var d = db();
    var id = U.$('editId').value;
    var typed = U.$('mDueDate').value.trim();
    var due = U.readDateField('mDueDate');
    if (typed && !due) {
      U.$('mDueDate').classList.add('border-red-400', 'bg-red-50');
      U.$('mDueDate').focus();
      U.toast('Due date must be MM-DD-YYYY and a real date.', 'err');
      return;
    }

    var pnField = U.$('mProposalNo');
    var clash = proposalNoOwner(pnField.value, id ? Number(id) : null);
    if (clash) {
      pnField.classList.add('border-red-400', 'bg-red-50');
      pnField.focus();
      pnField.select();
      U.toast('Proposal No. "' + pnField.value.trim() + '" is already on "' +
        (clash.project || 'another bid') + '". It has to be unique.', 'err');
      return;
    }
    pnField.classList.remove('border-red-400', 'bg-red-50');

    var rec = {
      proposalNo: pnField.value.trim(),
      project: U.$('mProject').value.trim(),
      portal: U.$('mPortal').value,
      region: U.$('mRegion').value,
      products: selectedProducts(),
      material: U.$('mMaterial').value,
      engineer: U.$('mEngineer').value.trim(),
      price: U.$('mPrice').value === '' ? null : Number(U.$('mPrice').value),
      assignedHrs: U.n(U.$('mAssignedHrs').value),
      estHrs: U.n(U.$('mEstHrs').value),
      dueDate: due,
      status: U.$('mStatus').value,
      link: U.$('mLink').value.trim(),
      comments: U.$('mComments').value.trim(),
      priceLocked: U.$('mPriceLocked').checked,
      month: due ? U.parseDate(due).getMonth() : new Date().getMonth()
    };
    var saved;
    if (id) {
      var b = d.bids.filter(function (x) { return x.id === Number(id); })[0];
      Object.assign(b, rec);
      saved = b;
    } else {
      var nextId = d.bids.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
      var nextSr = d.bids.reduce(function (m, x) { return Math.max(m, Number(x.sr) || 0); }, 0) + 1;
      // No totalHrs: Estm and Asgn measure the same work two ways, so their sum
      // was never meaningful. The field stays on historical records - deleting
      // it from every bid would buy nothing - but nothing reads it any more.
      saved = Object.assign({
        id: nextId, sr: nextSr, inRegion: true, lf: null, bidHrs: 0,
        takeoffId: null, proposalId: null, awardNo: null, awardedAt: null,
        // Add Bid is how a received bid gets entered - that is intake, not a
        // decision to work it. "Add to Active bid" is the decision.
        active: false, activatedAt: null, decidedAt: null
      }, rec);
      d.bids.push(saved);
    }

    // The form can no longer produce Awarded, but an imported file can, and a
    // bid sitting in the Awarded list without a number would be worse than a
    // redundant check.
    var awarded = rec.status === 'Awarded' ? applyAward(saved) : null;
    pushProposalNo(saved);

    root.Store.save();
    closeModal();
    refresh();
    repaintProject();
    U.toast(awarded ? 'Bid saved and awarded as ' + awarded + '.' : 'Bid saved.', 'ok');
  }

  function closeModal() { U.$('bidModal').classList.add('hidden'); }

  function confirmDelete() {
    var d = db();
    var b = d.bids.filter(function (x) { return x.id === deleteTarget; })[0];
    if (b) {
      if (b.takeoffId) delete d.takeoffs[b.takeoffId];
      if (b.proposalId) delete d.proposals[b.proposalId];
      d.bids = d.bids.filter(function (x) { return x.id !== deleteTarget; });
    }
    root.Store.save();
    U.$('deleteModal').classList.add('hidden');
    refresh();
    U.toast('Bid deleted.', 'ok');
  }

  /* ---- export ---------------------------------------------------------- */

  function exportXLSX() {
    if (!root.XLSX) { U.toast('XLSX library did not load.', 'err'); return; }
    var d = db();
    var wb = root.XLSX.utils.book_new();

    // The two stages are separate columns here too, headed so a spreadsheet
    // reader can tell the intake guess from what the job actually took.
    root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.json_to_sheet(d.bids.map(function (b) {
      var t = root.Assign.totals(b);
      return {
        'Proposal No': b.proposalNo || '',
        'Job No': b.awardNo || '', 'Active': b.active ? 'Yes' : 'No',
        'Project': b.project, 'Portal': b.portal, 'Region': b.region,
        'In Region': b.inRegion === false ? 'No' : 'Yes',
        'Product': (b.products || []).join('; '),
        'Material': b.material, 'LF': b.lf, 'Bid Price': b.price,
        'Intake Engineer': b.engineer,
        'Intake Est Hrs': b.estHrs, 'Intake Assigned Hrs': b.assignedHrs,
        'Team': root.Assign.engineerList(b).join('; '),
        'Team Est Hrs': t.est, 'Team Assigned Hrs': t.asgn,
        'Due Date': b.dueDate, 'Status': b.status,
        'Link': b.link, 'Comments': b.comments
      };
    })), 'Bids');

    /* One row per engineer per task, so the hours can be pivoted by person or by
       task type - the question a summed column cannot answer. */
    var team = [];
    d.bids.forEach(function (b) {
      root.Assign.rows(b).forEach(function (r) {
        team.push({
          'Proposal No': b.proposalNo || '', 'Job No': b.awardNo || '', 'Project': b.project,
          'Status': b.status, 'Engineer': r.engineer, 'Description': r.taskType,
          'Est Hrs': U.n(r.estHrs), 'Assigned Hrs': U.n(r.asgnHrs)
        });
      });
    });
    if (team.length) {
      root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.json_to_sheet(team), 'Team Hours');
    }

    // One summary sheet per takeoff, mirroring Project Cost Summary.
    Object.keys(d.takeoffs).forEach(function (k) {
      var t = d.takeoffs[k];
      var roll = root.TakeoffModel.computeTakeoff(t);
      var aoa = [['Project Name', t.project.name], ['Location', t.project.location],
        ['Proposal No', t.project.proposalNo], ['Bid Due Date', t.project.bidDueDate], [],
        ['Project Cost Summary'], ['Product', 'Total Cost', 'Qty', 'U/M']];
      roll.products.forEach(function (x) {
        aoa.push([x.product.type, x.calc.total, x.product.totalLF, x.product.unit]);
      });
      aoa.push(['Project Base Cost', roll.base, roll.totalLF, 'LF']);
      aoa.push(['Miscellaneous Items Cost', roll.misc]);
      aoa.push(['Delivery & Freight Cost', roll.freight]);
      aoa.push(['Tax', roll.tax]);
      aoa.push(['Roundoff', roll.roundoff]);
      aoa.push(['Total Bid Cost', roll.total]);
      var name = (t.project.name || 'Takeoff').replace(/[\\\/\?\*\[\]:]/g, '').slice(0, 28);
      root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.aoa_to_sheet(aoa), name || 'Takeoff');
    });

    root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.json_to_sheet(
      root.Catalog.all().map(function (c) {
        return {
          Vendor: c.vendor, 'Part No': c.partNo, Description: c.description,
          Feature: c.feature, Material: c.material, Grade: c.grade, 'U/M': c.um,
          'Unit Cost': c.unitCost, 'Used On': c.sowTags.join('; '),
          'Times Used': c.useCount, Source: c.source
        };
      })), 'Rate Library');

    root.XLSX.writeFile(wb, 'Bid-Proposal-Manager-' + U.today() + '.xlsx');
  }

  /* ---- public ---------------------------------------------------------- */

  function refresh() {
    populateRegionSelects();
    filterTable();
    updateKPIs();
    renderMonthGrid();
  }

  root.Bids = {
    refresh: refresh,
    filterTable: filterTable,
    baseList: baseList,
    viewCount: viewCount,
    setView: setView,
    currentView: function () { return view; },
    // Cell renderers shared with js/bidgrid.js, which owns the table itself.
    productCell: productCell,
    engineerCell: engineerCell,
    teamCell: teamCell,
    statusBadge: statusBadge,
    actionCell: actionCell,
    renderCharts: renderCharts,
    updateKPIs: updateKPIs,
    renderMonthGrid: renderMonthGrid,
    populateRegionSelects: populateRegionSelects,
    // Drawn by js/settings.js, which supplies the hosts these write into.
    renderRegionList: renderRegionList,
    renderEngineerList: renderEngineerList,
    // Used by js/assignments.js so the team rows name people through the same
    // register the bid form does, rather than a second free-text field.
    findEngineer: findEngineer,
    addEngineer: addEngineer,
    populateEngineerList: populateEngineerList,

    STATUSES: STATUSES,
    bucketOf: bucketOf,
    onActiveOf: onActiveOf,
    settableStatuses: settableStatuses,

    nextAwardNo: nextAwardNo,
    applyAward: applyAward,
    applyLost: applyLost,
    promptDecision: promptDecision,
    confirmDecision: confirmDecision,
    closeDecisionModal: function () { U.$('decisionModal').classList.add('hidden'); },

    /* Opens the confirmation for one outcome, closing the menu it came from. */
    decide: function (id, outcome) {
      closeDecisionMenus();
      promptDecision(id, outcome);
    },
    toggleDecisionMenu: function (ev, id) {
      ev.stopPropagation();
      var el = U.$('decide-' + id);
      var wasOpen = el && !el.classList.contains('hidden');
      closeDecisionMenus();
      if (el && !wasOpen) el.classList.remove('hidden');
    },

    /* Every route into Active Bids goes through requestAddToActive so none of
       them can skip the duplicate-name check. `then` runs only if the bid was
       actually promoted - the project page uses it to follow the bid across. */
    addToActive: requestAddToActive,
    requestAddToActive: requestAddToActive,
    confirmAddToActive: confirmAddToActive,
    cancelAddToActive: cancelAddToActive,
    duplicateProjects: duplicateProjects,
    /* The raw promotion, without the check. Tests and migrations only. */
    promoteBid: addToActive,

    /* The month grid lives on the Dashboard now, so picking a month has to
       carry you to the list it filters. */
    selectMonth: function (m) {
      selectedMonth = selectedMonth === m ? null : m;
      renderMonthGrid();
      root.App.goToMonth(selectedMonth);
    },
    showAll: function () {
      selectedMonth = null;
      renderMonthGrid();
      root.App.goToMonth(null);
    },

    openAdd: openAdd,
    edit: edit,
    save: saveBid,
    onProductChange: onProductChange,
    removeProduct: removeProduct,
    setProducts: setProducts,
    selectedProducts: selectedProducts,
    closeModal: closeModal,
    promptDelete: function (id) {
      deleteTarget = id;
      U.$('deleteModal').classList.remove('hidden');
    },
    closeDeleteModal: function () { U.$('deleteModal').classList.add('hidden'); },
    confirmDelete: confirmDelete,

    /* Both registers moved to the Settings page. The openers stay as
       navigation so any caller that still asks for them lands somewhere
       sensible rather than throwing on a modal that no longer exists. */
    openEngineerModal: function () { root.App.switchTab('engineers'); },
    closeEngineerModal: function () {
      populateEngineerList();
      refresh();
    },
    addEngineerFromModal: function () {
      var i = U.$('newEngineerInitials'), n = U.$('newEngineerName');
      var v = i.value.trim();
      if (!v) return;
      if (findEngineer(v)) { U.toast('"' + v + '" is already in the register.', 'warn'); return; }
      addEngineer(v, n.value);
      i.value = ''; n.value = '';
      renderEngineerList();
      populateEngineerList();
    },
    addEngineerFromForm: function () {
      var input = U.$('mEngineer');
      var rec = addEngineer(input.value.trim(), '');
      if (!rec) return;
      populateEngineerList();
      onEngineerChange(input);
      U.toast('"' + rec.initials + '" added. Add their full name under Manage Engineers.', 'ok');
    },
    updateEngineer: function (id, field, value) {
      var e = engineers().filter(function (x) { return x.id === id; })[0];
      if (!e) return;
      var v = String(value || '').trim();
      if (field === 'initials') {
        if (!v) { renderEngineerList(); return; }
        var clash = findEngineer(v);
        if (clash && clash.id !== id) {
          U.toast('"' + v + '" is already used by another engineer.', 'warn');
          renderEngineerList();
          return;
        }
        // Carry the rename onto every bid that referenced the old initials,
        // otherwise those bids quietly lose their engineer.
        var old = e.initials;
        db().bids.forEach(function (b) {
          if ((b.engineer || '').toLowerCase() === old.toLowerCase()) b.engineer = v;
        });
      }
      e[field] = v;
      root.Store.save();
      renderEngineerList();
      refresh();
    },
    removeEngineer: function (id) {
      var e = engineers().filter(function (x) { return x.id === id; })[0];
      if (!e) return;
      var used = db().bids.filter(function (b) {
        return (b.engineer || '').toLowerCase() === e.initials.toLowerCase();
      }).length;
      if (used && !confirm(e.initials + ' is assigned to ' + used + ' bid(s).\n\n' +
        'Remove them from the register anyway? Those bids keep the initials but will ' +
        'no longer show a full name.')) return;
      db().engineers = engineers().filter(function (x) { return x.id !== id; });
      root.Store.save();
      renderEngineerList();
      populateEngineerList();
      refresh();
    },
    onEngineerChange: onEngineerChange,

    openRegionModal: function () { root.App.switchTab('regions'); },
    closeRegionModal: function () { populateRegionSelects(); },
    addRegion: function () {
      var input = U.$('newRegionName');
      var name = input.value.trim();
      if (!name) return;
      var d = db();
      if (d.regions.indexOf(name) >= 0) { U.toast('That region already exists.', 'warn'); return; }
      d.regions.push(name);
      input.value = '';
      root.Store.save();
      renderRegionList();
      populateRegionSelects();
    },
    removeRegion: function (name) {
      var d = db();
      var used = d.bids.filter(function (b) { return b.region === name; }).length;
      if (used && !confirm(name + ' is used by ' + used + ' bid(s).\nRemove it from the list anyway? Those bids keep the value.')) return;
      d.regions = d.regions.filter(function (r) { return r !== name; });
      root.Store.save();
      renderRegionList();
      populateRegionSelects();
    },

    exportXLSX: exportXLSX
  };

  document.addEventListener('click', closeDecisionMenus);
})(window);
