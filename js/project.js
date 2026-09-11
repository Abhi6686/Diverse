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
      (on ? 'bg-brand text-white font-semibold shadow-lg shadow-brand/25'
          : 'text-faint hover:text-white hover:bg-chrome-soft/60') + '">' +
      '<i class="fas ' + icon + ' text-xs"></i>' + U.esc(label) + '</button>';
  }

  function numberChip(bid) {
    // The job number is a fact about work in progress, so it stays out of the
    // intake stage even on a bid that happens to have one.
    if (bid.awardNo && mode() !== 'all') {
      return '<span class="px-2 py-0.5 rounded bg-ok/15 text-ok-ink text-2xs font-mono font-semibold" ' +
        'title="Job number, issued when the bid was awarded">' + U.esc(bid.awardNo) + '</span>';
    }
    if (bid.proposalNo) {
      return '<span class="px-2 py-0.5 rounded bg-chrome-soft text-faint text-2xs font-mono" ' +
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
          '<span class="text-sm text-faint">No project selected</span>' +
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
            U.esc(bid.project || 'Untitled project') + numberChip(bid) +
            // Who else has this open right now - see js/presence.js. Empty
            // string when it is only you, or when there is no server.
            (root.Presence ? root.Presence.headerChip(bid.id) : '') + '</div>' +
          '<div class="text-2xs text-faint truncate flex items-center gap-2">' +
            U.esc(bid.region || 'No region') +
            '<span class="text-muted">&middot;</span>' +
            U.esc(bid.portal || '-') +
            '<span class="text-muted">&middot;</span>' +
            '<span class="font-mono text-faint">' + U.currency(bid.price) + '</span>' +
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
        '<span id="saveIndicator" class="text-xs text-faint ml-1"></span>' +
      '</div>';
  }

  /* The intake stage's one action. A bid that is already being worked is not
     offered promotion twice - it gets the way across to where the work is. */
  function promoteAction(bid) {
    if (bid.active && root.Bids.bucketOf(bid) === 'open') {
      return '<button onclick="Project.openInActive()" ' +
        'class="px-3 py-2 rounded-lg text-sm font-medium bg-brand hover:bg-brand-hover text-white flex items-center gap-2">' +
        '<i class="fas fa-bolt text-xs"></i>Open in Active Bids' +
        '<i class="fas fa-arrow-up-right-from-square text-3xs opacity-70"></i></button>';
    }
    return '<button onclick="Project.addToActive()" ' +
      'class="px-3 py-2 rounded-lg text-sm font-medium bg-warn hover:bg-warn-hover text-white flex items-center gap-2">' +
      '<i class="fas fa-bolt text-xs"></i>Add to Active bid</button>';
  }

  function backButton() {
    return '<button onclick="Project.close()" title="Back to the bid list" ' +
      'class="px-2.5 py-1.5 bg-chrome-soft hover:bg-chrome-soft/70 text-white rounded-lg text-xs font-medium flex items-center gap-2 shrink-0">' +
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
        'class="px-3 py-2 rounded-lg text-sm font-medium bg-ok hover:bg-ok-hover text-white flex items-center gap-2">' +
        '<i class="fas fa-trophy text-xs"></i>Award<i class="fas fa-chevron-down text-3xs opacity-70"></i></button>' +
      '<span id="projectDecideMenu" class="hidden absolute right-0 top-11 z-30 bg-surface border border-line rounded-lg shadow-xl py-1 w-44 text-left">' +
        item('Awarded', 'fa-trophy', 'Award', 'text-ok-ink') +
        item('Lost', 'fa-xmark', 'Mark Lost', 'text-danger') +
      '</span></span>';

    function item(outcome, icon, label, cls) {
      return '<button onclick="Project.decide(\'' + outcome + '\')" ' +
        'class="w-full text-left px-3 py-2 text-xs hover:bg-raised ' + cls + '">' +
        '<i class="fas ' + icon + ' w-4 mr-1.5"></i>' + label + '</button>';
    }
  }

  function closeDecisionMenu() {
    var el = U.$('projectDecideMenu');
    if (el) el.classList.add('hidden');
  }

  /* ---- overview --------------------------------------------------------- */

  /* The card shell and the labelled value both live in js/ui.js now - this page
     is where they were first written, and Settings and the module placeholders
     had each grown their own slightly different copy. Kept as local names so
     the twenty call sites below read as they did. */
  function card(title, icon, body, action) {
    return root.UI.card({ title: title, icon: icon, body: body, action: action });
  }

  function field(label, value) {
    return root.UI.field(label, value);
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
      return field('Hours', '<span class="text-faint text-xs">Nobody booked yet</span>');
    }
    return field('Hours', pair(t.est, t.asgn));
  }

  /* TWO DATES, EACH SHOWN AS ITSELF.

     Due Date is the date the enquiry came in with. Revised Due is what the
     client moved it to. Both are facts and both are kept, so each field shows
     its own value plainly - the Due Date box is the due date, not a derived
     "whichever is in force" with the original crossed out beside it. That
     reading was wrong twice over: it put a value in the Due Date field that was
     not bid.dueDate, and striking the original through said it had been
     cancelled when it is the date on the record.

     Which one the app WORKS to is a separate question, answered in one place by
     Bids.effectiveDueDate - the revised one when there is one. That is what the
     bids table sorts on, what the dashboard files the month by, what the
     Needs-attention list counts down to, and what the Employee schedule flags.
     A note under Revised Due says so, rather than leaving it to be inferred. */
  function dueDateValue(bid) {
    return bid.dueDate ? U.esc(U.date(bid.dueDate)) : '';
  }

  function revisedDueValue(bid) {
    var revised = String(bid.revisedDueDate || '').trim();
    if (!revised) return '';
    return U.esc(U.date(revised)) +
      '<span class="ml-2 text-2xs text-warn-ink">in force</span>';
  }

  /* WHAT IS EDITABLE HERE, AND WHAT IS NOT.

     Anything somebody types is editable in place: double-click it and it
     becomes the right control. Anything the app works out for itself is not -
     the hours come from the Team & Hours rows, the products and materials from
     the Products & Materials card, the linear feet from the takeoff. Making
     those look editable would invite an edit the next recalculation silently
     throws away.

     Withheld entirely without bid.edit, so a read-only role does not get a
     control that would be refused on save. */
  function edit(label, display, spec) {
    if (!root.Auth.can('bid.edit')) return field(label, display);
    spec.bidId = currentBidId();
    return root.UI.editableField(label, display, spec);
  }

  function currentBidId() {
    var b = currentBid();
    return b ? b.id : null;
  }

  function detailsCard(bid) {
    var d = db();

    var body = '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
      // The project number is its identity, so it leads. It is issued when the
      // bid is picked up, which is why it is absent at intake - and editable,
      // because a number sometimes has to be made to match one already sent.
      (mode() === 'all'
        ? field('Proposal No.', '<span class="text-faint text-xs">Issued when picked up</span>')
        : edit('Proposal No.',
            bid.proposalNo ? '<span class="font-mono font-semibold">' + U.esc(bid.proposalNo) + '</span>' : '',
            { field: 'proposalNo', type: 'text', value: bid.proposalNo || '' })) +
      edit('Status', root.Bids.statusBadge(bid.status),
        { field: 'status', type: 'select', value: bid.status,
          options: root.Bids.settableStatuses().map(function (s) { return s.key; }) }) +
      edit('Due Date', dueDateValue(bid),
        { field: 'dueDate', type: 'date', value: bid.dueDate || '' }) +
      edit('Revised Due', revisedDueValue(bid),
        { field: 'revisedDueDate', type: 'date', value: bid.revisedDueDate || '' }) +
      edit('Portal', U.esc(bid.portal),
        { field: 'portal', type: 'select', value: bid.portal,
          options: ['PlanHub', 'ConstructConnect', 'BuildingConnected', 'PennBid', 'SmartBid', 'Other'] }) +
      edit('Region', U.esc(bid.region) +
        (bid.inRegion === false ? '<span class="block text-3xs text-warn">out of region</span>' : ''),
        { field: 'region', type: 'select', value: bid.region,
          options: (d.regions || []).slice().sort() }) +
      // Derived from the Products & Materials card below, so read-only here.
      field('Material', U.esc(bid.material)) +
      // Which stage's people and hours, matching the columns on the list you
      // came from. Intake is the first pass; the team is who actually worked it.
      (mode() === 'all'
        ? field('Engineer', root.Bids.engineerCell(bid)) : field('Team', root.Bids.teamCell(bid))) +
      field('Product', root.Bids.productCell(bid, 6)) +
      field('Linear Feet', bid.lf == null ? '' : '<span class="font-mono">' + U.qty(bid.lf) + '</span>') +
      edit('Bid Price', '<span class="font-mono font-semibold">' + U.currency(bid.price) + '</span>' +
        (bid.priceLocked ? ' <i class="fas fa-lock text-3xs text-warn" title="Locked - a takeoff will not overwrite this"></i>' : ''),
        { field: 'price', type: 'number', value: bid.price == null ? '' : bid.price }) +
      hoursField(bid) +
      '</div>' +
      '<div class="mt-5 pt-5 border-t border-line space-y-4">' +
        /* Through U.safeUrl, not straight into the href: this is a field
           somebody types, and escaping the quotes does nothing about a
           `javascript:` scheme. A link that is not a web address is still shown
           - it is what they typed and they may be mid-edit - just not as
           something clickable. */
        edit('Platform Link',
          U.safeUrl(bid.link)
            ? '<a href="' + U.escAttr(U.safeUrl(bid.link)) + '" target="_blank" rel="noopener noreferrer" ' +
              'onclick="event.stopPropagation()" ' +
              'class="text-brand hover:text-brand-ink break-all">' + U.esc(bid.link) +
              ' <i class="fas fa-external-link-alt text-3xs"></i></a>'
            : bid.link
              ? '<span class="text-muted break-all" title="Not a web link - it has to start with https://">' +
                U.esc(bid.link) + '</span>'
              : '',
          { field: 'link', type: 'text', value: bid.link || '' }) +
        edit('Comments', U.esc(bid.comments),
          { field: 'comments', type: 'textarea', value: bid.comments || '' }) +
      '</div>';

    return card('Project Details', 'fa-circle-info', body,
      root.Auth.can('bid.edit')
        ? '<button onclick="Bids.edit(' + bid.id + ')" ' +
          'class="px-3 py-1.5 bg-brand-soft hover:bg-brand-soft/60 text-brand-ink rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-pen"></i>Edit</button>'
        : '');
  }

  function estimateCard(bid) {
    var t = bid.takeoffId ? db().takeoffs[bid.takeoffId] : null;
    var openBtn = '<button onclick="Takeoff.openForBid(' + bid.id + ')" ' +
      'class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ' +
      (t ? 'bg-ok-soft hover:bg-ok-soft/60 text-ok-ink'
         : 'bg-brand hover:bg-brand-hover text-white') + '">' +
      '<i class="fas fa-calculator"></i>' + (t ? 'Open TakeOff' : 'Start takeoff') + '</button>';

    if (!t) {
      return card('Estimate', 'fa-calculator',
        '<p class="text-sm text-faint">No takeoff yet. Starting one creates the estimating ' +
        'workbook for this project; its total flows back into Bid Price and LF.</p>', openBtn);
    }

    var roll = root.TakeoffModel.computeTakeoff(t);
    var body = '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
      field('Total Bid Cost', '<span class="font-mono font-bold text-lg text-ink-strong">' +
        U.currency2(roll.total) + '</span>') +
      field('Products', String(t.products.length)) +
      field('Total LF', '<span class="font-mono">' + U.qty(roll.totalLF) + '</span>') +
      field('Last edited', t.updatedAt ? U.esc(U.stamp(t.updatedAt)) : '') +
      '</div>' +
      (t.products.length
        ? '<div class="mt-5 pt-4 border-t border-line space-y-1.5">' +
            roll.products.map(function (x) {
              return '<div class="flex items-baseline justify-between gap-3 text-sm">' +
                '<span class="text-muted truncate">' + U.esc(x.product.type) + '</span>' +
                '<span class="font-mono text-ink whitespace-nowrap">' + U.currency2(x.calc.total) + '</span></div>';
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
        '<p class="text-sm text-faint">' + (hasT
          ? 'No proposal yet. Generating one turns the takeoff into the client-facing document.'
          : 'Start a takeoff first &mdash; a proposal is generated from one.') + '</p>',
        hasT ? '<button onclick="Proposal.generateFromTakeoff(\'' + bid.takeoffId + '\')" ' +
          'class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-file-contract"></i>Generate</button>' : '');
    }

    var stale = root.Proposal.isStale(p);
    var body =
      (stale
        ? '<div class="mb-4 px-3 py-2.5 rounded-lg bg-warn-soft border border-warn/30 flex items-center gap-2">' +
            '<i class="fas fa-triangle-exclamation text-warn text-xs"></i>' +
            '<span class="flex-1 text-2xs text-warn-ink leading-snug">The takeoff has changed since ' +
              'this proposal was generated.</span>' +
            '<button onclick="Proposal.generateFromTakeoff(\'' + p.takeoffId + '\')" ' +
              'class="px-2.5 py-1 rounded text-2xs font-semibold bg-warn hover:bg-warn-hover text-white whitespace-nowrap">' +
              'Regenerate</button></div>'
        : '') +
      '<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">' +
        field('Proposal Total', '<span class="font-mono font-bold text-lg text-ink-strong">' +
          U.currency(root.Proposal.total(p)) + '</span>') +
        field('Scope Items', String((p.scopeItems || []).length)) +
        field('Proposal No.', U.esc(p.proposalData.proposalNo)) +
        field('Generated', p.generatedAt ? U.esc(U.stamp(p.generatedAt)) : '') +
      '</div>';

    return card('Proposal', 'fa-file-contract', body,
      '<button onclick="Proposal.open(\'' + p.id + '\')" ' +
      'class="px-3 py-1.5 bg-info-soft hover:bg-info-soft/60 text-info-ink rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
      '<i class="fas fa-file-contract"></i>Open Proposal</button>');
  }

  function render() {
    var host = U.$('section-project');
    if (!host || host.classList.contains('hidden')) return;
    var bid = currentBid();

    if (!bid) {
      host.innerHTML = root.UI.emptyCard({
        icon: 'fa-diagram-project',
        title: 'No project selected',
        blurb: 'Pick a bid from the list to see everything on it.',
        action: root.UI.btn({ label: 'Back to bids', onclick: 'Project.close()' })
      });
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
          : '<div class="grid grid-cols-1 xl:grid-cols-2 gap-6">' +
              root.Products.card(bid) + root.Assign.card(bid) +
            '</div>' +
            '<div class="grid grid-cols-1 xl:grid-cols-2 gap-6">' +
              estimateCard(bid) + proposalCard(bid) +
            '</div>' +
            root.History.card(bid)) +
      '</div>';

    // The team rows autocomplete off the shared #engineerOptions datalist, and
    // each one's start date is a hand-rolled date field - both need the card to
    // be on screen before they can be wired up.
    if (mode() !== 'all') {
      root.Bids.populateEngineerList();
      root.Assign.wire(bid);
    }
  }

  function intakeCard(bid) {
    var live = bid.active && root.Bids.bucketOf(bid) === 'open';
    return root.UI.emptyCard({
      icon: 'fa-bolt',
      title: live ? 'This bid is being worked' : 'Not picked up yet',
      blurb: live
        ? 'It is on the Active Bids list, where its takeoff, proposal and award decision live.'
        : 'All Bids is the register of everything received. Add this one to Active Bids to start ' +
          'its takeoff and proposal.',
      action: live
        ? root.UI.btn({ label: 'Open in Active Bids', icon: 'fa-bolt',
                        onclick: 'Project.openInActive()', size: 'lg' })
        : root.UI.btn({ label: 'Add to Active bid', icon: 'fa-bolt', tone: 'warn',
                        onclick: 'Project.addToActive()', size: 'lg' })
    });
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
