/* app.js - boot, tab routing and the header actions. */
(function (root) {
  'use strict';

  var U = root.U;
  var currentTab = 'active';

  /* What each page needs doing when it comes to the front. Pages absent from
     this table are static markup and need nothing. */
  var RENDERERS = {
    dashboard: function () {
      root.Bids.updateKPIs();
      root.Bids.renderMonthGrid();
      root.Bids.renderAttention();
      root.Bids.renderCharts();
    },
    all: function () { root.Bids.setView('all'); },
    active: function () { root.Bids.setView('active'); },
    awarded: function () { root.Bids.setView('awarded'); },
    takeoff: function () { root.Takeoff.render(); },
    ratelib: function () { root.RateLib.render(); },
    proposal: function () { root.Proposal.render(); },
    references: function () { root.References.render(); },
    project: function () { root.Project.render(); },
    prodoverview: function () { root.Production.render(); },
    salesorders: function () { root.SalesOrders.render(); },
    regions: function () { root.Settings.render(); },
    engineers: function () { root.Settings.render(); },
    tasktypes: function () { root.Settings.render(); },
    materials: function () { root.Settings.render(); },
    portals: function () { root.Settings.render(); },
    statuses: function () { root.Settings.render(); },
    company: function () { root.Settings.render(); },
    employees: function () { root.Settings.render(); },
    roles: function () { root.Settings.render(); }
  };

  /* Every caller in the app still says App.switchTab('proposal'); Nav works out
     which module owns that page and brings it forward too. */
  function switchTab(tab) {
    // A page this role may not open - a bookmark, a restored session, or a
    // permission taken away since they last signed in. Land somewhere they can
    // work rather than on a blank screen with no way out.
    if (!root.Nav.mayOpen(tab)) {
      var fallback = root.Nav.firstAllowedSection();
      if (!fallback || fallback === tab) return;
      tab = fallback;
    }
    if (!root.Nav.setCurrent(tab)) return;
    // A bid still in the intake stage has no takeoff or proposal to show. The
    // tabs are not offered there, but a restored session or a bookmarked
    // ?section=takeoff can still ask for one; land on the Overview instead of
    // a page the project bar has no way back from.
    if (root.Nav.current.module === 'project' && !root.Project.allowsSection(tab)) {
      tab = 'project';
      root.Nav.setCurrent(tab);
    }
    currentTab = tab;
    clearNotice();                 // a page drawn fresh is up to date

    var target = root.Nav.domOf(tab);
    root.Nav.domIds().forEach(function (id) {
      var sec = U.$(id);
      if (sec) sec.classList.toggle('hidden', id !== target);
    });

    root.Nav.render();
    root.Nav.persist();
    if (RENDERERS[tab]) RENDERERS[tab]();

    // Tell the office where this window is now. Here rather than inside
    // Project, because leaving a project is as much a move as arriving at one
    // and only this function sees both.
    if (root.Presence) {
      var onProject = root.Nav.current.module === 'project';
      var bid = onProject && root.Project.currentBid();
      // On a takeoff, which product - so the others in it can see who is on
      // what, and steer clear before two people type in the same rows.
      var where = tab === 'takeoff' && root.Takeoff.presenceSection ? root.Takeoff.presenceSection() : tab;
      root.Presence.here(bid ? bid.id : null, where);
    }
  }

  /* ---- boot ------------------------------------------------------------ */

  function init() {
    showBooting();
    // Who is asking comes first. Until Auth resolves, the overlay owns the
    // screen and nothing has been read out of the database - so no module can
    // render data the person signing in is not entitled to see.
    root.Auth.begin()
      .then(function () { return root.Store.open(); })
      .then(function () {
        root.Rates.ensure(root.Store.db);
        root.Catalog.ensure(root.Store.db);
        root.Store.save();

        // The <head> script already put the class on from the localStorage
        // mirror; this reconciles it with the database, which is the record -
        // and rewrites the mirror if they had drifted.
        applyTheme();
        watchSystemTheme();

        wireSaveIndicator();
        wireExternalChanges();
        wireShortcuts();
        reportBackend();
        renderHeaderActions();
        root.Auth.renderChip();

        if (root.Nav.isPopout()) document.body.classList.add('popout');

        root.U.wireDateField('mDueDate');
        root.U.wireDateField('mRevisedDueDate');
        // After the store, so it knows whether there is a server to be present
        // on; before resumeLastSession, so the page it lands on is announced.
        root.Presence.start();
        root.Bids.refresh();
        resumeLastSession();
        hideBooting();
        if (root.Store.restored) {
          U.toast('Recovered ' + plural(root.Store.restored, 'unsaved change') +
            ' from your last session. Sending ' + (root.Store.restored === 1 ? 'it' : 'them') + ' now.', 'info');
        }
      })
      .catch(function (err) {
        console.error(err);
        showBootFailure(err);
      });

    // Best effort: an IndexedDB write started here usually completes, but the
    // debounce is short enough that there is rarely anything pending.
    root.addEventListener('pagehide', function () { root.Store.flush(); });
    root.addEventListener('beforeunload', function (e) {
      root.Store.flush();
      /* Nothing is lost by leaving - unsent edits are on disk and the next
         page sends them - but somebody closing a tab while offline should
         know their work has not reached anyone else yet. */
      if (root.Store.shared && !root.Store.online && root.Store.pendingCount()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* Reopen the takeoff and proposal that were last in use, then land on the
     page this window is addressed to. A popout reads these but never writes
     them - see Nav.persist. */
  function resumeLastSession() {
    var ui = root.Store.db.ui;

    /* WHERE WE ARE GOING IS DECIDED FIRST, BEFORE ANYTHING REOPENS.

       Takeoff.openTakeoff and Proposal.open each navigate to their own page as
       part of opening - which runs switchTab, which runs Nav.persist, which
       writes this tab's marker. So reopening the last proposal SET the marker
       to 'proposal', and initialSection() - read afterwards - then found it
       there and went straight to the proposal.

       Every load, whatever you were actually doing. Closing the proposal and
       moving elsewhere did not help either: the next boot reopened it and
       overwrote the marker again before reading it. The landing page has to be
       read before boot has a chance to write over its own input. */
    var target = root.Nav.initialSection();

    // A popped-out TakeOff/Proposal is addressed with its bid; otherwise pick
    // up whichever project the main window was last on.
    var bidId = root.Nav.initialBidId();
    // Then the project THIS tab was on, which is what a reload should restore.
    // ui.projectBidId is shared by every tab of this account, so with two open
    // on two projects it is whichever one navigated last - fine as a last
    // resort, wrong as a first choice.
    if (bidId == null) bidId = root.Nav.tabBidId();
    if (bidId == null) bidId = ui.projectBidId;
    if (bidId != null) root.Project.setBid(bidId);
    // The sales order that was open, open again.
    if (root.SalesOrders) root.SalesOrders.restore();
    if (ui.lastTakeoffId && root.Store.db.takeoffs[ui.lastTakeoffId]) {
      root.Takeoff.openTakeoff(ui.lastTakeoffId);
    }
    if (ui.lastProposalId && root.Store.db.proposals[ui.lastProposalId]) {
      root.Proposal.open(ui.lastProposalId);
    }
    // Both of the above re-render their own page; switching last decides which
    // one is actually on screen.
    switchTab(target);
  }

  function showBooting() {
    var el = U.$('bootOverlay');
    if (el) el.classList.remove('hidden');
  }
  function hideBooting() {
    var el = U.$('bootOverlay');
    if (el) el.classList.add('hidden');
  }
  function showBootFailure(err) {
    var el = U.$('bootOverlay');
    if (!el) return;
    el.classList.remove('hidden');
    el.innerHTML =
      '<div class="max-w-lg text-center px-6">' +
        '<div class="w-16 h-16 bg-danger-soft rounded-full flex items-center justify-center mx-auto mb-4">' +
          '<i class="fas fa-database text-danger text-2xl"></i></div>' +
        '<h2 class="text-lg font-bold text-ink-strong mb-2">Could not open the local database</h2>' +
        '<p class="text-sm text-muted mb-4">' + U.esc(err && err.message ? err.message : String(err)) + '</p>' +
        '<p class="text-sm text-muted">If you opened this file directly, try running ' +
        '<code class="bg-neutral-soft px-1.5 py-0.5 rounded">node serve.js</code> in the project ' +
        'folder and visiting <code class="bg-neutral-soft px-1.5 py-0.5 rounded">http://localhost:9000</code> instead.</p>' +
      '</div>';
  }

  /* The footer used to say "Auto-saved" as static text, which was decoration.
     With an async database a silent write failure would otherwise be invisible. */
  /* Two things, kept apart because conflating them is how a screen said
     "online" while the server did not have the edit: whether this window can
     reach the server, and whether everything typed here has got there. "Saved"
     now appears only when the count of unsent records is zero.

     Clicking it sends whatever is waiting straight away, rather than after the
     retry's backoff. */
  function wireSaveIndicator() {
    var lastSaved = null;
    root.Store.onStatus(function (s) {
      var pending = s.pending || 0;
      if (s.state === 'saved' && !pending) lastSaved = s.at;

      // The banner: only when something is actually waiting on the network.
      var bar = U.$('offlineBar');
      if (bar) {
        var waiting = s.state === 'offline' && pending > 0;
        bar.classList.toggle('hidden', !waiting);
        if (waiting) {
          bar.querySelector('.offline-message').textContent = 'Offline - ' + plural(pending, 'change') +
            ' kept on this computer, and sent automatically when the connection returns.' +
            ' Keep working; nothing is lost.';
        }
      }

      // Looked up per update, not once: in a popped-out window the indicator
      // lives in a header js/nav.js has not rendered yet at wire time.
      var el = U.$('saveIndicator');
      if (!el) return;
      var time = function (d) {
        return d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      };
      var waitingText = pending ? plural(pending, 'change') + ' waiting' : '';
      var map = {
        idle: ['fa-clock', 'text-faint', 'Ready'],
        dirty: ['fa-pen', 'text-warn', 'Unsaved changes'],
        saving: ['fa-circle-notch fa-spin', 'text-brand', 'Saving...'],
        saved: pending
          ? ['fa-pen', 'text-warn', waitingText]
          : ['fa-check-circle', 'text-ok', 'All changes saved ' + time(s.at)],
        error: ['fa-exclamation-triangle', 'text-danger', 'Not saved - ' + (s.error || 'refused by the server')],
        nostore: ['fa-exclamation-triangle', 'text-danger', 'Not being saved'],
        offline: ['fa-plug-circle-xmark', 'text-danger',
          pending ? 'Offline - ' + waitingText + ', retrying' : 'Offline'],
        conflict: ['fa-code-branch', 'text-warn', 'Busy record - ' + (waitingText || 'retrying')]
      };
      var m = map[s.state] || map.idle;
      // The dot is the connection, the words are the saving.
      var dot = root.Store.shared
        ? '<span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ' +
          (s.live ? 'bg-ok' : 'bg-danger') + '"></span>'
        : '';
      el.innerHTML = dot + '<i class="fas ' + m[0] + ' mr-1 ' + m[1] + '"></i>' + U.esc(m[2]);
      el.title = (s.live ? 'Connected to the server.' : 'Not connected to the server.') +
        (pending ? ' ' + plural(pending, 'record') + ' not yet saved - click to send now.' : '') +
        (lastSaved ? ' Last saved ' + time(lastSaved) + '.' : '') +
        (s.error && s.state !== 'saved' ? '\nLast error: ' + s.error : '');
      el.style.cursor = pending ? 'pointer' : '';
      el.onclick = pending ? function () { root.Store.retryNow(); } : null;
    });
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /* Somebody else's edit arriving - from another tab on this machine, or from
     another person on the shared server. Either way the rule is the same: the
     screen catches up, unless somebody is mid-edit - in which case a bar
     appears, and the repaint waits until they have finished rather than being
     dropped altogether. */

  /* IS SOMEBODY IN THE MIDDLE OF SOMETHING.

     Three ways to be mid-edit, and a repaint would wreck all of them: the
     cursor in a field, an inline editor open on the project card (UI.beginEdit
     marks its host data-editing), or a modal up. The first was already
     checked; the other two were not, and a colleague's save arriving while the
     Add Bid form was open rebuilt the page behind it. */
  function midEdit() {
    var el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    if (document.querySelector('[data-editing]')) return true;
    if (document.querySelector('.modal-overlay:not(.hidden)')) return true;
    return false;
  }

  /* A repaint that was held back because of the above. It is run as soon as the
     edit finishes, so the screen catches up on its own rather than leaving the
     banner as the only way to see what changed. */
  var deferred = null;

  /* Only the latest is kept: two changes arriving while you type need one
     repaint between them, not two. */
  function defer(fn) { deferred = fn; }

  function runDeferred() {
    if (!deferred || midEdit()) return;
    var fn = deferred;
    deferred = null;
    fn();
  }

  /* SOMEBODY ELSE'S SAVE, AND WHAT IT DOES TO THIS SCREEN.
   *
   * It used to repaint whatever page was up, every time - so with three people
   * typing in takeoffs, somebody reading a proposal had it rebuilt under them
   * every few seconds and thrown back to the top. Now it depends on the page:
   *
   *   a list (dashboard, the bid tables, settings lists) - nobody types there
   *     for long, and a live list is what is expected: repainted in place,
   *     scroll kept, held back while a field has the cursor;
   *   an editor (takeoff, proposal, project) showing a DIFFERENT record - not
   *     touched at all, only the project bar's figures;
   *   an editor showing THIS record - not repainted either. The change is
   *     already merged into the data underneath, and every handler addresses
   *     rows and items by id, so carrying on typing is safe. A slim notice
   *     names who changed what, and Show changes repaints, keeping the place.
   *     The person's own next edit repaints anyway and takes the notice down.
   */
  var EDITOR_TABS = { takeoff: true, proposal: true, project: true };

  /* Pages that are a list until a record is opened in them - then an editor,
     and a colleague's save must not repaint under the person typing. Each
     answers with the 'kind:id' it has open, or null when it is showing the
     list. */
  var RECORD_PAGES = {
    salesorders: function () {
      var id = root.SalesOrders && root.SalesOrders.openId();
      return id ? ['salesorder:' + id] : null;
    }
  };
  var notice = { names: [], what: [], count: 0, clashes: [] };

  /* 'kind:id' of the records the editor on screen is showing. */
  function openRecords() {
    var keys = {};
    if (currentTab === 'takeoff' && root.Takeoff.currentId()) keys['takeoff:' + root.Takeoff.currentId()] = true;
    if (currentTab === 'proposal' && root.Proposal.currentId()) keys['proposal:' + root.Proposal.currentId()] = true;
    var rec = RECORD_PAGES[currentTab] && RECORD_PAGES[currentTab]();
    if (rec) rec.forEach(function (k) { keys[k] = true; });
    var bid = root.Project && root.Project.currentBid ? root.Project.currentBid() : null;
    if (bid && currentTab === 'project') {
      keys['bid:' + bid.id] = true;
      if (bid.takeoffId) keys['takeoff:' + bid.takeoffId] = true;
      if (bid.proposalId) keys['proposal:' + bid.proposalId] = true;
    }
    return keys;
  }

  /* What moved inside a takeoff or proposal, in words a person recognises:
     the products (or scope items) whose content differs from before. */
  function whatChanged(c, beforeJson) {
    var coll = c.kind === 'takeoff' ? root.Store.db.takeoffs : root.Store.db.proposals;
    var now = coll && coll[c.id];
    var was = beforeJson ? JSON.parse(beforeJson) : null;
    if (!now) return [];
    var list = c.kind === 'takeoff' ? (now.products || []) : (now.scopeItems || []);
    var old = {};
    ((was && (c.kind === 'takeoff' ? was.products : was.scopeItems)) || []).forEach(function (x) {
      old[x.id] = JSON.stringify(x);
    });
    var names = list.filter(function (x) { return old[x.id] !== JSON.stringify(x); })
      .map(function (x) { return c.kind === 'takeoff' ? x.type : (x.description || 'a scope item'); });
    if (!names.length) names.push(c.kind === 'takeoff' ? 'this takeoff' : 'this proposal');
    return names;
  }

  function remoteArrived(info, busy) {
    var open = openRecords();
    var bid = root.Project && root.Project.currentBid ? root.Project.currentBid() : null;

    var recordOpen = RECORD_PAGES[currentTab] && RECORD_PAGES[currentTab]();
    if (!EDITOR_TABS[currentTab] && !recordOpen) {
      // A list. Live, quietly, and never under somebody's cursor.
      if (busy) { defer(repaint); return; }
      repaint();
      return;
    }

    // The project bar's figures - the price a takeoff edit has moved - follow
    // along without the page underneath being touched.
    if (bid && info.changes.some(function (c) { return c.kind === 'bid' && String(c.id) === String(bid.id); })) {
      root.Project.renderHeader();
    }

    var mine = info.changes.filter(function (c) { return open[c.kind + ':' + c.id]; });
    if (!mine.length) return;

    var who = info.by || 'Someone';
    if (notice.names.indexOf(who) < 0) notice.names.push(who);
    mine.forEach(function (c) {
      notice.count++;
      if (c.kind === 'takeoff' || c.kind === 'proposal') {
        whatChanged(c, info.before && info.before[c.kind + ':' + c.id]).forEach(function (n) {
          if (notice.what.indexOf(n) < 0) notice.what.push(n);
        });
      } else {
        var what = c.kind === 'salesorder' ? 'this sales order' : 'the project details';
        if (notice.what.indexOf(what) < 0) notice.what.push(what);
      }
      (c.clashes || []).forEach(function (p) {
        var f = root.Merge ? root.Merge.describe({ path: p }) : p;
        if (notice.clashes.indexOf(f) < 0) notice.clashes.push(f);
      });
    });
    showNotice();
  }

  function showNotice() {
    var el = U.$('liveNotice');
    if (!el) return;
    var names = notice.names.length <= 2 ? notice.names.join(' and ')
      : notice.names.slice(0, 2).join(', ') + ' and ' + (notice.names.length - 2) + ' more';
    // One line, always: the first thing by name (scope items lose the
    // "Supply and Installation of" every one of them starts with), the rest
    // counted, and the full list on hover.
    var short = function (n) {
      n = String(n).replace(/^Supply and Installation of\s+/i, '');
      return n.length > 40 ? n.slice(0, 39) + '…' : n;
    };
    var what = short(notice.what[0] || 'this page') +
      (notice.what.length > 1 ? ' and ' + (notice.what.length - 1) + ' more' : '');
    el.querySelector('.live-who').textContent = names;
    el.querySelector('.live-what').textContent = 'updated ' + what +
      (notice.count > 1 ? ' · ' + notice.count + ' changes' : '');
    el.title = notice.names.join(', ') + ' changed: ' + notice.what.join('; ');
    el.querySelector('.live-clash').textContent = notice.clashes.length
      ? 'Their value for ' + notice.clashes.slice(0, 3).join(', ') + ' is now in.' : '';
    el.classList.remove('hidden');
  }

  function clearNotice() {
    notice = { names: [], what: [], count: 0, clashes: [] };
    var el = U.$('liveNotice');
    if (el) el.classList.add('hidden');
  }

  function wireExternalChanges() {
    root.Store.onExternalChange(function (info) {
      var bar = U.$('externalChangeBar');
      if (!bar) return;
      var busy = midEdit();

      // A remote change is already applied to the in-memory copy by the time we
      // hear about it, so there is nothing to reload - only, perhaps, to repaint.
      if (info && info.remote) {
        if (info.conflicts && info.conflicts.length) clashToast(info.conflicts, info.by);
        remoteArrived(info, busy);
        return;
      }

      if (busy) {
        bar.classList.remove('hidden');
        defer(function () {
          root.Store.reload().then(function () {
            bar.classList.add('hidden');
            repaint();
          });
        });
        return;
      }
      root.Store.reload().then(function () {
        repaint();
        U.toast('Updated from another window.', 'info');
      });
    });

    /* The moment the edit ends. focusout covers the field and the inline editor
       (which commits on blur); the click catches a modal being dismissed. Both
       are checked a tick later, because at the instant of a blur the focus has
       not landed on whatever is next - and tabbing between two fields is not
       the end of anything. */
    function later() { setTimeout(runDeferred, 0); }
    document.addEventListener('focusout', later);
    document.addEventListener('click', later);

    /* A conflict is the one case where somebody's own edit did not stick: the
       server had a newer copy. Say so plainly rather than letting the screen
       silently revert. */
    root.Store.onConflict(function (body) {
      if (body.error === 'duplicate') {
        U.toast(body.message + ' Change it to save that bid - everything else you type is still being saved.', 'err');
        return;
      }
      /* Records this person's role cannot write. They have been put back the
         way the server has them and the rest of their work has gone up - say
         which part did not, in words rather than a permission key. */
      if (body.error === 'refused') {
        var kinds = {};
        (body.refused || []).forEach(function (r) { kinds[r.kind] = true; });
        var what = Object.keys(kinds).map(function (k) {
          return k === 'catalog' ? 'the Rate Library' : k === 'setting' ? 'the shop settings'
            : k === 'engineer' ? 'the engineer list' : k === 'bid' ? 'that bid' : 'a ' + k;
        }).join(' or ');
        U.toast('Your role cannot change ' + what + ', so that part was not saved. ' +
          'Everything else was. Ask an Admin if it needs changing.', 'warn');
        repaint();
        return;
      }
      /* Both edits were kept and merged. The only thing worth saying is a
         field the two people changed to different values - this screen's
         value stood, and the person should know to check it. */
      if (body.error === 'merged') {
        clashToast(body.conflicts);
        return;
      }
      repaint();
      U.toast('Somebody else is saving this record continuously. Your edit is still here and ' +
        'will be sent again in a moment.', 'warn');
    });
  }

  /* One wrapper covers every page: Bids.refresh rebuilds the table, and the
     renderers rebuild the project card, the takeoff and the settings pages the
     same way. Without it a repaint you did not ask for scrolls the screen back
     to the top left - see U.preserveView. */
  function repaint() {
    U.preserveView(function () {
      root.Bids.refresh();
      if (RENDERERS[currentTab]) RENDERERS[currentTab]();
    });
  }

  /* "You and Priya both changed qty; yours was kept." One toast for however
     many fields, named rather than counted when there are only a few. */
  function clashToast(conflicts, by) {
    if (!conflicts || !conflicts.length) return;
    var names = [];
    conflicts.forEach(function (c) {
      var n = root.Merge ? root.Merge.describe(c) : 'a value';
      if (names.indexOf(n) < 0) names.push(n);
    });
    var who = by || (conflicts[0] && conflicts[0].by) || 'someone else';
    var what = names.length <= 3 ? names.join(', ') : names.length + ' fields';
    U.toast('You and ' + who + ' both changed ' + what + ' at the same time. Your value was kept - ' +
      'check it if that is not what you meant.', 'warn');
  }

  function wireShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var open = document.querySelectorAll('.modal-overlay:not(.hidden)');
        if (open.length) {
          open[open.length - 1].classList.add('hidden');
          e.preventDefault();
        }
        return;
      }
      /* Ctrl+S used to download a .json backup. There is nothing to download
         any more - every edit is already written - but the reflex is real and
         the browser's own "Save page as" is worse than useless here. So it
         still means something: push anything queued out now, and say so. */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        root.Store.flush().then(function () { U.toast('Saved.', 'ok'); });
      }
    });
  }

  /* ---- theme ----------------------------------------------------------- */

  /* Light, dark, or whatever the machine is set to.

     The setting is the person's, so it lives in db.ui.theme and travels with
     the rest of their layout. It is ALSO mirrored into localStorage, because
     the database opens asynchronously and the page has already been painted by
     then - the inline script in the <head> reads that mirror and puts the class
     on <html> before the first pixel, which is what stops a dark app flashing
     white on every load. The database stays the record; localStorage is a cache
     of one string, and applyTheme() below rewrites it from the record on boot.

     Nothing else in the app knows a theme exists: the colours are CSS variables
     in assets/tokens.css and .dark simply redefines them. There is not one
     dark: variant anywhere in these files. */
  var THEMES = ['light', 'dark', 'auto'];
  var THEME = {
    light: { icon: 'fa-sun', label: 'Light' },
    dark:  { icon: 'fa-moon', label: 'Dark' },
    auto:  { icon: 'fa-circle-half-stroke', label: 'Match the system' }
  };

  function prefersDark() {
    return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function themeSetting() {
    var t = root.Store && root.Store.db && root.Store.db.ui && root.Store.db.ui.theme;
    return THEMES.indexOf(t) >= 0 ? t : 'auto';
  }

  function themeIcon() { return THEME[themeSetting()].icon; }

  function themeTitle() {
    var t = themeSetting();
    var next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    return 'Theme: ' + THEME[t].label + ' - click for ' + THEME[next].label.toLowerCase();
  }

  function applyTheme() {
    var t = themeSetting();
    document.documentElement.classList.toggle('dark', t === 'dark' || (t === 'auto' && prefersDark()));
    try { root.localStorage.setItem('dv.theme', t); } catch (e) { /* private mode */ }
  }

  /* On 'auto', the machine can change its mind while the app is open - at
     sunset, on most of them. Wired once, and it does nothing on the two
     explicit settings. */
  function watchSystemTheme() {
    if (!root.matchMedia) return;
    var q = root.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (themeSetting() === 'auto') repaintTheme(); };
    if (q.addEventListener) q.addEventListener('change', onChange);
    else if (q.addListener) q.addListener(onChange);       // Safari < 14
  }

  /* The charts are the one thing that does not follow a theme on its own:
     Chart.js bakes the colours into the instance when it is built, so they have
     to be rebuilt. Everything else is CSS and has already changed by now. */
  function repaintTheme() {
    applyTheme();
    renderHeaderActions();
    if (currentTab === 'dashboard') RENDERERS.dashboard();
  }

  /* The header buttons. One table, each with the permission it needs, for the
     same reason Nav.MENU carries one: the access levels are legible in a column
     instead of scattered through markup.

     SAVE AND LOAD USED TO LIVE HERE AND ARE GONE. They were a whole-database
     round trip through a .json file, written when the app ran off one browser's
     storage and a backup was the only way to move the data anywhere. It runs off
     a shared SQLite file now, synced live - so Save handed you a copy that was
     stale the moment a colleague typed, and Load wrote that stale copy over
     everyone's afternoon. Backing the office up is copying diverse.db; there is
     nothing for a button to do. */
  var HEADER_ACTIONS = [
    /* The theme, cycling light -> dark -> auto. No permission and no `when`:
       it is nobody's data, only how this person's eyes are getting on with the
       screen, and it has to be reachable on the single-user path too - where
       there is no account and therefore no user menu to put it in.
       Icon-only; the tooltip says which way the next click goes. */
    { icon: themeIcon, onclick: 'App.cycleTheme()', title: themeTitle, when: yes },
    /* The guide. No permission either, and for the same reason: it is not
       anybody's data, it is what the buttons around it mean. */
    { icon: 'fa-circle-question', onclick: 'Guide.open()', when: yes,
      title: 'User guide - what each part of the app does' },
    /* Settings holds panels governed by three different permissions, so the
       button appears when any one of them lets this person in rather than being
       tied to a single key. */
    { label: 'Settings', icon: 'fa-gear', onclick: 'App.openSettings()',
      when: function () { return !!root.Nav.firstSectionOf('settings'); },
      title: 'Rate Library, References, Regions, People' }
  ];

  /* Both are read at render time rather than being fixed strings, because the
     theme button has to show the state it is currently in. */
  function value(v) { return typeof v === 'function' ? v() : v; }
  function yes() { return true; }

  function renderHeaderActions() {
    var host = U.$('headerActions');
    if (host) {
      host.innerHTML = HEADER_ACTIONS.filter(function (a) {
        return a.when ? a.when() : root.Auth.can(a.perm);
      }).map(function (a) {
        var label = value(a.label);
        return '<button onclick="' + a.onclick + '" title="' + U.escAttr(value(a.title)) + '" ' +
          'class="bg-chrome-soft hover:bg-chrome-soft/70 text-white ' +
          (label ? 'px-3' : 'px-2.5') + ' py-2 rounded-lg text-sm ' +
          'font-medium transition flex items-center gap-2">' +
          '<i class="fas ' + value(a.icon) + '"></i>' + (label ? ' ' + U.esc(label) : '') + '</button>';
      }).join('');
    }
    // Reset wipes the database back to seed data, and it was never meant to be
    // within reach of everybody on a shared server. project.load is the key
    // that gates it - it used to gate restoring a backup over everything, which
    // is the same blast radius, and it kept the narrower job when that button
    // went. See the note on it in server/permissions.js.
    var reset = U.$('resetButton');
    if (reset) reset.classList.toggle('hidden', !root.Auth.can('project.load'));
  }

  function reportBackend() {
    var b = root.Store.backend;
    // 'server' is the good case: one shared database for the whole office.
    // 'indexeddb' is the good case when there is no server to talk to.
    if (b === 'server' || b === 'indexeddb') return;
    var bar = U.$('storageWarning');
    if (!bar) return;
    bar.classList.remove('hidden');
    bar.innerHTML = b === 'localstorage'
      ? '<i class="fas fa-exclamation-triangle mr-2"></i>This browser is using the small ' +
        'localStorage fallback, so project documents are unavailable and large projects may ' +
        'fail to save. Run <code class="bg-warn/20 px-1 rounded">node serve.js</code> and ' +
        'open <code class="bg-warn/20 px-1 rounded">http://localhost:9000</code> for the full database.'
      : '<i class="fas fa-exclamation-triangle mr-2"></i><strong>Nothing is being saved.</strong> ' +
        'No browser storage is available, so all changes will be lost when this tab closes. ' +
        'Run <code class="bg-warn/20 px-1 rounded">node serve.js</code> and open ' +
        '<code class="bg-warn/20 px-1 rounded">http://localhost:9000</code> before entering anything.';
  }

  root.App = {
    switchTab: switchTab,
    init: init,
    /* Exported so the boot path can be exercised without reloading the window.
       The ordering inside it is the whole point and was wrong once - see the
       note there - so it needs to be something a test can actually run. */
    resumeLastSession: resumeLastSession,
    get currentTab() { return currentTab; },

    /* Light -> dark -> auto -> light. Three states behind one button rather
       than a switch, because "match the system" is a real third answer and not
       the absence of the other two. */
    cycleTheme: function () {
      var next = THEMES[(THEMES.indexOf(themeSetting()) + 1) % THEMES.length];
      root.Store.db.ui.theme = next;
      root.Store.save();
      repaintTheme();
      U.toast('Theme: ' + THEME[next].label.toLowerCase() + '.', 'info');
    },

    /* Reopens on the panel you were last on rather than always the first one. */
    openSettings: function () {
      var last = root.Store.db.ui.settingsSection;
      var owner = root.Nav.ownerOf(last);
      var ok = owner && owner.key === 'settings' && root.Nav.mayOpen(last);
      // Not always the Rate Library: a role with People but no shop settings
      // would land on a panel it cannot open.
      var target = ok ? last : root.Nav.firstSectionOf('settings');
      if (target) switchTab(target);
    },

    /* The live notice's two buttons, and the editors telling it the screen is
       current again (any render of the page they own draws the merged data). */
    showLiveChanges: function () { clearNotice(); repaint(); },
    dismissLiveNotice: function () { clearNotice(); },
    screenIsCurrent: function () { clearNotice(); },

    dismissExternalChange: function () {
      U.$('externalChangeBar').classList.add('hidden');
    },
    reloadFromDisk: function () {
      root.Store.reload().then(function () {
        U.$('externalChangeBar').classList.add('hidden');
        root.Bids.refresh();
        switchTab(currentTab);
        U.toast('Reloaded.', 'ok');
      });
    },
    resetAll: function () {
      var answer = prompt((root.Store.shared
        ? 'This wipes the SHARED database for everyone in the office and restores the seed bids.'
        : 'This wipes all local data and restores the seed bids.') +
        '\n\nType RESET to confirm:');
      if (answer !== 'RESET') return;
      root.Store.reset();
      root.Bids.refresh();
      switchTab('active');
      U.toast('Reset to seed data.', 'ok');
    },
    /* Clicking a month on the Dashboard should still narrow the bid list, which
       now lives on another page. */
    goToMonth: function (m) {
      switchTab('all');
      U.$('filterMonth').value = m === null ? '' : m;
      root.Bids.filterTable();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
