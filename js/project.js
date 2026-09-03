/* project.js - one project, full screen.
 *
 * Clicking a row in the bids table lands here. The page owns three tabs -
 * Overview, TakeOff and Proposal - and the last two are the existing modules
 * rendering into their existing hosts; this file only supplies the chrome
 * around them and the Overview page itself.
 *
 * The view is deliberately immersive (body.projectview hides the app header,
 * the module bar and the footer): while you are estimating one job, the other
 * five modules are noise, and the takeoff needs the width.
 *
 * MODE. The page reads differently depending on the stage the bid is at, which
 * is the list you reached it from:
 *
 *   'all'     the intake register. A record card and one action - pick this bid
 *             up. No job number, no estimate, no proposal: none of it exists
 *             yet, and offering it invites work on bids nobody has committed to.
 *   'active'  the workspace. TakeOff, Proposal, and the Award/Lost decision.
 *   'awarded' the same, on a job that is already won.
 */
(function (root) {
  'use strict';

  var U = root.U;

  /* returnTo remembers which bid list you came from, so Back does not always
     dump you on Active Bids after you opened a project from Awarded. */
  var state = { bidId: null, returnTo: 'active' };

  function db() { return root.Store.db; }

  function bidById(id) {
    return db().bids.filter(function (b) { return b.id === id; })[0] || null;
  }

  /* The project this page is about.

     Falls back to deriving it from whatever takeoff or proposal is open, so
     arriving by any other route - a restored session, a popped-out window, the
     takeoff picker - still shows the right header instead of an empty one.
     Derived rather than stored, so there is no second copy to fall out of sync. */
  function currentBid() {
    if (state.bidId != null) {
      var b = bidById(state.bidId);
      if (b) return b;
      state.bidId = null;             // the bid was deleted under us
    }
    var ui = db().ui;
    var t = ui.lastTakeoffId ? db().takeoffs[ui.lastTakeoffId] : null;
    if (t && t.bidId != null) {
      var byTakeoff = bidById(t.bidId);
      if (byTakeoff) return byTakeoff;
    }
    if (ui.lastProposalId) {
      var byProposal = db().bids.filter(function (b) {
        return b.proposalId === ui.lastProposalId;
      })[0];
      if (byProposal) return byProposal;
    }
    return null;
  }

  function setBid(id) {
    state.bidId = id;
    db().ui.projectBidId = id;
  }

  function open(id) {
    var view = root.Bids ? root.Bids.currentView() : 'active';
    // Only remember a real bid list; opening a project from inside another
    // project view must not make Back a no-op.
    openFrom(id, view === 'all' || view === 'active' || view === 'awarded' ? view : 'active');
  }

  /* The only way the mode changes, so a page can never be half-built: the
     header and the body always agree about which stage they are showing. */
  function openFrom(id, mode) {
    if (!bidById(id)) return;
    state.returnTo = mode;
    setBid(id);
    root.Store.save();
    root.App.switchTab('project');
  }

  /* Which stage this page is showing. Derived from the list you came from
     rather than stored: one fact, no second copy to fall out of step. */
  function mode() {
    return state.returnTo === 'all' ? 'all'
      : state.returnTo === 'awarded' ? 'awarded' : 'active';
  }

  /* In the intake stage there is no estimate and no proposal, so the tabs that
     open them are not offered. js/app.js asks before honouring a stale
     ?section=takeoff, which would otherwise land on a page with no way back. */
  function allowsSection(key) {
    return mode() !== 'all' || key === 'project';
  }

  /* ---- header ----------------------------------------------------------- */

  function tab(key, label, icon, on) {
    return '<button onclick="App.switchTab(\'' + key + '\')" ' +
      'class="px-4 py-2 rounded-lg text-sm whitespace-nowrap transition flex items-center gap-2 ' +
      (on ? 'bg-blue-600 text-white font-semibold shadow-lg shadow-blue-900/30'
          : 'text-slate-300 hover:text-white hover:bg-slate-700/60') + '">' +
      '<i class="fas ' + icon + ' text-xs"></i>' + U.esc(label) + '</button>';
  }

  function numberChip(bid) {
    // The job number is a fact about work in progress, so it stays out of the
    // intake stage even on a bid that happens to have one.
    if (bid.awardNo && mode() !== 'all') {
      return '<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[11px] font-mono font-semibold" ' +
        'title="Job number, issued when the bid was awarded">' + U.esc(bid.awardNo) + '</span>';
    }
    if (bid.proposalNo) {
      return '<span class="px-2 py-0.5 rounded bg-slate-700 text-slate-300 text-[11px] font-mono" ' +
        'title="Proposal number - unique to this project">' + U.esc(bid.proposalNo) + '</span>';
    }
    return '';
  }

  function renderHeader() {
    var host = U.$('projectHeader');
    if (!host) return;
    var bid = currentBid();
    var section = root.Nav.current.section;

    if (!bid) {
      host.innerHTML =
        '<div class="flex items-center gap-3">' +
          backButton() +
          '<span class="text-sm text-slate-400">No project selected</span>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          tab('takeoff', 'TakeOff', 'fa-calculator', section === 'takeoff') +
          tab('proposal', 'Proposal', 'fa-file-contract', section === 'proposal') +
        '</div>';
      return;
    }

    host.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
        backButton() +
        '<div class="min-w-0">' +
          '<div class="text-sm font-bold text-white truncate flex items-center gap-2">' +
            U.esc(bid.project || 'Untitled project') + numberChip(bid) + '</div>' +
          '<div class="text-[11px] text-slate-400 truncate flex items-center gap-2">' +
            U.esc(bid.region || 'No region') +
            '<span class="text-slate-600">&middot;</span>' +
            U.esc(bid.portal || '-') +
            '<span class="text-slate-600">&middot;</span>' +
            '<span class="font-mono text-slate-300">' + U.currency(bid.price) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex items-center gap-2 flex-wrap justify-end">' +
        (mode() === 'all'
          ? promoteAction(bid)
          : tab('project', 'Overview', 'fa-circle-info', section === 'project') +
            tab('takeoff', 'TakeOff', 'fa-calculator', section === 'takeoff') +
            tab('proposal', 'Proposal', 'fa-file-contract', section === 'proposal') +
            decisionMenu(bid)) +
        '<span id="saveIndicator" class="text-xs text-slate-400 ml-1"></span>' +
      '</div>';
  }

  /* The intake stage's one action. A bid that is already being worked is not
     offered promotion twice - it gets the way across to where the work is. */
  function promoteAction(bid) {
    if (bid.active && root.Bids.bucketOf(bid) === 'open') {
      return '<button onclick="Project.openInActive()" ' +
        'class="px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-2">' +
        '<i class="fas fa-bolt text-xs"></i>Open in Active Bids' +
        '<i class="fas fa-arrow-up-right-from-square text-[10px] opacity-70"></i></button>';
    }
    return '<button onclick="Project.addToActive()" ' +
      'class="px-3 py-2 rounded-lg text-sm font-medium bg-amber-500 hover:bg-amber-400 text-white flex items-center gap-2">' +
      '<i class="fas fa-bolt text-xs"></i>Add to Active bid</button>';
  }

  function backButton() {
    return '<button onclick="Project.close()" title="Back to the bid list" ' +
      'class="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium flex items-center gap-2 shrink-0">' +
      '<i class="fas fa-arrow-left"></i>Bids</button>';
  }

  /* Award and Lost are the two ways a bid stops being worked. They sit behind
     one control because they are one decision, and each has its own
     confirmation because both are hard to walk back. */
  function decisionMenu(bid) {
    if (root.Bids.bucketOf(bid) !== 'open') return '';
    if (!root.Auth.can('bid.award')) return '';
    return '<span class="relative inline-flex">' +
      '<button onclick="Project.toggleDecisionMenu(event)" title="Award or mark this bid lost" ' +
        'class="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-2">' +
        '<i class="fas fa-trophy text-xs"></i>Award<i class="fas fa-chevron-down text-[9px] opacity-70"></i></button>' +
      '<span id="projectDecideMenu" class="hidden absolute right-0 top-11 z-30 bg-white border border-slate-200 rounded-lg shadow-xl py-1 w-44 text-left">' +
        item('Awarded', 'fa-trophy', 'Award', 'text-emerald-700') +
        item('Lost', 'fa-xmark', 'Mark Lost', 'text-red-600') +
      '</span></span>';

    function item(outcome, icon, label, cls) {
      return '<button onclick="Project.decide(\'' + outcome + '\')" ' +
        'class="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 ' + cls + '">' +
        '<i class="fas ' + icon + ' w-4 mr-1.5"></i>' + label + '</button>';
    }
  }

  function closeDecisionMenu() {
    var el = U.$('projectDecideMenu');
    if (el) el.classList.add('hidden');
  }

  /* ---- overview --------------------------------------------------------- */

  function card(title, icon, body, action) {
    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">' +
      '<div class="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">' +
        '<h3 class="text-sm font-bold text-slate-700 flex items-center gap-2">' +
          '<i class="fas ' + icon + ' text-slate-400"></i>' + U.esc(title) + '</h3>' +
        (action || '') +
      '</div>' +
      '<div class="p-5">' + body + '</div></div>';
  }

  function field(label, value) {
    return '<div class="min-w-0">' +
      '<div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">' + U.esc(label) + '</div>' +
      '<div class="text-sm text-slate-800 break-words">' + (value || '<span class="text-slate-300">&mdash;</span>') + '</div>' +
    '</div>';
  }

  /* Intake shows the first-pass guess; the working stages show what the team
     has actually booked, which comes from Assign.totals so this figure and the
     Team & Hours card below it are the same number. */
  /* Two figures, never three. Estm and Asgn measure the same work from two
     sides, so a total that adds them counts the job twice - see Assign.totals. */
  function hoursField(bid) {
    function pair(est, asgn) {
      return '<span class="font-mono">' + U.qty(est) + '</span> estm &middot; ' +
        '<span class="font-mono">' + U.qty(asgn) + '</span> asgn';
    }
    if (mode() === 'all') {
      return field('First-pass Hrs', pair(U.n(bid.estHrs), U.n(bid.assignedHrs)));
    }
    var t = root.Assign.totals(bid);
    if (!t.count) {
      return field('Hours', '<span class="text-slate-400 text-xs">Nobody booked yet</span>');
    }
    return field('Hours', pair(t.est, t.asgn));
  }

  function detailsCard(bid) {
    // The proposal number is the project's identity, so it leads. The job
    // number only exists once the bid is won, so it is not shown at intake
    // where it would only ever be an em-dash.
    var numbers = field('Proposal No.', bid.proposalNo
        ? '<span class="font-mono font-semibold">' + U.esc(bid.proposalNo) + '</span>' : '') +
      (mode() === 'all' ? ''
        : field('Job No.', bid.awardNo
            ? '<span class="font-mono font-semibold text-emerald-700">' + U.esc(bid.awardNo) + '</span>' : ''));

    var body = '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
      numbers +
      field('Status', root.Bids.statusBadge(bid.status)) +
      field('Due Date', U.date(bid.dueDate) === '-' ? '' : U.date(bid.dueDate)) +
      field('Portal', U.esc(bid.portal)) +
      field('Region', U.esc(bid.region) +
        (bid.inRegion === false ? '<span class="block text-[10px] text-amber-600">out of region</span>' : '')) +
      field('Material', U.esc(bid.material)) +
      // Which stage's people and hours, matching the columns on the list you
      // came from. Intake is the first pass; the team is who actually worked it.
      (mode() === 'all'
        ? field('Engineer', root.Bids.engineerCell(bid)) : field('Team', root.Bids.teamCell(bid))) +
      field('Product', root.Bids.productCell(bid, 6)) +
      field('Linear Feet', bid.lf == null ? '' : '<span class="font-mono">' + U.qty(bid.lf) + '</span>') +
      field('Bid Price', '<span class="font-mono font-semibold">' + U.currency(bid.price) + '</span>' +
        (bid.priceLocked ? ' <i class="fas fa-lock text-[10px] text-amber-500" title="Locked - a takeoff will not overwrite this"></i>' : '')) +
      hoursField(bid) +
      '</div>' +
      (bid.link || bid.comments
        ? '<div class="mt-5 pt-5 border-t border-slate-100 space-y-4">' +
            (bid.link ? field('Platform Link',
              '<a href="' + U.escAttr(bid.link) + '" target="_blank" rel="noopener" ' +
              'class="text-blue-600 hover:text-blue-800 break-all">' + U.esc(bid.link) +
              ' <i class="fas fa-external-link-alt text-[10px]"></i></a>') : '') +
            (bid.comments ? field('Comments', U.esc(bid.comments)) : '') +
          '</div>'
        : '');

    return card('Project Details', 'fa-circle-info', body,
      root.Auth.can('bid.edit')
        ? '<button onclick="Bids.edit(' + bid.id + ')" ' +
          'class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-pen"></i>Edit</button>'
        : '');
  }

  function estimateCard(bid) {
    var t = bid.takeoffId ? db().takeoffs[bid.takeoffId] : null;
    var openBtn = '<button onclick="Takeoff.openForBid(' + bid.id + ')" ' +
      'class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ' +
      (t ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
         : 'bg-blue-600 hover:bg-blue-500 text-white') + '">' +
      '<i class="fas fa-calculator"></i>' + (t ? 'Open TakeOff' : 'Start takeoff') + '</button>';

    if (!t) {
      return card('Estimate', 'fa-calculator',
        '<p class="text-sm text-slate-400">No takeoff yet. Starting one creates the estimating ' +
        'workbook for this project; its total flows back into Bid Price and LF.</p>', openBtn);
    }

    var roll = root.TakeoffModel.computeTakeoff(t);
    var body = '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
      field('Total Bid Cost', '<span class="font-mono font-bold text-lg text-slate-800">' +
        U.currency2(roll.total) + '</span>') +
      field('Products', String(t.products.length)) +
      field('Total LF', '<span class="font-mono">' + U.qty(roll.totalLF) + '</span>') +
      field('Last edited', t.updatedAt ? U.date(t.updatedAt.slice(0, 10)) : '') +
      '</div>' +
      (t.products.length
        ? '<div class="mt-5 pt-4 border-t border-slate-100 space-y-1.5">' +
            roll.products.map(function (x) {
              return '<div class="flex items-baseline justify-between gap-3 text-sm">' +
                '<span class="text-slate-600 truncate">' + U.esc(x.product.type) + '</span>' +
                '<span class="font-mono text-slate-700 whitespace-nowrap">' + U.currency2(x.calc.total) + '</span></div>';
            }).join('') +
          '</div>'
        : '');
    return card('Estimate', 'fa-calculator', body, openBtn);
  }

  function proposalCard(bid) {
    var p = bid.proposalId ? db().proposals[bid.proposalId] : null;
    var hasT = !!(bid.takeoffId && db().takeoffs[bid.takeoffId]);

    if (!p) {
      return card('Proposal', 'fa-file-contract',
        '<p class="text-sm text-slate-400">' + (hasT
          ? 'No proposal yet. Generating one turns the takeoff into the client-facing document.'
          : 'Start a takeoff first &mdash; a proposal is generated from one.') + '</p>',
        hasT ? '<button onclick="Proposal.generateFromTakeoff(\'' + bid.takeoffId + '\')" ' +
          'class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-file-contract"></i>Generate</button>' : '');
    }

    var stale = root.Proposal.isStale(p);
    var body =
      (stale
        ? '<div class="mb-4 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-2">' +
            '<i class="fas fa-triangle-exclamation text-amber-500 text-xs"></i>' +
            '<span class="flex-1 text-[11px] text-amber-900 leading-snug">The takeoff has changed since ' +
              'this proposal was generated.</span>' +
            '<button onclick="Proposal.generateFromTakeoff(\'' + p.takeoffId + '\')" ' +
              'class="px-2.5 py-1 rounded text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white whitespace-nowrap">' +
              'Regenerate</button></div>'
        : '') +
      '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
        field('Proposal Total', '<span class="font-mono font-bold text-lg text-slate-800">' +
          U.currency(root.Proposal.total(p)) + '</span>') +
        field('Scope Items', String((p.scopeItems || []).length)) +
        field('Proposal No.', U.esc(p.proposalData.proposalNo)) +
        field('Generated', p.generatedAt ? U.date(p.generatedAt.slice(0, 10)) : '') +
      '</div>';

    return card('Proposal', 'fa-file-contract', body,
      '<button onclick="Proposal.open(\'' + p.id + '\')" ' +
      'class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
      '<i class="fas fa-file-contract"></i>Open Proposal</button>');
  }

  function render() {
    var host = U.$('section-project');
    if (!host || host.classList.contains('hidden')) return;
    var bid = currentBid();

    if (!bid) {
      host.innerHTML =
        '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-16 text-center">' +
          '<div class="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">' +
            '<i class="fas fa-diagram-project text-2xl text-slate-400"></i></div>' +
          '<h3 class="text-lg font-bold text-slate-800 mb-1">No project selected</h3>' +
          '<p class="text-sm text-slate-500 mb-5">Pick a bid from the list to see everything on it.</p>' +
          '<button onclick="Project.close()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold">' +
            'Back to bids</button>' +
        '</div>';
      return;
    }

    host.innerHTML =
      '<div class="space-y-6">' +
        detailsCard(bid) +
        // Intake shows the record and nothing else: there is no estimate and no
        // proposal until somebody picks the bid up, and offering them here
        // invites work on bids nobody has committed to.
        (mode() === 'all'
          ? intakeCard(bid)
          : root.Assign.card(bid) +
            '<div class="grid grid-cols-1 xl:grid-cols-2 gap-6">' +
              estimateCard(bid) + proposalCard(bid) +
            '</div>') +
      '</div>';

    // The team rows autocomplete off the shared #engineerOptions datalist, so
    // it has to be populated once the card is on screen.
    if (mode() !== 'all') root.Bids.populateEngineerList();
  }

  function intakeCard(bid) {
    var live = bid.active && root.Bids.bucketOf(bid) === 'open';
    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">' +
      '<div class="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4">' +
        '<i class="fas fa-bolt text-xl text-amber-500"></i></div>' +
      '<h3 class="text-base font-bold text-slate-800 mb-1">' +
        (live ? 'This bid is being worked' : 'Not picked up yet') + '</h3>' +
      '<p class="text-sm text-slate-500 max-w-md mx-auto mb-5">' + (live
        ? 'It is on the Active Bids list, where its takeoff, proposal and award decision live.'
        : 'All Bids is the register of everything received. Add this one to Active Bids to start ' +
          'its takeoff and proposal.') + '</p>' +
      (live
        ? '<button onclick="Project.openInActive()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold">' +
          '<i class="fas fa-bolt mr-1.5"></i>Open in Active Bids</button>'
        : '<button onclick="Project.addToActive()" class="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-lg text-sm font-semibold">' +
          '<i class="fas fa-bolt mr-1.5"></i>Add to Active bid</button>') +
    '</div>';
  }

  root.Project = {
    open: open,
    openFrom: openFrom,
    setBid: setBid,
    currentBid: currentBid,
    mode: mode,
    allowsSection: allowsSection,
    render: render,
    renderHeader: renderHeader,
    close: function () { root.App.switchTab(state.returnTo || 'active'); },

    /* Promotion, from either the header button or the intake card. Goes through
       Bids so the duplicate-project-name check cannot be bypassed here; the
       callback runs only once the bid has actually been promoted, which may be
       after the warning has been confirmed. */
    addToActive: function () {
      var bid = currentBid();
      if (!bid) return;
      root.Bids.addToActive(bid.id, function (b) {
        // Straight through to the work, which is what you pressed it for.
        openFrom(b.id, 'active');
      });
    },

    openInActive: function () {
      var bid = currentBid();
      if (bid) openFrom(bid.id, 'active');
    },

    toggleDecisionMenu: function (ev) {
      ev.stopPropagation();
      var el = U.$('projectDecideMenu');
      if (el) el.classList.toggle('hidden');
    },
    decide: function (outcome) {
      closeDecisionMenu();
      var bid = currentBid();
      if (bid) root.Bids.promptDecision(bid.id, outcome);
    }
  };

  document.addEventListener('click', closeDecisionMenu);
})(window);
