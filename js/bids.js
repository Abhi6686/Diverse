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
    { key: 'Lost',                badge: 'status-lost',       bucket: 'closed', settable: false, onActive: true },
    /* A job the client has brought back. Not settable, for the same reason
       Awarded and Lost are not: reaching it does bookkeeping - it opens a fresh
       revision entry and numbers it - so it is the outcome of an action rather
       than a word you type into a dropdown. Open and on Active Bids, because a
       re-opened job is live work again. */
    { key: 'ReOpen',              badge: 'status-reopen',     bucket: 'open',   settable: false, onActive: true }
  ];

  /* WHICH JOBS CAN BE RE-OPENED.
     Only the two that are finished without having been decided: work we
     completed, and work we looked at and found nothing in scope for. An
     Awarded job is not re-opened, it is a job; a Lost one was decided against
     and re-bidding it is a new enquiry. */
  var REOPENABLE = ['Completed', 'No Scope'];

  /* THE SEVEN ABOVE ARE THE LIFECYCLE. THE SHOP CAN ADD STAGES BESIDE THEM.
   *
   * db.statuses holds what an office has added - "On Hold", "Waiting on
   * drawings" - as { name, tone }. They are deliberately less powerful than the
   * seven: every one of them is open work that stays on Active Bids and can be
   * chosen on the form, and none of them can be made to mean won, lost or
   * closed. Those three answers already have statuses, and they are wired to
   * the award decision, the job number and the hit rate on the dashboard - a
   * second way to spell "we lost it" would be a second set of figures.
   *
   * Which is also why the seven are not editable. Renaming Awarded would leave
   * the decision that issues it pointing at a status nothing is filed under.
   *
   * Read through allStatuses() rather than from STATUSES directly, so a custom
   * stage reaches the form, the filters, the badges and the counts at once.
   */
  var TONES = {
    neutral: 'status-tone-neutral', brand: 'status-tone-brand',
    warn:    'status-tone-warn',    ok:    'status-tone-ok',
    danger:  'status-tone-danger',  info:  'status-tone-info'
  };

  function customStatuses() {
    var list = db().statuses;
    return Array.isArray(list) ? list : [];
  }

  function allStatuses() {
    return STATUSES.concat(customStatuses().map(function (s) {
      return {
        key: s.name,
        badge: TONES[s.tone] || TONES.neutral,
        bucket: 'open', settable: true, onActive: true,
        custom: true, tone: s.tone || 'neutral'
      };
    }));
  }

  function statusOf(key) {
    var all = allStatuses();
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
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
    return allStatuses().filter(function (s) { return s.settable; });
  }

  /* The pill is UI.badge, which does not wrap. "Submitted to Review" used to
     break over two lines and make its row taller than the ones around it, which
     is what gave the table its ragged left-to-right rhythm. */
  function statusBadge(status) {
    var s = statusOf(status);
    return root.UI.badge(status || 'Not Started', s ? s.badge : 'status-notstarted');
  }

  /* ---- shared bits ----------------------------------------------------- */

  /* Products as chips, capped so one bid with six of them cannot blow the row
     height out. The title attribute carries the full list. */
  function productCell(bid, max) {
    var list = (bid.products || []).filter(Boolean);
    if (!list.length) return '<span class="text-faint">-</span>';
    var shown = list.slice(0, max);
    var rest = list.length - shown.length;
    return '<span class="flex flex-wrap gap-1" title="' + U.escAttr(list.join(', ')) + '">' +
      shown.map(function (p) {
        return '<span class="px-1.5 py-0.5 bg-neutral-soft text-muted rounded text-3xs max-w-[150px] truncate">' +
          U.esc(p) + '</span>';
      }).join('') +
      (rest > 0 ? '<span class="px-1.5 py-0.5 bg-line text-muted rounded text-3xs font-semibold">+' +
        rest + '</span>' : '') + '</span>';
  }

  /* ---- one colour per person -------------------------------------------- */

  /* WHOSE FOUR AND A HALF HOURS ARE THOSE.

     The Employee view stacks initials in the Engineer column and a matching
     stack of figures across thirty date cells; in grey they can only be told
     apart by counting lines. So each person carries a colour, and it is the
     same colour everywhere they are named - the schedule, the bid tables,
     Settings, the who-is-here markers.

     The colour lives on the ENGINEER RECORD rather than on the account,
     because of who can read it: accounts are server-side behind admin.users
     and an ordinary employee never sees them, while the engineers register is
     in Store.db and is synced to every browser. The two are already joined by
     userId (see server/api.js linkEngineer), so Settings > People edits the
     register entry behind the person it is showing. */
  var PALETTE = 14;               // .pal-1 .. .pal-14 in assets/app.css

  /* An explicit colour wins. Failing that, the entry's POSITION in the
     register decides - not a hash of the initials, because a hash collides
     and two people sharing a colour is the one thing this must not do.
     Ordinal assignment gives the first fourteen people fourteen different
     colours with nothing written and nothing to migrate. */
  function colorOf(eng) {
    if (!eng) return 0;
    var n = U.n(eng.color);
    if (n >= 1 && n <= PALETTE) return n;
    var i = engineers().indexOf(eng);
    return (i < 0 ? 0 : i % PALETTE) + 1;
  }

  function colorClass(initials) {
    var e = findEngineer(initials);
    return e ? 'pal-' + colorOf(e) : 'pal-none';
  }

  /* THE CHIP, rendered in one place so the colour cannot drift between the
     four views that draw it. `size` is the padding scale; `title` overrides
     the name tooltip. */
  function personChip(initials, o) {
    var opts = o || {};
    var i = String(initials || '').trim();
    if (!i) return '<span class="text-faint">&mdash;</span>';
    var name = engineerName(i);
    return '<span class="person-chip ' + colorClass(i) + ' ' +
      (opts.cls || 'px-1.5 py-0.5 rounded text-2xs') + '" title="' +
      U.escAttr(opts.title || name || 'Not in the engineers register') + '">' +
      U.esc(i) +
      // Inside the chip, in the chip's own ink, so the mark travels with the
      // person's colour instead of adding a second thing to line up beside it.
      (opts.done ? '<i class="fas fa-check ml-1 text-3xs opacity-80"></i>' : '') +
      '</span>';
  }

  /* Setting a colour by hand. 0 - or anything off the palette - clears it,
     which puts the person back on their ordinal colour. */
  function setEngineerColor(id, n) {
    var e = engineers().filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    var v = U.n(n);
    if (v >= 1 && v <= PALETTE) e.color = v; else delete e.color;
    root.Store.save();
    refresh();
    renderEngineerList();
    if (root.Settings && root.Settings.repaintPeople) root.Settings.repaintPeople();
    reopenPickers();
  }

  /* The register entry behind an account: by the link the server made, and by
     initials for a person whose entry predates the account. */
  function engineerForUser(user) {
    if (!user) return null;
    var byId = engineers().filter(function (e) { return e.userId === user.id; })[0];
    return byId || findEngineer(user.initials);
  }

  /* Initials keep the column narrow; the full name rides along as a tooltip. */
  function engineerCell(bid) {
    var i = (bid.engineer || '').trim();
    if (!i) return '<span class="text-faint">&mdash;</span>';
    return personChip(i, { cls: 'px-1.5 py-0.5 rounded text-2xs' });
  }

  /* The team assigned in the active stage. Capped like the product chips so one
     bid with six people cannot blow the row height out; the tooltip carries the
     full list with each engineer's hours, which is the question you actually
     open a bid to answer. */
  function teamCell(bid) {
    var list = root.Assign.engineerList(bid);
    if (!list.length) return '<span class="text-faint">&mdash;</span>';

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
        /* A tick on the chip when every task this person holds on this bid is
           marked done. It answers "is the team finished" from the register,
           without opening the project - which is the whole point of tracking
           completion per person rather than per bid. */
        var fin = root.Assign.engineerDone(bid, i);
        return personChip(i, { cls: 'px-1.5 py-0.5 rounded text-2xs',
          done: fin,
          title: i + ' - ' + U.qty(byEngineer[i]) + ' hrs' +
            (fin ? ' - all tasks done' : '') });
      }).join('') +
      (rest > 0 ? '<span class="px-1.5 py-0.5 bg-line text-muted rounded text-2xs font-semibold">+' +
        rest + '</span>' : '') + '</span>';
  }

  /* The takeoff button, the proposal button and the promote button all used to
     live out here, drawn onto every row. They are menu entries now - see
     rowMenuItems - because six icon buttons made the widest column in the table
     out of controls you had to hover to identify.

     Project.decisionMenu is the other route to the same Award/Lost decision,
     from the project page's header bar, and is untouched. */

  /* ONE CONTROL, NOT SIX.

     Every row used to end in a cluster of up to six identical 28px squares,
     all equally loud, which made Actions the widest column in the table - wide
     enough to be most of why the table scrolled sideways at all - while still
     being a row of icons you had to hover to identify. And being last, reaching
     them meant scrolling the project name off the screen first.

     It is one button now, at the front of the row and frozen with the identity
     block, opening a menu that names each action in words. */
  function actionCell(bid) {
    // The row itself opens the project, so the cell has to stop the click
    // reaching it - one guard on the container covers the button inside.
    return '<div class="flex items-center justify-center" onclick="event.stopPropagation()">' +
      root.UI.iconBtn({
        icon: 'fa-ellipsis-vertical',
        title: 'Actions for ' + (bid.project || 'this bid'),
        tone: 'neutral',
        variant: 'ghost',
        onclick: 'Bids.openRowMenu(event,' + bid.id + ')'
      }) +
      '</div>';
  }

  /* Everything you can do to a bid from the table, in the order you would do
     it: pick it up or open the work, then decide it, then the record itself.

     All of it is in the menu, including the takeoff and the proposal that used
     to sit on the row as icons. Six icon buttons made the widest column in the
     table out of controls you had to hover to identify; a menu is one button
     wide and says what each thing is in words. */
  function rowMenuItems(bid) {
    var G = root.BidGrid, out = [];

    if (view === 'all') {
      // Intake offers the one thing you do with an intake record. Anything to
      // do with estimating belongs to a bid somebody has committed to.
      if (root.Auth.can('bid.edit')) {
        if (bid.active && onActiveOf(bid)) {
          out.push(G.menuItem({ icon: 'fa-bolt', label: 'Open in Active Bids',
            onclick: 'Project.openFrom(' + bid.id + ',\'active\')' }));
        } else {
          out.push(G.menuItem({ icon: 'fa-bolt', label: 'Add to Active Bids', tone: 'ok',
            onclick: 'Bids.addToActive(' + bid.id + ')' }));
        }
      }
    } else {
      var hasT = root.Takeoff.hasTakeoff(bid);
      out.push(G.menuItem({ icon: 'fa-calculator',
        label: hasT ? 'Open takeoff' : 'Start a takeoff',
        onclick: 'Takeoff.openForBid(' + bid.id + ')' }));

      var d = db();
      if (bid.proposalId && d.proposals[bid.proposalId]) {
        out.push(G.menuItem({ icon: 'fa-file-contract', label: 'Open proposal',
          onclick: 'Proposal.open(\'' + bid.proposalId + '\')' }));
      } else if (hasT) {
        out.push(G.menuItem({ icon: 'fa-file-contract', label: 'Generate proposal',
          onclick: 'Proposal.generateFromTakeoff(\'' + bid.takeoffId + '\')' }));
      }

      // Award and Lost are the same decision and each has its own confirmation
      // behind it, so they read as a pair rather than as a nested menu.
      if (root.Auth.can('bid.award') && onActiveOf(bid)) {
        out.push(G.menuSeparator());
        out.push(G.menuItem({ icon: 'fa-trophy', label: 'Award', tone: 'ok',
          onclick: 'Bids.decide(' + bid.id + ',\'Awarded\')' }));
        out.push(G.menuItem({ icon: 'fa-xmark', label: 'Mark Lost', tone: 'danger',
          onclick: 'Bids.decide(' + bid.id + ',\'Lost\')' }));
      }
    }

    /* Re-opening a job the client has brought back. Offered on both lists,
       because a No Scope verdict is reached on All Bids and a Completed one on
       Active, and either can be the thing that comes back. Only where it can
       actually be done - see canReopen - so it is never a menu entry that
       explains why it will not work. */
    if (canReopen(bid)) {
      out.push(G.menuSeparator());
      out.push(G.menuItem({ icon: 'fa-rotate-right', label: 'Re-open job', tone: 'warn',
        onclick: 'Bids.decide(' + bid.id + ',\'ReOpen\')' }));
    }

    if (out.length) out.push(G.menuSeparator());
    if (root.Auth.can('bid.edit')) {
      out.push(G.menuItem({ icon: 'fa-pen', label: 'Edit bid',
        onclick: 'Bids.edit(' + bid.id + ')' }));
    }
    // Undoing a stage: an award rescinded, a bid picked up by mistake. It takes
    // a comment, and it is logged - see js/history.js.
    if (root.History.canReverse(bid)) {
      out.push(G.menuItem({ icon: 'fa-rotate-left', tone: 'warn',
        label: 'Move back to ' + root.History.label(root.History.previousStage(bid)),
        onclick: 'History.promptReverse(' + bid.id + ')' }));
    }
    /* Through U.safeUrl, like the same field on the project page: bid.link is
       typed by a user, and menuLink escapes the quotes without looking at the
       scheme - so a `javascript:` link pasted into the portal field would run
       from this menu. An unusable link simply offers no menu item. */
    var portalHref = U.safeUrl(bid.link);
    if (portalHref) {
      out.push(G.menuLink({ icon: 'fa-external-link-alt', label: 'Open portal link',
        href: portalHref }));
    }
    // Deleting a bid is the one row action the screenshots mark as belonging to
    // specific roles rather than everybody. The server refuses it too.
    if (root.Auth.can('bid.delete')) {
      out.push(G.menuItem({ icon: 'fa-trash', label: 'Delete bid', tone: 'danger',
        onclick: 'Bids.promptDelete(' + bid.id + ')' }));
    }
    return out.join('');
  }

  /* ---- the project number ------------------------------------------------ */

  /* ONE NUMBER, FOR THE PROJECT'S WHOLE LIFE.
   *
   * DIS-<yy>-<0001>, where yy is the year and the sequence restarts each
   * January. It is issued the moment a bid is picked up - All Bids to Active -
   * and it never changes again: it is the Proposal No. on the document that
   * goes to the client, and it is still the number the job is known by after it
   * is won.
   *
   * It used to be issued at award, which was too late to be any use: the
   * proposal that won the job had already gone out under a number somebody
   * typed by hand. There is no longer a second number at award - see
   * applyAward.
   *
   * Allocated as "highest existing for that year + 1" rather than from a stored
   * counter: a number that has been on paper must never be handed to a second
   * project, and deleting a bid must not make its number available again.
   * Counting the bids gives both for free, with nothing to keep in sync.
   *
   * Both fields are scanned, not just proposalNo. Bids numbered under the old
   * scheme carry theirs in awardNo, and reissuing one of those as a proposal
   * number is exactly the collision this rule exists to prevent. */
  function nextProjectNo(dateISO) {
    var yy = String(dateISO || U.today()).slice(2, 4);
    var re = new RegExp('^DIS-' + yy + '-(\\d{4})$');
    function seq(v) {
      var hit = re.exec(String(v || '').trim());
      return hit ? Number(hit[1]) : 0;
    }
    var max = bids().reduce(function (m, b) {
      return Math.max(m, seq(b.proposalNo), seq(b.awardNo));
    }, 0);
    return 'DIS-' + yy + '-' + String(max + 1).padStart(4, '0');
  }

  /* Idempotent, and called from the one place a bid becomes active. A bid that
     already has a number keeps it, so moving out of Active and back does not
     renumber the project. */
  function issueProjectNo(bid, dateISO) {
    if (!String(bid.proposalNo || '').trim()) {
      bid.proposalNo = nextProjectNo(dateISO);
    }
    return bid.proposalNo;
  }

  /* The single way a bid becomes Awarded.
     No number is allocated here any more - the project already has one. awardNo
     is written as a mirror of it purely so the server's bids_award_no unique
     index and the existing XLSX export keep working; it is NOT a second
     identity, and nothing should read it as one. */
  function applyAward(bid, dateISO) {
    var was = root.History.stageOf(bid);
    var wasStatus = bid.status;
    bid.status = 'Awarded';
    if (!bid.awardedAt) bid.awardedAt = dateISO || U.today();
    // A bid can reach Awarded without having passed through Active - an
    // imported file, or a status typed straight in - so the number is ensured
    // rather than assumed.
    issueProjectNo(bid, bid.activatedAt || bid.awardedAt);
    bid.awardNo = bid.proposalNo;
    root.History.record(bid, was, 'awarded', { fromStatus: wasStatus });
    return bid.proposalNo;
  }

  /* The other outcome. Nothing is issued and nothing is taken away: the project
     keeps the number it was given when somebody picked it up, because that
     number is on the proposal that lost. */
  function applyLost(bid, dateISO) {
    var was = root.History.stageOf(bid);
    var wasStatus = bid.status;
    bid.status = 'Lost';
    if (!bid.decidedAt) bid.decidedAt = dateISO || U.today();
    root.History.record(bid, was, 'lost', { fromStatus: wasStatus });
  }

  /* ---- re-opening a finished job ---------------------------------------- */

  /* A CLIENT BRINGS A JOB BACK, AND IT BECOMES A SECOND ENTRY.
   *
   * It used to be re-entered by hand, or - worse - the finished bid was edited
   * in place, which overwrote the record of what was bid the first time. That
   * record is the whole point: the question asked about a re-bid is always
   * "what did we quote before, and what has changed".
   *
   * So re-opening leaves the original exactly as it is and opens a new entry
   * beside it, dated today, carrying the same team and none of their hours.
   */

  /* The number without any revision suffix - the identity the whole chain
     shares. Re-opening a Rev01 strips its own suffix rather than stacking a
     second one, so the third entry is -R02 and never -R01-R02. */
  function revisionBaseOf(bid) {
    var explicit = String((bid && bid.revisionBase) || '').trim();
    if (explicit) return explicit;
    return String((bid && bid.proposalNo) || '').trim().replace(/-R\d+$/i, '');
  }

  /* Highest revision already issued against a base, + 1. Scanned off the
     records rather than counted from the chain, and for the same reason
     nextProjectNo scans: a number that has been on paper must never be handed
     to a second entry, and deleting one must not free it up again. */
  function nextRevisionNo(base) {
    if (!base) return 1;
    var re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-R(\\d+)$', 'i');
    var max = bids().reduce(function (m, b) {
      var hit = re.exec(String(b.proposalNo || '').trim());
      return Math.max(m, hit ? Number(hit[1]) : 0, U.n(b.revisionBase === base ? b.revision : 0));
    }, 0);
    return max + 1;
  }

  function revisionNoText(n) {
    return 'Rev' + String(n).padStart(2, '0');
  }

  function canReopen(bid) {
    return !!bid && REOPENABLE.indexOf(bid.status) >= 0 &&
           !bid.reopenedInto && root.Auth.can('bid.edit');
  }

  /* The team, carried over without any of the work.
     WHO is doing WHAT comes across - that is the standing arrangement, and
     re-typing four names and their task types is exactly the friction that
     made people edit the old bid instead. WHEN is not: the schedule was for
     a job that is finished, and carrying those dates forward would book the
     new one into weeks that have already been and gone. So each row opens on
     three fresh working days from today with nothing in them. */
  function copyAssignments(from) {
    var start = U.today();
    if (root.Assign.isWeekend(start)) start = root.Assign.nextWorkingDay(start);
    return root.Assign.rows(from).map(function (r) {
      return root.Assign.syncRow({
        id: root.Store.uid('asg'),
        engineer: r.engineer || '',
        taskType: r.taskType || '',
        // The estimate of how long the task takes is a property of the task,
        // not of the run that finished - so it comes across as a starting
        // point. What was booked against it does not.
        estHrs: U.n(r.estHrs),
        asgnHrs: 0,
        status: 'todo',
        completedAt: '',
        startDate: start,
        days: root.Assign.workingRun(start, 3).map(function (d) {
          return { date: d, hrs: null };
        })
      });
    });
  }

  function reopen(bidId) {
    var original = bids().filter(function (b) { return b.id === bidId; })[0];
    if (!canReopen(original)) return null;

    var base = revisionBaseOf(original);
    var n = nextRevisionNo(base);
    var nextNo = base ? base + '-R' + String(n).padStart(2, '0') : '';
    var today = U.today();

    var next = {
      id: bids().reduce(function (m, b) { return Math.max(m, b.id || 0); }, 0) + 1,
      /* WHAT THE NEW ENTRY IS. The job, as described - not what happened to
         it last time. */
      project: original.project,
      products: (original.products || []).slice(),
      productLines: JSON.parse(JSON.stringify(original.productLines || [])),
      material: original.material || '',
      region: original.region || '',
      location: original.location || '',
      portal: original.portal || '',
      link: original.link || '',
      comments: original.comments || '',
      engineer: original.engineer || '',
      inRegion: original.inRegion,
      dueDate: '',
      revisedDueDate: '',

      /* NOTHING PRICED AND NOTHING MEASURED. A re-bid is re-bid: carrying the
         old price over would put a number on the new entry that nobody has
         worked out, and it is the number most likely to be read without
         checking. The takeoff and the proposal are not copied either - they
         are the documents that produced that price. */
      price: null,
      priceLocked: false,
      lf: null,
      estHrs: 0,
      assignedHrs: 0,
      takeoffId: null,
      proposalId: null,

      proposalNo: nextNo,
      awardNo: null,
      awardedAt: null,
      decidedAt: null,

      status: 'ReOpen',
      active: true,
      activatedAt: today,
      createdAt: new Date().toISOString(),

      assignments: copyAssignments(original),
      history: [],

      /* The chain, walkable both ways. */
      revision: n,
      revisionOf: original.id,
      revisionBase: base,
      reopenedInto: null
    };

    bids().push(next);
    original.reopenedInto = next.id;

    /* The original's STATUS IS LEFT ALONE. It was Completed, and it still is -
       that is what happened. What came afterwards is a separate entry, and
       reopenedInto is what marks this one as having been superseded. */
    root.History.record(original, root.History.stageOf(original), 'reopened', {
      fromStatus: original.status,
      toStatus: original.status,
      comment: 'Re-opened as ' + (nextNo || 'a new entry') + ' (' + revisionNoText(n) + ').'
    });
    root.History.recordCreated(next);
    root.History.entries(next).slice(-1)[0].comment =
      revisionNoText(n) + ' of ' + (base || 'this project') +
      '. Re-opened from the entry completed ' +
      (original.decidedAt || original.activatedAt || '' ? U.date(original.decidedAt || original.activatedAt) : 'earlier') + '.';

    return next;
  }

  /* ---- dates ------------------------------------------------------------- */

  /* The date the project is actually working to.

     A revised due date is the client moving the deadline, which happens often
     enough that overwriting the original loses the fact that it moved. So both
     are kept and everything that asks "when is this due" asks here: the grid
     column and its sort, the month the bid is filed under, the dashboard's
     "due within 7 days", and the export. */
  function effectiveDueDate(bid) {
    if (!bid) return '';
    var revised = String(bid.revisedDueDate || '').trim();
    return revised || bid.dueDate || '';
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
      wrapClass: 'w-16 h-16 bg-ok-soft rounded-full flex items-center justify-center mx-auto mb-4',
      iconClass: 'fas fa-trophy text-ok text-2xl',
      buttonClass: 'px-5 py-2.5 bg-ok hover:bg-ok-hover text-white rounded-lg text-sm font-medium transition',
      title: 'Move to Awarded?',
      note: 'It moves off Active Bids into Awarded Bids. The number is permanent — ' +
            'it is not reissued if the status changes again.',
      apply: applyAward
    },
    Lost: {
      verb: 'Mark Lost', icon: 'fa-xmark',
      wrapClass: 'w-16 h-16 bg-danger-soft rounded-full flex items-center justify-center mx-auto mb-4',
      iconClass: 'fas fa-xmark text-danger text-2xl',
      buttonClass: 'px-5 py-2.5 bg-danger hover:bg-danger-hover text-white rounded-lg text-sm font-medium transition',
      title: 'Mark this bid as Lost?',
      note: 'It moves off Active Bids and stays in All Bids. No job number is issued — ' +
            'those identify work we are doing.',
      apply: applyLost
    },
    /* Re-opening is the same shape of thing - confirm something that changes
       the record and cannot be casually undone - so it goes through the same
       modal rather than a second near-identical one. It differs in that it
       CREATES a record instead of moving one, which is what `opens` marks: the
       confirm step follows the new entry rather than repainting the old. */
    ReOpen: {
      verb: 'Re-open', icon: 'fa-rotate-right',
      wrapClass: 'w-16 h-16 bg-warn-soft rounded-full flex items-center justify-center mx-auto mb-4',
      iconClass: 'fas fa-rotate-right text-warn text-2xl',
      buttonClass: 'px-5 py-2.5 bg-warn hover:bg-warn-hover text-white rounded-lg text-sm font-medium transition',
      title: 'Re-open this job?',
      note: 'This entry is left exactly as it is — it is the record of what was bid ' +
            'the first time. A new entry opens on Active Bids dated today, with the ' +
            'same people and task types, no hours booked, and no takeoff or proposal.',
      opens: true,
      apply: reopen
    }
  };

  var decisionTarget = null;
  var decisionOutcome = null;

  function promptDecision(id, outcome) {
    var b = bids().filter(function (x) { return x.id === id; })[0];
    var d = DECISIONS[outcome];
    if (!b || !d) return;
    if (outcome === 'ReOpen') {
      if (!canReopen(b)) {
        U.toast(b.reopenedInto
          ? 'That job has already been re-opened.'
          : 'Only a Completed or No Scope job can be re-opened.', 'warn');
        return;
      }
    } else if (b.status === outcome) {
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

    // Awarding no longer issues anything: the project was numbered when it was
    // picked up, and that is the number it is won under. Naming it here is a
    // confirmation rather than a warning - but a bid that somehow reached this
    // point unnumbered is told which one it is about to get.
    var numberRow = U.$('decisionNumberRow');
    if (outcome === 'Awarded') {
      numberRow.classList.remove('hidden');
      var existing = String(b.proposalNo || '').trim();
      U.$('decisionNumber').textContent = existing || nextProjectNo(U.today());
      U.$('decisionNumberLabel').textContent = existing
        ? 'will be awarded as' : 'will be given project number';
    } else if (outcome === 'ReOpen') {
      // The number the new entry will carry, shown BEFORE it is issued. It is
      // the thing that distinguishes the two entries from here on, so it is
      // what the confirmation is really asking about.
      numberRow.classList.remove('hidden');
      var base = revisionBaseOf(b);
      var rev = nextRevisionNo(base);
      U.$('decisionNumber').textContent = base
        ? base + '-R' + String(rev).padStart(2, '0')
        : revisionNoText(rev);
      U.$('decisionNumberLabel').textContent = 'will re-open as';
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

    /* Re-opening makes a record rather than moving one, so it takes the id and
       lands on what it built. Everything else acts on the bid in place. */
    if (d.opens) {
      var next = d.apply(b.id);
      root.Store.save();
      refresh();
      if (!next) { U.toast('That job could not be re-opened.', 'warn'); return; }
      U.toast('Re-opened as ' + (next.proposalNo || revisionNoText(next.revision)) +
        '. The finished entry is untouched.', 'ok');
      // Land in the new entry: it is where the work is now, and leaving the
      // user on the finished one would look as though nothing had happened.
      root.Project.openFrom(next.id, 'active');
      return;
    }

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
  /* Picking a bid up is what turns a received enquiry into a project, so it is
     where the project gets its number - see issueProjectNo. Everything
     downstream, the takeoff and the proposal document, is identified by it. */
  function addToActive(bid) {
    if (!bid) return false;
    if (bid.active && onActiveOf(bid)) return false;
    var was = root.History.stageOf(bid);
    var wasStatus = bid.status;
    bid.active = true;
    if (!onActiveOf(bid)) bid.status = 'Not Started';
    if (!bid.activatedAt) bid.activatedAt = U.today();
    issueProjectNo(bid, bid.activatedAt);
    pushProposalNo(bid);
    root.History.record(bid, was, root.History.stageOf(bid), { fromStatus: wasStatus });
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
      return '<div class="flex items-center justify-between gap-3 px-3 py-2 bg-warn-soft border border-warn/30 rounded-lg text-left">' +
        '<div class="min-w-0">' +
          '<div class="text-sm font-semibold text-ink-strong truncate">' + U.esc(d.project) + '</div>' +
          '<div class="text-2xs text-muted">' + U.esc(stageOf(d)) +
            (d.proposalNo ? ' &middot; <span class="font-mono">' + U.esc(d.proposalNo) + '</span>' : ' &middot; no proposal no.') +
            (d.awardNo ? ' &middot; <span class="font-mono text-ok-ink">' + U.esc(d.awardNo) + '</span>' : '') +
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
    // The number is the useful half of this message: it is what the project is
    // called from here on, and it is what goes on the proposal.
    U.toast('"' + (b.project || 'Bid') + '" added to Active Bids as ' + b.proposalNo + '.', 'ok');
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

  /* Days from today to an ISO date; negative is in the past. Null when the bid
     has no due date, which is different from "not due soon". */
  function daysUntil(iso) {
    var d = U.parseDate(iso);
    if (!d) return null;
    var today = U.parseDate(U.today());
    return Math.round((d - today) / 86400000);
  }

  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  /* Each tile is a figure and the one fact that makes it mean something. A bare
     count says nothing about whether it is a good number - "12 In Progress" is
     reassuring or alarming entirely depending on how many of them are due this
     week, which is what the line underneath answers. */
  function updateKPIs() {
    var b = bids();
    function set(id, value, note) {
      var el = U.$(id);
      if (el) el.textContent = value;
      var n = U.$(id + 'Note');
      if (n) n.textContent = note || ' ';
    }

    var open = b.filter(function (x) { return bucketOf(x) === 'open'; });
    var submitted = b.filter(function (x) { return x.status === 'Submitted to review'; });
    /* Its own tile rather than a share of Submitted. The two mean different
       things to different people: Submitted is work that has left the building
       and is waiting on somebody else, Completed is work the estimator has
       finished. One figure covering both answered neither question. */
    var completed = b.filter(function (x) { return x.status === 'Completed'; });
    var progress = b.filter(function (x) { return x.status === 'In Progress'; });
    var awarded = b.filter(function (x) { return x.status === 'Awarded'; });
    var lost = b.filter(function (x) { return x.status === 'Lost'; });
    var priced = b.filter(function (x) { return U.n(x.price) > 0; });
    var soon = progress.filter(function (x) {
      var d = daysUntil(effectiveDueDate(x));
      return d !== null && d <= 7;
    });

    set('kpiTotal', b.length, viewCount('active') + ' being worked');
    set('kpiSubmitted', submitted.length,
      open.length ? pct(submitted.length, open.length) + '% of everything still open' : 'nothing open');
    /* The fact that makes the number mean something: a completed bid with no
       proposal is not finished, whatever its status says - the same condition
       the Needs-attention panel counts. */
    var noDoc = completed.filter(function (x) { return !x.proposalId; }).length;
    set('kpiCompleted', completed.length,
      completed.length
        ? (noDoc ? noDoc + ' with no proposal yet' : 'all have their proposal')
        : 'nothing finished yet');
    set('kpiProgress', progress.length,
      soon.length ? soon.length + ' due within 7 days' : 'none due this week');
    // The hit rate, which is the question anybody looking at an Awarded count
    // is actually asking. Only meaningful once something has been decided.
    set('kpiAwarded', awarded.length,
      awarded.length + lost.length
        ? pct(awarded.length, awarded.length + lost.length) + '% of decided bids won'
        : 'nothing decided yet');
    set('kpiValue', U.currency(b.reduce(function (s, x) { return s + U.n(x.price); }, 0)),
      'across ' + priced.length + ' priced bid' + (priced.length === 1 ? '' : 's'));

    // js/nav.js draws these from viewCount whenever it renders the strip; this
    // keeps them current after a mutation that does not re-render it.
    Object.keys(VIEWS).forEach(function (k) {
      var el = U.$('badge-' + k);
      if (el) el.textContent = viewCount(k);
    });

    var rec = U.$('totalRecords');
    if (rec) rec.textContent = b.length;
  }

  /* The year as one strip of bars.

     It was twelve cards, of which ten read 0 - a third of the fold spent
     saying nothing happened. A bar carries the same number and its size at the
     same time, so the shape of the year is readable without doing arithmetic
     across twelve tiles. It is still the month filter: clicking one narrows
     All Bids, which is the only thing the cards were really for. */
  var BAR_MAX_PX = 104;

  function renderMonthGrid() {
    var host = U.$('monthGrid');
    if (!host) return;
    var counts = new Array(12).fill(0);
    bids().forEach(function (b) { if (b.month >= 0 && b.month < 12) counts[b.month]++; });
    var max = Math.max.apply(null, counts) || 1;
    var thisMonth = new Date().getMonth();

    host.innerHTML = monthNames.map(function (name, i) {
      var on = selectedMonth === i;
      // An empty month still gets a sliver, so the baseline reads as a row of
      // months rather than as gaps where months should be.
      var h = counts[i] ? Math.max(6, Math.round(BAR_MAX_PX * counts[i] / max)) : 3;
      var bar = on ? 'bg-brand'
        : counts[i] ? 'bg-brand/45 group-hover:bg-brand/70'
        : 'bg-line group-hover:bg-line-strong';
      return '<button onclick="Bids.selectMonth(' + i + ')" ' +
        'title="' + counts[i] + ' bid' + (counts[i] === 1 ? '' : 's') + ' in ' + name + '" ' +
        'class="group flex-1 h-full flex flex-col items-center justify-end gap-1.5 min-w-0">' +
        '<span class="text-2xs font-semibold tabular-nums ' +
          (counts[i] ? (on ? 'text-brand-ink' : 'text-muted') : 'text-transparent') + '">' +
          (counts[i] || 0) + '</span>' +
        '<span class="w-full rounded-t transition-colors ' + bar + '" ' +
          'style="height:' + h + 'px"></span>' +
        '<span class="text-3xs uppercase tracking-wider ' +
          (on ? 'text-brand-ink font-bold'
              : i === thisMonth ? 'text-ink font-semibold' : 'text-faint') + '">' +
          name + '</span>' +
      '</button>';
    }).join('');
  }

  /* ---- needs attention -------------------------------------------------- */

  /* The one part of the dashboard that is about what to do next rather than
     what already happened, so it sits at the top beside the month strip.

     Both lists are derived from the bids themselves - there is no new field and
     nothing to keep in step. A row opens the project, which is where you would
     go next anyway. */
  function attentionGroups() {
    var open = bids().filter(function (b) { return bucketOf(b) === 'open'; });

    /* Completed is in the open bucket - the work is done but the bid has not
       been decided - so without this a finished job goes on reporting itself as
       overdue for the rest of the week. A panel that cries wolf is a panel
       nobody reads. Submitted to review stays: it is still out there, and its
       deadline is still real. */
    var due = open.filter(function (b) { return b.status !== 'Completed'; })
      .map(function (b) { return { bid: b, days: daysUntil(effectiveDueDate(b)) }; })
      .filter(function (x) { return x.days !== null && x.days <= 7; })
      .sort(function (a, c) { return a.days - c.days; });

    // Submitted or finished, but the client-facing document was never produced.
    var noProposal = open.filter(function (b) {
      return (b.status === 'Submitted to review' || b.status === 'Completed') && !b.proposalId;
    });

    return [
      // The icon colour is written out in full, not assembled from a tone name:
      // the stylesheet only ships classes the compiler can see in the source,
      // and 'text-' + tone is not one of them.
      { key: 'due', icon: 'fa-clock', label: 'Due within 7 days', tint: 'text-warn',
        rows: due.map(function (x) {
          return {
            bid: x.bid,
            meta: x.days < 0 ? Math.abs(x.days) + 'd overdue'
                : x.days === 0 ? 'today'
                : 'in ' + x.days + 'd',
            urgent: x.days <= 0
          };
        }) },
      { key: 'noproposal', icon: 'fa-file-circle-xmark', label: 'No proposal generated', tint: 'text-info',
        rows: noProposal.map(function (b) {
          return { bid: b, meta: b.status, urgent: false };
        }) }
    ];
  }

  function renderAttention() {
    var host = U.$('attentionList');
    if (!host) return;
    var groups = attentionGroups().filter(function (g) { return g.rows.length; });

    if (!groups.length) {
      host.innerHTML =
        '<div class="text-center py-8">' +
          '<i class="fas fa-circle-check text-2xl text-ok mb-2 block"></i>' +
          '<p class="text-sm text-muted">Nothing due this week, and every submitted ' +
          'bid has its proposal.</p>' +
        '</div>';
      return;
    }

    /* Every row, not the first four. The panel is the one part of the dashboard
       that is a to-do list, and a to-do list that hides its tail is worse than
       none: the count said 8 while four were reachable. The card scrolls
       instead - see #attentionList in the page. */
    host.innerHTML = groups.map(function (g) {
      return '<div>' +
        '<div class="flex items-center gap-2 text-3xs font-bold uppercase tracking-wider ' +
          'text-muted mb-1.5">' +
          '<i class="fas ' + g.icon + ' ' + g.tint + '"></i>' + U.esc(g.label) +
          '<span class="ml-auto tabular-nums">' + g.rows.length + '</span></div>' +
        g.rows.map(function (r) {
          return '<button onclick="Project.open(' + r.bid.id + ')" ' +
            'class="w-full text-left flex items-baseline gap-2 px-2 py-1.5 rounded-lg ' +
            'hover:bg-raised transition">' +
            '<span class="flex-1 truncate text-xs text-ink">' +
              U.esc(r.bid.project || 'Untitled project') + '</span>' +
            '<span class="text-3xs whitespace-nowrap ' +
              (r.urgent ? 'text-danger font-semibold' : 'text-muted') + '">' +
              U.esc(r.meta) + '</span></button>';
        }).join('') +
      '</div>';
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
      options: function () { return allStatuses().map(function (s) { return s.key; }); }
    },
    active: {
      label: 'Active Bids',
      match: function (b) { return !!b.active && onActiveOf(b); },
      options: function () {
        return allStatuses().filter(function (s) { return s.onActive; })
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
          U.low(b.location).indexOf(search) >= 0 ||
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
    // Through preserveView because BidGrid.render rebuilds the scroll container
    // itself: without it every save - yours or a colleague's - throws the table
    // back to the far left. See U.preserveView.
    U.preserveView(function () { root.BidGrid.render(baseList()); });
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

  /* The Monthly Bid Volume bar chart used to sit here as well, showing exactly
     what the month strip above it shows - the same twelve numbers, twice, in
     half the page. The strip won because it is also the month filter. */
  function renderCharts() {
    if (!root.Chart) return;
    // Chart.js keeps a registry per canvas; without destroying first, repeated
    // tab switches stack instances and leak.
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); charts[k] = null; }
    });

    var b = bids();

    // Status is the one breakdown that already has colours: the badges in the
    // table. Reusing them means a slice and its pill are the same colour, which
    // they were not before - the pie was on Chart.js's defaults.
    charts.status = pie('statusChart', tally(b, 'status'), function (pairs) {
      return pairs.map(function (p) { return root.UI.statusColor(p[0]); });
    });

    // The other two have no inherent colour, so they take the shared
    // categorical order - which means the same slice position is the same
    // colour on both, and both match the rest of the app.
    charts.material = pie('materialChart', tally(b, 'material'), categorical);
    charts.region = pie('regionChart', tally(b, 'region', 6), categorical);
  }

  function categorical(pairs) {
    var palette = root.UI.chartColors();
    return pairs.map(function (_, i) { return palette[i % palette.length]; });
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

  function pie(canvasId, pairs, colorsFor) {
    var el = U.$(canvasId);
    if (!el) return null;
    return new root.Chart(el, {
      type: 'doughnut',
      data: {
        labels: pairs.map(function (p) { return p[0]; }),
        datasets: [{
          data: pairs.map(function (p) { return p[1]; }),
          backgroundColor: colorsFor(pairs),
          // The ring is cut out of the card, not drawn on white, so the gap
          // between slices has to be the card's own colour or every doughnut
          // gets a white halo in the dark theme.
          borderColor: root.UI.color('surface'),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        // The container sets the height. Left to itself the doughnut grew to
        // whatever width it was given and pushed everything below the fold.
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              boxWidth: 10, boxHeight: 10, padding: 10, usePointStyle: true,
              // Legend text is chrome, so it follows the theme like the rest of
              // it rather than staying near-black on a dark card.
              color: root.UI.color('muted'),
              font: { size: 11, family: 'Inter' }
            }
          }
        }
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
      var form = id === 'mRegion';
      var cur = sel.value;
      sel.innerHTML = form ? '<option value="">Select Region</option>' : '<option value="">All Regions</option>';
      sorted.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r; o.textContent = r;
        sel.appendChild(o);
      });
      /* Only on the form. A filter is a question about the bids that exist, and
         inventing a region nothing is filed under would only ever empty the
         table - see onRegionChange for what this sentinel does. */
      if (form) {
        var add = document.createElement('option');
        add.value = '__add';
        add.textContent = '+ Add new region...';
        sel.appendChild(add);
      }
      if (cur) sel.value = cur;
      // What to put back if the "+ Add new" prompt is cancelled: the browser
      // has already moved the select to the sentinel by the time onchange runs.
      if (form) sel.dataset.prev = sel.value === '__add' ? '' : sel.value;
    });
    populatePortalSelect();
  }

  /* ---- portals --------------------------------------------------------- */

  /* Where the bid came in from. Six <option> tags written into the page until
     the office signed up to a portal that was not among them; a managed list
     now - Settings > Portals - so the form is filled from the database rather
     than from the markup.

     No "+ Add new..." sentinel, unlike regions: a portal is a subscription the
     office holds, not something invented while filing one bid, so it is added
     deliberately in Settings and offered everywhere at once. */
  function populatePortalSelect() {
    var sel = U.$('mPortal');
    if (!sel) return;
    var list = (db().portals || []).slice();
    var cur = sel.value;
    /* A bid filed under a portal since removed from the list keeps its value
       and stays selectable, rather than the form silently rewriting it to
       whatever happens to be first. Same rule as populateStatusSelect. */
    if (cur && list.indexOf(cur) < 0) list.push(cur);
    sel.innerHTML = '<option value="">Select portal</option>' +
      list.map(function (p) {
        return '<option value="' + U.escAttr(p) + '">' + U.esc(p) + '</option>';
      }).join('');
    if (cur) sel.value = cur;
  }

  function countPortal(name) {
    return bids().filter(function (b) { return b.portal === name; }).length;
  }

  /* Carries a portal rename onto every bid filed under the old name - the same
     bargain renameRegion makes, and for the same reason: the list and the bids
     are two views of one fact, and a rename that only moved the list would
     leave the bids pointing at a portal that no longer exists. */
  function renamePortalOnBids(from, to) {
    var n = 0;
    bids().forEach(function (b) { if (b.portal === from) { b.portal = to; n++; } });
    return n;
  }

  function countStatus(name) {
    return bids().filter(function (b) { return b.status === name; }).length;
  }

  function renameStatusOnBids(from, to) {
    var n = 0;
    bids().forEach(function (b) { if (b.status === from) { b.status = to; n++; } });
    return n;
  }

  /* Intercepts the "+ Add new" sentinel on the form's region select.
   *
   * A county missing from the list used to mean abandoning a half-filled bid
   * form, going to Settings > Regions to add it, and starting again - so the
   * list gets a one-off typed into some other field instead, or the bid gets
   * filed under the wrong county because that one was in the list.
   *
   * Deliberately the same bargain the Product picker makes (see
   * onProductChange): what you type joins the shared list for everybody, rather
   * than being a value only this bid has. */
  function onRegionChange(sel) {
    var prev = sel.dataset.prev || '';
    if (sel.value !== '__add') { sel.dataset.prev = sel.value; return; }

    var name = (prompt('Name for the new region or county:', '') || '').trim();
    // Cancelled, or nothing typed: put back whatever was chosen before rather
    // than leaving the form sitting on the sentinel.
    if (!name) { sel.value = prev; return; }

    var d = db();
    var existing = d.regions.filter(function (r) {
      return r.toLowerCase() === name.toLowerCase();
    })[0];
    if (existing) {
      // "beachwood, oh" and "Beachwood, OH" are one county to everybody except
      // a string compare, and two entries in the list is how the filter ends up
      // splitting one county's bids across two rows.
      populateRegionSelects();
      sel.value = existing;
      sel.dataset.prev = existing;
      U.toast('"' + existing + '" was already in the list - selected it.', 'warn');
      return;
    }

    d.regions.push(name);
    root.Store.save();
    renderRegionList();
    populateRegionSelects();
    sel.value = name;
    sel.dataset.prev = name;
    U.toast('"' + name + '" added to the region list.', 'ok');
  }

  /* The host only exists while the Settings > Regions panel is showing, and
     these are called from mutations that can happen from elsewhere.

     Editable in place, like the Task Types and Materials lists - a county typed
     wrong is otherwise only fixable by deleting it, which orphans the value on
     every bid already filed under it. */
  function renderRegionList() {
    var d = db();
    var host = U.$('regionList');
    if (!host) return;
    host.innerHTML = d.regions.slice().sort().map(function (r) {
      var used = d.bids.filter(function (b) { return b.region === r; }).length;
      var arg = U.escAttr(r).replace(/'/g, "\\'");
      return '<div class="flex items-center gap-2 px-3 py-2 bg-raised rounded-lg">' +
        '<input value="' + U.escAttr(r) + '" onchange="Bids.renameRegion(\'' + arg + '\',this.value)" ' +
          'class="flex-1 px-2 py-1 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
        '<span class="text-xs text-faint w-16 text-right">' +
          (used ? used + ' bid' + (used > 1 ? 's' : '') : '') + '</span>' +
        '<button onclick="Bids.removeRegion(\'' + arg + '\')" class="text-danger hover:text-danger-ink text-xs"><i class="fas fa-trash"></i></button></div>';
    }).join('');
  }

  /* ---- modal ----------------------------------------------------------- */

  /* The job number is issued by the app, never typed, so the form shows it as a
     fact rather than a field. */
  function renderAwardNoHint(b) {
    var host = U.$('awardNoHint');
    if (!host) return;
    // One number for the project's life: what is shown here is the number it was
    // given when it was picked up, confirmed as the job number on award.
    host.innerHTML = b && b.awardedAt && b.proposalNo
      ? '<span class="px-2 py-1 rounded bg-ok-soft text-ok-ink font-mono font-semibold text-sm">' +
        U.esc(b.proposalNo) + '</span>'
      : '<span class="text-faint text-xs">Confirmed on award</span>';
  }

  /* Says plainly which date is now in force, because a second date box next to
     the first invites the reading that the original still governs. */
  function renderRevisedDueHint(b) {
    var host = U.$('revisedDueHint');
    if (!host) return;
    var revised = b && String(b.revisedDueDate || '').trim();
    host.innerHTML = revised
      ? '<span class="text-warn-ink">Due ' + U.esc(U.date(revised)) +
        ', was ' + U.esc(U.date(b.dueDate)) + '</span>'
      : 'Overrides the due date if set';
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
      ? 'Team hours: <span class="font-mono font-semibold text-ink">' + U.qty(t.est) +
        '</span> estm &middot; <span class="font-mono font-semibold text-ink">' + U.qty(t.asgn) +
        '</span> asgn &mdash; edit on the project page'
      : '<span class="text-faint">No team hours yet &mdash; add them on the project page</span>';
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
    U.setDateField('mRevisedDueDate', '');
    renderRevisedDueHint(null);
    U.$('editId').value = '';
    populateStatusSelect(null);
    showProposalNoBlock(null);
    U.$('mProposalNo').classList.remove('border-danger', 'bg-danger-soft');
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
    U.$('mProposalNo').classList.remove('border-danger', 'bg-danger-soft');
    showProposalNoBlock(b);
    renderAwardNoHint(b);
    renderTeamHrsHint(b);
    U.$('mProject').value = b.project || '';
    U.$('mPortal').value = b.portal || 'PlanHub';
    U.$('mRegion').value = b.region || '';
    U.$('mLocation').value = b.location || '';
    setProducts(b.products);
    U.$('mMaterial').value = b.material || '';
    U.$('mEngineer').value = b.engineer || '';
    U.$('mPrice').value = b.price == null ? '' : b.price;
    U.$('mAssignedHrs').value = b.assignedHrs == null ? '' : b.assignedHrs;
    U.$('mEstHrs').value = b.estHrs == null ? '' : b.estHrs;
    U.setDateField('mDueDate', b.dueDate);
    U.setDateField('mRevisedDueDate', b.revisedDueDate);
    renderRevisedDueHint(b);
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
          return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium ' +
            (legacy ? 'bg-warn-soft text-warn-ink border border-warn/30' : 'bg-brand-soft text-brand-ink') +
            '" title="' + U.escAttr(p) + (legacy ? ' (entry from before the product list)' : '') + '">' +
            '<span class="max-w-[150px] truncate">' + U.esc(p) + '</span>' +
            '<button type="button" onclick="Bids.removeProduct(' + i + ')" ' +
            'class="hover:text-danger leading-none" aria-label="Remove">&times;</button></span>';
        }).join('')
      : '<span class="text-2xs text-faint">No products selected</span>';

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
        ? '<span class="text-muted">' + U.esc(e.name) + '</span>'
        : '<span class="text-faint">In the register</span>';
      return;
    }
    hint.innerHTML = '<button type="button" onclick="Bids.addEngineerFromForm()" ' +
      'class="text-brand hover:text-brand-ink font-medium">' +
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

  /* THE PICKER. A swatch that opens a strip of fourteen inside the row it
     belongs to, rather than a floating palette: a popover has to be positioned,
     dismissed and kept on screen, and this list already scrolls inside a box.
     Drawn here so Settings > People and the Engineers register offer exactly
     the same control.

     `Auto` is not "no colour" - it is the ordinal colour the person already
     had, which is why it shows their current swatch rather than a blank. */
  function colorPicker(engId, current, host) {
    var strip = '';
    for (var n = 1; n <= PALETTE; n++) {
      strip += '<button type="button" class="pal-swatch pal-' + n +
        (current === n ? ' is-on' : '') + '" title="Colour ' + n + '" ' +
        'aria-label="Colour ' + n + '" ' +
        'onclick="event.stopPropagation();Bids.setEngineerColor(\'' + engId + '\',' + n + ')"></button>';
    }
    return '<div id="' + host + '" class="hidden basis-full flex flex-wrap items-center gap-1.5 pt-2 mt-1 border-t border-line">' +
      '<span class="text-3xs font-bold uppercase tracking-wider text-muted mr-1">Colour</span>' +
      strip +
      '<button type="button" onclick="event.stopPropagation();Bids.setEngineerColor(\'' + engId + '\',0)" ' +
        'class="ml-1 px-2 py-1 rounded text-3xs font-semibold text-muted hover:bg-line" ' +
        'title="Back to the colour this person was given automatically">Auto</button>' +
    '</div>';
  }

  /* Which strips are open, remembered across the repaint that picking a colour
     causes - otherwise the palette shuts the instant you use it, and trying a
     second colour means finding the swatch again. */
  var openPickers = {};

  function toggleColorPicker(hostId) {
    var el = U.$(hostId);
    if (!el) return;
    el.classList.toggle('hidden');
    if (el.classList.contains('hidden')) delete openPickers[hostId];
    else openPickers[hostId] = true;
  }

  function reopenPickers() {
    Object.keys(openPickers).forEach(function (id) {
      var el = U.$(id);
      if (el) el.classList.remove('hidden');
      else delete openPickers[id];
    });
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
      return '<div class="flex flex-wrap items-center gap-2 px-3 py-2 bg-raised rounded-lg">' +
        '<button type="button" onclick="Bids.toggleColorPicker(\'palEng-' + e.id + '\')" ' +
          'title="Choose this person\'s colour" ' +
          'class="person-chip pal-' + colorOf(e) + ' w-8 h-8 rounded-lg text-3xs shrink-0">' +
          U.esc(e.initials) + '</button>' +
        '<input value="' + U.escAttr(e.initials) + '" onchange="Bids.updateEngineer(\'' + e.id + '\',\'initials\',this.value)" ' +
          'class="w-20 px-2 py-1 bg-surface border border-line rounded text-sm font-semibold uppercase outline-none focus:border-brand">' +
        '<input value="' + U.escAttr(e.name) + '" placeholder="Full name (optional)" ' +
          'onchange="Bids.updateEngineer(\'' + e.id + '\',\'name\',this.value)" ' +
          'class="flex-1 px-2 py-1 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
        /* This person's working day, when it is not the shop's. Blank means
           "whatever the shop is set to" rather than zero, and the placeholder
           shows that figure so an empty box is readable as inheriting it
           instead of as missing data. */
        '<label class="flex items-center gap-1 text-3xs text-muted" ' +
          'title="Hours this person works in a day. Leave blank to use the shop default.">' +
          '<i class="fas fa-clock text-faint"></i>' +
          '<input type="number" step="0.5" min="0" max="24" ' +
            'value="' + U.escAttr(U.n(e.dayHours) > 0 ? e.dayHours : '') + '" ' +
            'placeholder="' + U.escAttr(root.Schedule.shopDayHours()) + '" ' +
            'aria-label="Working day for ' + U.escAttr(e.initials) + '" ' +
            'onchange="Bids.updateEngineer(\'' + e.id + '\',\'dayHours\',this.value)" ' +
            'class="w-14 px-1.5 py-1 bg-surface border border-line rounded text-sm font-mono ' +
            'text-right outline-none focus:border-brand">' +
          'hrs' +
        '</label>' +
        // An entry that belongs to an account is not free-standing: renaming
        // the initials here moves the link with it, and deleting it would
        // orphan somebody who can still sign in.
        (e.userId
          ? '<span title="Has an account - manage it under Settings &rsaquo; People" ' +
            'class="text-3xs font-bold uppercase tracking-wider text-brand bg-brand-soft px-1.5 py-0.5 rounded">' +
            'account</span>'
          : '') +
        '<span class="text-xs text-faint w-16 text-right">' + (used ? used + ' bid' + (used > 1 ? 's' : '') : '') + '</span>' +
        '<button onclick="Bids.removeEngineer(\'' + e.id + '\')" class="text-danger hover:text-danger-ink text-xs"><i class="fas fa-trash"></i></button>' +
        colorPicker(e.id, U.n(e.color), 'palEng-' + e.id) + '</div>';
    }).join('') : '<p class="text-sm text-faint text-center py-6">No engineers yet.</p>';
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
    // awardNo is a mirror of the project number on a won job, kept only for the
    // server's unique index and the export. It has to follow the number here
    // too, or editing the number on an awarded bid leaves the two disagreeing
    // about what the job is called.
    if (bid.awardedAt) bid.awardNo = bid.proposalNo || null;
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

  /* THE FORM AND THE CARD, KEPT IN STEP.

     The bid form is the quick intake path: a list of products and one material,
     which is all you know when an enquiry lands. The Products & Materials card
     on the project page is the full picture - each product with its own
     materials. Both write the same record, so saving the form has to fold its
     two flat fields back into the rows without throwing away pairings the card
     has since been used to make.

     So: a product the form still lists keeps the materials its row already has.
     A product the form has added gets the form's material. A product the form
     has removed loses its row. Only then are the flat fields rewritten from the
     rows, by Products.sync, which is what the grid columns read. */
  function reconcileProductLines(bid) {
    var existing = {};
    root.Products.rows(bid).forEach(function (r) { existing[r.product] = r; });

    var formMaterial = String(bid.material || '').trim();
    bid.productLines = (bid.products || []).filter(Boolean).map(function (p) {
      if (existing[p]) {
        var row = existing[p];
        // A row with no material yet takes whatever the form was set to; one
        // that already has materials is left alone, because the card is where
        // that detail was entered and the form cannot express it.
        if (formMaterial && !root.Products.materialsOf(row).length) {
          row.materials = [formMaterial];
        }
        return row;
      }
      return { id: root.Store.uid('pl'), product: p,
               materials: formMaterial ? [formMaterial] : [] };
    });
    root.Products.sync(bid);
  }

  /* ---- editing one field, in place -------------------------------------- */

  /* The commit half of UI.editableField.
   *
   * Every rule the Add/Edit form applies has to apply here too, or the quick
   * path becomes the way round the validation: a duplicate proposal number, a
   * date that does not exist, a month that no longer matches its due date. So
   * this reuses the same helpers - proposalNoOwner, U.inputToDate,
   * effectiveDueDate - rather than a second, laxer set.
   *
   * `host` is the element being edited. On a refusal it is put back exactly as
   * it was, because the alternative is silently discarding what was typed.
   */
  function saveField(bidId, field, raw, type, host) {
    var bid = bids().filter(function (x) { return x.id === bidId; })[0];
    if (!bid) return;

    function refuse(message) {
      if (host && host.dataset.original !== undefined) host.innerHTML = host.dataset.original;
      U.toast(message, 'err');
    }

    var value = String(raw == null ? '' : raw).trim();

    if (type === 'date') {
      var iso = U.inputToDate(value);
      if (iso === null) { refuse('That date must be MM-DD-YYYY and a real date.'); return; }
      value = iso;
    } else if (type === 'number') {
      value = value === '' ? null : Number(value);
      if (value !== null && isNaN(value)) { refuse('That has to be a number.'); return; }
    }

    if (field === 'proposalNo') {
      var clash = proposalNoOwner(value, bid.id);
      if (clash) {
        refuse('Proposal No. "' + value + '" is already on "' +
          (clash.project || 'another bid') + '". It has to be unique.');
        return;
      }
    }

    if (field === 'project' && !value) { refuse('A project needs a name.'); return; }

    root.History.track(bid, function () {
      bid[field] = value;

      // Two fields have consequences beyond themselves.
      if (field === 'proposalNo') pushProposalNo(bid);
      if (field === 'dueDate' || field === 'revisedDueDate') {
        var effective = effectiveDueDate(bid);
        bid.month = effective ? U.parseDate(effective).getMonth() : bid.month;
      }
    });

    root.Store.save();
    refresh();
    repaintProject();
  }

  function saveBid(e) {
    e.preventDefault();
    var d = db();
    var id = U.$('editId').value;
    var typed = U.$('mDueDate').value.trim();
    var due = U.readDateField('mDueDate');
    if (typed && !due) {
      U.$('mDueDate').classList.add('border-danger', 'bg-danger-soft');
      U.$('mDueDate').focus();
      U.toast('Due date must be MM-DD-YYYY and a real date.', 'err');
      return;
    }

    // The revised date is optional, but if something has been typed into it, it
    // has to be a date - silently storing '' would look like it had been saved.
    var typedRev = U.$('mRevisedDueDate').value.trim();
    var revised = U.readDateField('mRevisedDueDate');
    if (typedRev && !revised) {
      U.$('mRevisedDueDate').classList.add('border-danger', 'bg-danger-soft');
      U.$('mRevisedDueDate').focus();
      U.toast('Revised due date must be MM-DD-YYYY and a real date.', 'err');
      return;
    }
    U.$('mRevisedDueDate').classList.remove('border-danger', 'bg-danger-soft');

    var pnField = U.$('mProposalNo');
    var clash = proposalNoOwner(pnField.value, id ? Number(id) : null);
    if (clash) {
      pnField.classList.add('border-danger', 'bg-danger-soft');
      pnField.focus();
      pnField.select();
      U.toast('Proposal No. "' + pnField.value.trim() + '" is already on "' +
        (clash.project || 'another bid') + '". It has to be unique.', 'err');
      return;
    }
    pnField.classList.remove('border-danger', 'bg-danger-soft');

    /* The "+ Add new region..." sentinel is a real, non-empty option value, so
       the field's `required` would happily let it through and the bid would be
       filed under a region called "__add". onRegionChange always puts the
       select back, so this should be unreachable - which is exactly why it is
       cheap to make certain of. */
    var regionField = U.$('mRegion');
    if (regionField.value === '__add') {
      regionField.focus();
      U.toast('Pick a region, or use "+ Add new region..." to create one.', 'err');
      return;
    }

    var rec = {
      proposalNo: pnField.value.trim(),
      project: U.$('mProject').value.trim(),
      portal: U.$('mPortal').value,
      region: U.$('mRegion').value,
      location: U.$('mLocation').value.trim(),
      products: selectedProducts(),
      material: U.$('mMaterial').value,
      engineer: U.$('mEngineer').value.trim(),
      price: U.$('mPrice').value === '' ? null : Number(U.$('mPrice').value),
      assignedHrs: U.n(U.$('mAssignedHrs').value),
      estHrs: U.n(U.$('mEstHrs').value),
      dueDate: due,
      revisedDueDate: revised,
      status: U.$('mStatus').value,
      link: U.$('mLink').value.trim(),
      comments: U.$('mComments').value.trim(),
      priceLocked: U.$('mPriceLocked').checked
    };
    // Filed under the month it is actually due, which is the revised date once
    // there is one - otherwise moving a deadline into the next month would
    // leave the bid sitting in the old one on the dashboard.
    var effective = revised || due;
    rec.month = effective ? U.parseDate(effective).getMonth() : new Date().getMonth();
    var saved;
    if (id) {
      var b = d.bids.filter(function (x) { return x.id === Number(id); })[0];
      // Snapshot before the assign, diff after - see History.track. This is the
      // whole form at once, so one Save that changed four fields is one entry
      // naming all four rather than four separate ones.
      var before = root.History.snapshot(b);
      Object.assign(b, rec);
      reconcileProductLines(b);
      root.History.recordEdit(b, root.History.diff(before, b));
      saved = b;
    } else {
      var nextId = d.bids.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
      var nextSr = d.bids.reduce(function (m, x) { return Math.max(m, Number(x.sr) || 0); }, 0) + 1;
      // No totalHrs: Estm and Asgn measure the same work two ways, so their sum
      // was never meaningful. The field stays on historical records - deleting
      // it from every bid would buy nothing - but nothing reads it any more.
      saved = Object.assign({
        id: nextId, sr: nextSr, inRegion: true, lf: null, bidHrs: 0,
        // When the enquiry arrived. A full timestamp, not a date: two bids
        // entered on the same morning still have an order, and All Bids is
        // read as an arrival log.
        createdAt: new Date().toISOString(),
        takeoffId: null, proposalId: null, awardNo: null, awardedAt: null,
        // Add Bid is how a received bid gets entered - that is intake, not a
        // decision to work it. "Add to Active bid" is the decision.
        active: false, activatedAt: null, decidedAt: null
      }, rec);
      d.bids.push(saved);
      reconcileProductLines(saved);
      // One entry, not a diff against nothing. Stamped with createdAt so the
      // log's first line and the Created column agree to the second.
      root.History.recordCreated(saved);
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
        'Location': b.location || '',
        'In Region': b.inRegion === false ? 'No' : 'Yes',
        'Product': (b.products || []).join('; '),
        'Material': b.material, 'LF': b.lf, 'Bid Price': b.price,
        'Intake Engineer': b.engineer,
        'Intake Est Hrs': b.estHrs, 'Intake Assigned Hrs': b.assignedHrs,
        'Team': root.Assign.engineerList(b).join('; '),
        'Team Est Hrs': t.est, 'Team Assigned Hrs': t.asgn,
        'Due Date': effectiveDueDate(b), 'Revised Due': b.revisedDueDate || '', 'Status': b.status,
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
          'Task Status': root.Assign.statusLabel(r), 'Completed': r.completedAt || '',
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
          Material: c.material, Grade: c.grade, 'U/M': c.um,
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
    renderAttention();
  }

  root.Bids = {
    /* The revised due date is chosen against the one it replaces, so the
       calendar opens with the original flagged rather than leaving somebody to
       remember it. Everything else on the form opens the plain picker. */
    openRevisedDuePicker: function () {
      var original = U.inputToDate((U.$('mDueDate') || {}).value || '');
      U.openDatePicker('mRevisedDueDate', {
        mark: original || null,
        markLabel: original ? 'The original due date, ' + U.date(original) : null,
        // Opens on the month the original is in, since that is the date being
        // moved - not on today, which may be months away from it.
        startAt: original || null,
        // The hint reads off the record's shape, and on the form the values are
        // in the boxes rather than on a bid - so it is handed the two dates as
        // they currently stand.
        onPick: function (picked) {
          renderRevisedDueHint({ dueDate: original, revisedDueDate: picked || '' });
        }
      });
    },

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
    renderAttention: renderAttention,
    populateRegionSelects: populateRegionSelects,
    populatePortalSelect: populatePortalSelect,

    /* For the Portals and Bid Statuses panels in js/settings.js: how many bids
       a value is on - the number that decides whether deleting it is safe - and
       the rename that carries onto them. Here rather than there because this
       module owns the bids; Settings owns the panel. */
    countPortal: countPortal,
    renamePortalOnBids: renamePortalOnBids,
    countStatus: countStatus,
    renameStatusOnBids: renameStatusOnBids,
    allStatuses: allStatuses,
    STATUS_TONES: TONES,

    // Drawn by js/settings.js, which supplies the hosts these write into.
    renderRegionList: renderRegionList,
    renderEngineerList: renderEngineerList,
    // Used by js/assignments.js so the team rows name people through the same
    // register the bid form does, rather than a second free-text field.
    findEngineer: findEngineer,
    addEngineer: addEngineer,
    populateEngineerList: populateEngineerList,

    /* One colour per person, drawn the same way wherever they are named - the
       schedule, the bid tables, Settings and the who-is-here markers. */
    PALETTE: PALETTE,
    colorOf: colorOf,
    colorClass: colorClass,
    personChip: personChip,
    setEngineerColor: setEngineerColor,
    engineerForUser: engineerForUser,
    colorPicker: colorPicker,
    toggleColorPicker: toggleColorPicker,

    STATUSES: STATUSES,
    bucketOf: bucketOf,
    onActiveOf: onActiveOf,
    /* The status table's row for one status key. js/ui.js reads the badge class
       off it to colour the charts, so the pie and the pills cannot disagree. */
    statusOf: statusOf,
    settableStatuses: settableStatuses,

    /* Re-opening a finished job: the original is left alone and a fresh
       revision entry opens beside it. */
    REOPENABLE: REOPENABLE,
    canReopen: canReopen,
    reopen: reopen,
    revisionBaseOf: revisionBaseOf,
    nextRevisionNo: nextRevisionNo,
    revisionNoText: revisionNoText,
    /* The entry this one came from, and the one it was re-opened into - so a
       page showing either end of the chain can offer the other. */
    originalOf: function (bid) {
      if (!bid || bid.revisionOf == null) return null;
      return bids().filter(function (b) { return b.id === bid.revisionOf; })[0] || null;
    },
    reopenedOf: function (bid) {
      if (!bid || bid.reopenedInto == null) return null;
      return bids().filter(function (b) { return b.id === bid.reopenedInto; })[0] || null;
    },

    /* The project number: allocated once, when a bid is picked up. */
    nextProjectNo: nextProjectNo,
    issueProjectNo: issueProjectNo,
    applyAward: applyAward,
    applyLost: applyLost,
    /* The date the project is working to - the revised one if there is one. */
    effectiveDueDate: effectiveDueDate,
    /* One field, edited in place on the project page - see UI.editableField. */
    saveField: saveField,
    promptDecision: promptDecision,
    confirmDecision: confirmDecision,
    closeDecisionModal: function () { U.$('decisionModal').classList.add('hidden'); },

    /* Opens the confirmation for one outcome. Whichever menu it was chosen from
       has already closed itself - BidGrid.menuItem dismisses before it acts. */
    decide: promptDecision,

    /* What the row's overflow menu offers this person. Exposed because it is
       where the per-role row actions actually live now - actionCell only draws
       the two workflow buttons and the control that opens this. */
    rowMenu: rowMenuItems,

    /* The row's overflow menu, hung off the grid's one popover. */
    openRowMenu: function (ev, id) {
      var bid = bids().filter(function (x) { return x.id === id; })[0];
      if (bid) root.BidGrid.openMenu(ev, rowMenuItems(bid));
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

    /* A dashboard tile, answered. The count says how many; this is the "which
       ones" behind it, the same bargain the month bars already make.

       All Bids rather than Active: it is the one list every status appears on,
       so the tile cannot land on a list that filters its own answer away. The
       status filter is repopulated by setView, which is why the value is set
       after switchTab rather than before. */
    goToStatus: function (status) {
      root.App.switchTab('all');
      var sel = U.$('filterStatus');
      if (sel) sel.value = status || '';
      filterTable();
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

      /* How long this person's day is. A number, not a string, and an empty box
         DELETES the key rather than storing 0 - blank means "whatever the shop
         works", and a stored zero would read as a person who is never available
         and show every booking they have as an overbooking. */
      if (field === 'dayHours') {
        var n = U.n(v);
        if (v === '') delete e.dayHours;
        else if (n > 0 && n <= 24) e.dayHours = n;
        else U.toast('A working day has to be between 0 and 24 hours.', 'warn');
        root.Store.save();
        renderEngineerList();
        refresh();
        return;
      }

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
        //
        // BOTH PLACES INITIALS APPEAR, not just the intake field. The Team &
        // Hours rows carry their own copy, and they were being left behind - so
        // renaming somebody detached every task they were booked to, which cost
        // them their colour on the schedule, their name on hover, and their
        // hours in the "who is free" figure, all silently.
        var old = e.initials;
        db().bids.forEach(function (b) {
          if (U.low(b.engineer) === U.low(old)) b.engineer = v;
          root.Assign.rows(b).forEach(function (r) {
            if (U.low(r.engineer) === U.low(old)) r.engineer = v;
          });
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

    onRegionChange: onRegionChange,
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
    /* A rename has to carry onto the bids using it, or those bids quietly lose
       their region - the same rule task types and engineer initials follow.
       Matched case-insensitively on purpose: correcting "beachwood, oh" to
       "Beachwood, OH" is the case this exists for, and an exact compare would
       leave those bids behind on a name no longer in the list. */
    renameRegion: function (from, value) {
      var d = db();
      var to = String(value || '').trim();
      var i = d.regions.indexOf(from);
      if (i < 0) return;
      // Cleared, or unchanged: put the old text back rather than leaving the
      // input showing something the list does not hold.
      if (!to) { renderRegionList(); return; }
      if (to === from) return;

      if (d.regions.some(function (r) {
        return r !== from && r.toLowerCase() === to.toLowerCase();
      })) {
        U.toast('"' + to + '" is already in the list.', 'warn');
        renderRegionList();
        return;
      }

      // In place, by index: renderRegionList draws a sorted copy, so writing
      // that back would reorder the stored list as a side effect of a rename.
      d.regions[i] = to;
      var moved = 0;
      d.bids.forEach(function (b) {
        if ((b.region || '').toLowerCase() === from.toLowerCase()) { b.region = to; moved++; }
      });

      root.Store.save();
      renderRegionList();
      populateRegionSelects();
      // The filter select may have been sitting on the old name.
      filterTable();
      refresh();
      U.toast(moved ? 'Renamed on ' + moved + ' bid' + (moved > 1 ? 's' : '') + '.' : 'Renamed.', 'ok');
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

  // The row menus are the grid's popover now, and js/bidgrid.js already closes
  // that on the next click anywhere and on any scroll - so there is nothing
  // left for this file to dismiss.
})(window);
