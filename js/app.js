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
    regions: function () { root.Settings.render(); },
    engineers: function () { root.Settings.render(); },
    tasktypes: function () { root.Settings.render(); },
    materials: function () { root.Settings.render(); },
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
      root.Presence.here(bid ? bid.id : null, tab);
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
      })
      .catch(function (err) {
        console.error(err);
        showBootFailure(err);
      });

    // Best effort: an IndexedDB write started here usually completes, but the
    // debounce is short enough that there is rarely anything pending.
    root.addEventListener('pagehide', function () { root.Store.flush(); });
    root.addEventListener('beforeunload', function () { root.Store.flush(); });
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
  function wireSaveIndicator() {
    root.Store.onStatus(function (s) {
      // Looked up per update, not once: in a popped-out window the indicator
      // lives in a header js/nav.js has not rendered yet at wire time.
      var el = U.$('saveIndicator');
      if (!el) return;
      var time = s.at ? s.at.toLocaleTimeString('en-US',
        { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      var map = {
        idle: ['fa-clock', 'text-faint', 'Ready'],
        dirty: ['fa-pen', 'text-warn', 'Unsaved changes'],
        saving: ['fa-circle-notch fa-spin', 'text-brand', 'Saving...'],
        saved: ['fa-check-circle', 'text-ok', 'Saved ' + time],
        error: ['fa-exclamation-triangle', 'text-danger', 'Save failed'],
        nostore: ['fa-exclamation-triangle', 'text-danger', 'Not being saved'],
        offline: ['fa-plug-circle-xmark', 'text-danger', 'Offline'],
        conflict: ['fa-code-branch', 'text-warn', 'Changed by someone else']
      };
      var m = map[s.state] || map.idle;
      el.innerHTML = '<i class="fas ' + m[0] + ' mr-1 ' + m[1] + '"></i>' + U.esc(m[2]);
    });
  }

  /* Somebody else's edit arriving - from another tab on this machine, or from
     another person on the shared server. Either way the rule is the same: the
     screen catches up, unless the cursor is in a field, in which case a bar
     appears instead of the value being yanked out from under them. */
  function wireExternalChanges() {
    root.Store.onExternalChange(function (info) {
      var bar = U.$('externalChangeBar');
      if (!bar) return;
      var typing = document.activeElement &&
        /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);

      // A remote change is already applied to the in-memory copy by the time we
      // hear about it, so there is nothing to reload - only to repaint.
      if (info && info.remote) {
        var who = info.by ? U.esc(info.by) : 'Someone else';
        if (typing) {
          bar.classList.remove('hidden');
          bar.querySelector('.change-message').innerHTML =
            who + ' changed this project while you were typing. Your edit is still here.';
          return;
        }
        repaint();
        U.toast(who + ' updated ' + describe(info.changes) + '.', 'info');
        return;
      }

      if (typing) { bar.classList.remove('hidden'); return; }
      root.Store.reload().then(function () {
        repaint();
        U.toast('Updated from another window.', 'info');
      });
    });

    /* A conflict is the one case where somebody's own edit did not stick: the
       server had a newer copy. Say so plainly rather than letting the screen
       silently revert. */
    root.Store.onConflict(function (body) {
      if (body.error === 'duplicate') {
        U.toast(body.message, 'err');
        return;
      }
      repaint();
      U.toast('That bid was changed by someone else first, so their version is ' +
        'showing. Re-apply your edit if you still want it.', 'warn');
    });
  }

  function repaint() {
    root.Bids.refresh();
    if (RENDERERS[currentTab]) RENDERERS[currentTab]();
  }

  function describe(changes) {
    if (!changes || !changes.length) return 'a record';
    if (changes.length > 1) return changes.length + ' records';
    var kind = changes[0].kind;
    return kind === 'bid' ? 'a bid'
      : kind === 'takeoff' ? 'a takeoff'
      : kind === 'proposal' ? 'a proposal'
      : kind === 'setting' ? 'the settings' : 'a record';
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        App.saveProject();
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

  /* The three whole-database buttons in the header. One table, each with the
     permission it needs, for the same reason Nav.MENU carries one: the access
     levels are legible in a column instead of scattered through markup.

     Load is Admin-only. On a single-user app it replaced your own data; on a
     shared server it replaces everyone's, so it is not an ordinary action any
     more. Save - downloading a backup - stays open to all, as drawn. */
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
    { label: 'Save', icon: 'fa-save', onclick: 'App.saveProject()', perm: 'project.save',
      title: 'Download a .json backup of everything' },
    { label: 'Load', icon: 'fa-folder-open', onclick: 'App.pickProjectFile()', perm: 'project.load',
      title: 'Restore from a .json backup - replaces the shared database for everyone' },
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
    // Reset wipes the database back to seed data - the same blast radius as
    // Load, and it was never meant to be within reach of everybody on a shared
    // server. It stays hidden unless the role may restore a backup.
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
        'Use Save Project to download a backup before you go.';
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

    saveProject: function () {
      root.Store.exportFile().then(function (docCount) {
        U.toast('Project file downloaded.' +
          (docCount ? ' ' + docCount + ' document(s) listed but not included - use Export documents for the files.' : ''),
          'ok');
      });
    },
    pickProjectFile: function () { U.$('projectFileInput').click(); },
    loadProject: function (file) {
      // On a shared server this is not "replaces your data" - it is everyone's,
      // including work colleagues did five minutes ago. Say so.
      var scope = root.Store.shared
        ? 'This replaces the shared database for everyone in the office - every bid, ' +
          'takeoff, proposal and rate, including anything your colleagues have entered ' +
          'since this backup was taken. It cannot be undone.'
        : 'This replaces everything currently in the app - bids, takeoffs, proposals ' +
          'and the rate library.';
      if (!confirm('Load "' + file.name + '"?\n\n' + scope + '\n\nSave a backup first if you need one.')) {
        U.$('projectFileInput').value = '';
        return;
      }
      root.Store.importFile(file, function (err, db, docIndex) {
        U.$('projectFileInput').value = '';
        if (err) { U.toast(err.message, 'err'); return; }
        root.Bids.refresh();
        switchTab('active');
        U.toast('Project loaded.' +
          (docIndex && docIndex.length
            ? ' ' + docIndex.length + ' document(s) are referenced but their files are not in this backup.'
            : ''), 'ok');
      });
    },
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
