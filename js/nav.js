/* nav.js - the application shell: six top-level modules, their sub-menus, and
 * the pop-out windows.
 *
 * One MENU array is the single source of truth for the module bar, the sub-menu
 * strip, the module-specific toolbar and the pop-out URLs - the same shape that
 * BidGrid.COLUMNS uses for the bids table, so adding a page is one entry rather
 * than four edits that drift apart.
 *
 * Only Bid Management is built. The other four modules render an honest
 * placeholder rather than a mock-up, so nobody demos a screen that does nothing.
 */
(function (root) {
  'use strict';

  var U = root.U;

  /* `sections` are page keys; each maps to a <div id="section-DOMID"> in the
     HTML, defaulting to the key itself. All Bids / Active / Awarded share one
     `dom` because they are the same grid over different statuses. A module with
     no `sections` is a placeholder and gets a page generated for it.

     `hidden` keeps a module out of the module bar: Project is reached by
     clicking a bid, Settings by the header button, so neither is a peer of the
     six top-level modules. `chrome` names the shell that module wants - see
     applyChrome().

     `perm` is what a role must hold for the entry to appear at all - on a
     module, on a page, or on a toolbar button. Written here rather than as
     conditions scattered through the render functions, so the access levels
     are one column you can read down. The server enforces the same list; this
     only decides what is worth drawing. */
  var MENU = [
    { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', perm: 'module.dashboard',
      sections: [{ key: 'dashboard', label: 'Overview', icon: 'fa-chart-line' }] },

    { key: 'bids', label: 'Bid Management', icon: 'fa-clipboard-list', perm: 'module.bids',
      sections: [
        { key: 'all', label: 'All Bids', icon: 'fa-layer-group', dom: 'bidlist' },
        { key: 'active', label: 'Active Bids', icon: 'fa-bolt', dom: 'bidlist' },
        { key: 'awarded', label: 'Awarded Bids', icon: 'fa-trophy', dom: 'bidlist' }
      ],
      toolbar: [
        { label: 'Add Bid', icon: 'fa-plus', onclick: 'Bids.openAdd()', primary: true, perm: 'bid.create' },
        { label: 'XLSX', icon: 'fa-file-excel', onclick: 'Bids.exportXLSX()', green: true, perm: 'bid.export' }
      ] },

    { key: 'production', label: 'Production Manager', icon: 'fa-industry', placeholder: true,
      perm: 'module.production' },
    { key: 'inventory', label: 'Inventory Manager', icon: 'fa-boxes-stacked', placeholder: true,
      perm: 'module.inventory' },
    { key: 'report', label: 'Report Manager', icon: 'fa-chart-pie', placeholder: true,
      perm: 'module.report' },
    { key: 'scheduler', label: 'Scheduler', icon: 'fa-calendar-days', placeholder: true,
      perm: 'module.scheduler' },

    /* One project, full screen. TakeOff and Proposal keep their page keys and
       their DOM hosts, so every existing App.switchTab('takeoff') call site
       still works - they simply belong to this module now. */
    { key: 'project', label: 'Project', icon: 'fa-diagram-project',
      hidden: true, chrome: 'project', perm: 'module.bids',
      sections: [
        { key: 'project', label: 'Overview', icon: 'fa-circle-info' },
        { key: 'takeoff', label: 'TakeOff', icon: 'fa-calculator' },
        { key: 'proposal', label: 'Proposal', icon: 'fa-file-contract' }
      ] },

    /* Shop-wide reference data: not about any one bid, so not in Bid Management. */
    /* No perm on the module itself, deliberately. Settings is a container for
       two different concerns - the shop's reference data and the people using
       the app - and a role can hold one without the other. Whether the Settings
       button appears at all is therefore "does any panel inside admit them",
       which is what firstSectionOf() answers. */
    { key: 'settings', label: 'Settings', icon: 'fa-gear',
      hidden: true, chrome: 'settings',
      sections: [
        { key: 'ratelib', label: 'Rate Library', icon: 'fa-warehouse', perm: 'settings.view' },
        { key: 'references', label: 'References', icon: 'fa-book', perm: 'settings.view' },
        { key: 'regions', label: 'Regions', icon: 'fa-map-marked-alt', dom: 'settings', perm: 'settings.view' },
        { key: 'engineers', label: 'Engineers', icon: 'fa-user-gear', dom: 'settings', perm: 'settings.view' },
        { key: 'tasktypes', label: 'Task Types', icon: 'fa-list-check', dom: 'settings', perm: 'settings.view' },
        { key: 'materials', label: 'Materials', icon: 'fa-layer-group', dom: 'settings', perm: 'settings.view' },
        { key: 'company', label: 'Company', icon: 'fa-building', dom: 'settings', perm: 'settings.view' },
        /* Administration. Separate permissions from settings.view so a role can
           be given the shop's reference data without also being handed the
           ability to create accounts. */
        { key: 'employees', label: 'People', icon: 'fa-users', dom: 'settings', perm: 'admin.users' },
        { key: 'roles', label: 'Roles & Access', icon: 'fa-user-shield', dom: 'settings', perm: 'admin.roles' }
      ] }
  ];

  /* One question, asked everywhere an entry might not belong to this person.
     Auth answers yes to everything when there is no server and therefore
     nobody to be, which is what keeps the single-user path unchanged. */
  function allows(entry) {
    return !entry || !entry.perm || !root.Auth || root.Auth.can(entry.perm);
  }

  /* The pages of a module this person may actually open. */
  function sectionsOf(m) {
    if (!m || !m.sections) return [];
    return m.sections.filter(allows);
  }

  /* ---- URL routing ------------------------------------------------------ */

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(root.location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* A popped-out window renders one page and nothing else. Read once at load:
     the flag must not change while the window is open. */
  var POPOUT = param('popout') === '1';

  var current = { module: 'bids', section: 'active' };

  /* ---- lookups ---------------------------------------------------------- */

  function moduleOf(key) {
    for (var i = 0; i < MENU.length; i++) if (MENU[i].key === key) return MENU[i];
    return null;
  }

  /* Which module owns a page. Placeholders own the section named after them. */
  function ownerOf(sectionKey) {
    for (var i = 0; i < MENU.length; i++) {
      var m = MENU[i];
      if (m.placeholder) { if (m.key === sectionKey) return m; continue; }
      for (var j = 0; j < m.sections.length; j++) {
        if (m.sections[j].key === sectionKey) return m;
      }
    }
    return null;
  }

  function sectionOf(sectionKey) {
    var m = ownerOf(sectionKey);
    if (!m || m.placeholder) return null;
    for (var i = 0; i < m.sections.length; i++) {
      if (m.sections[i].key === sectionKey) return m.sections[i];
    }
    return null;
  }

  /* Every page key in the app, including the generated placeholder pages. */
  function sectionKeys() {
    var out = [];
    MENU.forEach(function (m) {
      if (m.placeholder) { out.push(m.key); return; }
      m.sections.forEach(function (s) { out.push(s.key); });
    });
    return out;
  }

  /* The element id a page lives in. Several page keys can share one. */
  function domOf(sectionKey) {
    var s = sectionOf(sectionKey);
    return 'section-' + ((s && s.dom) || sectionKey);
  }

  /* The distinct element ids js/app.js hides before revealing one. */
  function domIds() {
    var seen = {}, out = [];
    sectionKeys().forEach(function (k) {
      var id = domOf(k);
      if (!seen[id]) { seen[id] = true; out.push(id); }
    });
    return out;
  }

  /* Written once here rather than four times in the HTML. An empty module says
     so plainly - a mocked-up screen that does nothing is worse than none. */
  function renderPlaceholder(m) {
    var host = U.$('section-' + m.key);
    if (!host || host.innerHTML) return;
    host.innerHTML = root.UI.emptyCard({
      icon: m.icon,
      title: m.label,
      blurb: 'Not built yet &mdash; planned for a later phase. ' +
             'Bid Management is the module currently in use.'
    });
  }

  /* The first page of a module this person may open, which is not always the
     first one listed: an Admin-only panel must not be what Settings lands on
     for somebody who only has the Rate Library. */
  function firstSectionOf(moduleKey) {
    var m = moduleOf(moduleKey);
    if (!m || !allows(m)) return null;
    if (m.placeholder) return m.key;
    var open = sectionsOf(m);
    return open.length ? open[0].key : null;
  }

  /* Where somebody who may not see the current page should be sent instead:
     the first module their role does allow. Every role in the catalogue has at
     least one, but a hand-made role with none gets an honest empty shell rather
     than a redirect loop. */
  function firstAllowedSection() {
    for (var i = 0; i < MENU.length; i++) {
      if (MENU[i].hidden || !allows(MENU[i])) continue;
      var s = firstSectionOf(MENU[i].key);
      if (s) return s;
    }
    return null;
  }

  /* ---- rendering -------------------------------------------------------- */

  function render() {
    MENU.forEach(function (m) { if (m.placeholder) renderPlaceholder(m); });
    applyChrome();
    if (POPOUT) { renderPopoutHeader(); return; }
    renderModuleBar();
    renderSubMenu();
  }

  /* Which shell the current page sits in. Kept in one place so a page cannot
     end up half-immersive - every branch also says what the others turn off.

     A popped-out window is already stripped to one page by body.popout, so the
     immersive project chrome would only take away its own header. */
  function applyChrome() {
    var m = moduleOf(current.module) || {};
    var chrome = POPOUT ? null : m.chrome;

    document.body.classList.toggle('projectview', chrome === 'project');
    var shell = U.$('settingsShell');
    if (shell) shell.classList.toggle('hidden', chrome !== 'settings');

    if (chrome === 'project' && root.Project) {
      root.Project.renderHeader();
    } else {
      // Emptied rather than just hidden: the project bar carries its own
      // #saveIndicator, and a hidden copy earlier in the document would shadow
      // the footer's for getElementById once you left the project view.
      var ph = U.$('projectHeader');
      if (ph) ph.innerHTML = '';
    }
    if (chrome === 'settings' && root.Settings) root.Settings.renderRail();
  }

  function renderModuleBar() {
    var host = U.$('moduleBar');
    if (!host) return;
    host.innerHTML = MENU.filter(function (m) {
      return !m.hidden && allows(m);
    }).map(function (m) {
      var on = m.key === current.module;
      return '<button onclick="Nav.goModule(\'' + m.key + '\')" ' +
        'class="px-4 py-2.5 rounded-lg text-sm whitespace-nowrap transition flex items-center gap-2 ' +
        (on ? 'bg-brand text-white font-semibold shadow-lg shadow-brand/25'
            : 'text-faint hover:text-white hover:bg-chrome-soft/60') + '">' +
        '<i class="fas ' + m.icon + ' text-xs"></i>' + U.esc(m.label) +
        (m.placeholder ? '<span class="text-3xs uppercase tracking-wider opacity-50">soon</span>' : '') +
        '</button>';
    }).join('');
  }

  /* The count is rendered from the data every time the strip is drawn, not
     written as 0 and patched afterwards: the sub-menu is re-rendered on every
     navigation, so a patched-in figure was wiped the moment you changed tabs
     and every badge read 0. Bids owns the definition of what is in each list -
     asking it means the badge and the table can never disagree. */
  function tabBadge(key) {
    if (!root.Bids || typeof root.Bids.viewCount !== 'function') return '';
    var n = root.Bids.viewCount(key);
    if (n == null) return '';
    return ' <span class="ml-1 bg-neutral-soft text-muted px-2 py-0.5 rounded-full text-xs" ' +
      'id="badge-' + key + '">' + n + '</span>';
  }

  function renderSubMenu() {
    var bar = U.$('subMenuBar');
    if (!bar) return;
    var m = moduleOf(current.module);

    // A placeholder module has one page and no choices to offer; a strip with a
    // single dead tab in it is noise. Project and Settings draw their own
    // navigation - the project header bar and the settings rail - so the strip
    // would be a second, competing set of tabs.
    if (!m || m.placeholder || m.chrome) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    U.$('subMenuTabs').innerHTML = sectionsOf(m).map(function (s) {
      var on = s.key === current.section;
      return '<span class="relative group inline-flex items-center">' +
        '<button onclick="Nav.go(event,\'' + s.key + '\')" id="tab-' + s.key + '" ' +
          'class="' + (on ? 'tab-active' : 'tab-inactive') + ' px-5 py-3.5 text-sm whitespace-nowrap transition-colors" ' +
          'title="' + U.escAttr(s.label) + ' (Ctrl+click to open in its own window)">' +
          '<i class="fas ' + s.icon + ' mr-2"></i>' + U.esc(s.label) + tabBadge(s.key) +
        '</button>' +
        popoutButton(s) +
      '</span>';
    }).join('');

    U.$('subMenuToolbar').innerHTML = (m.toolbar || []).filter(allows).map(function (b) {
      var cls = b.primary ? 'bg-brand hover:bg-brand-hover text-white'
              : b.green ? 'bg-ok hover:bg-ok-hover text-white'
              : 'bg-neutral-soft hover:bg-line text-ink';
      return '<button onclick="' + b.onclick + '" class="px-3 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ' + cls + '">' +
        '<i class="fas ' + b.icon + '"></i>' + U.esc(b.label) + '</button>';
    }).join('');
  }

  /* Pop-out needs both windows on one origin sharing one database. Over
     file:// that is not dependable, and two divergent copies of a bid is a
     worse outcome than no button, so it is withheld rather than shown broken. */
  /* Pop-out needs both windows looking at the same data. On the server that is
     free - they are two clients of one database. On IndexedDB it works because
     both windows share the browser's store. On the localStorage fallback it
     would give two divergent copies, so it is withheld. */
  function canPopout() {
    return root.Store && (root.Store.backend === 'server' || root.Store.backend === 'indexeddb');
  }

  function popoutButton(s) {
    if (!canPopout()) return '';
    return '<button onclick="Nav.popout(\'' + s.key + '\')" tabindex="-1" ' +
      'title="Open ' + U.escAttr(s.label) + ' in its own window" ' +
      'class="absolute right-0.5 top-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition ' +
      'text-3xs text-faint hover:text-brand p-1">' +
      '<i class="fas fa-up-right-from-square"></i></button>';
  }

  function renderPopoutHeader() {
    var host = U.$('popoutHeader');
    if (!host) return;
    var s = sectionOf(current.section);
    var m = ownerOf(current.section);
    host.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
        '<div class="w-8 h-8 bg-brand rounded-lg flex items-center justify-center shrink-0">' +
          '<i class="fas ' + (s ? s.icon : 'fa-window-restore') + ' text-white text-xs"></i></div>' +
        '<div class="min-w-0">' +
          '<div class="text-sm font-bold text-white truncate">' + U.esc(s ? s.label : current.section) + '</div>' +
          '<div class="text-2xs text-faint truncate">' + U.esc(m ? m.label : '') + ' &middot; DiverSe</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex items-center gap-3">' +
        '<span id="saveIndicator" class="text-xs text-faint"></span>' +
        '<button onclick="Nav.returnToMain()" class="px-3 py-1.5 bg-chrome-soft hover:bg-chrome-soft/70 text-white rounded-lg text-xs font-medium flex items-center gap-2">' +
          '<i class="fas fa-arrow-left"></i>Main window</button>' +
      '</div>';
  }

  /* ---- navigation ------------------------------------------------------- */

  /* May this person open this page at all? Both the module and the page itself
     have to admit them - Settings is settings.view, but the People panel inside
     it needs admin.users on top. */
  function mayOpen(sectionKey) {
    var m = ownerOf(sectionKey);
    if (!m || !allows(m)) return false;
    if (m.placeholder) return true;
    return allows(sectionOf(sectionKey));
  }

  function setCurrent(sectionKey) {
    var m = ownerOf(sectionKey);
    if (!m) return false;
    current.module = m.key;
    current.section = sectionKey;
    return true;
  }

  /* ---- where this tab is, as opposed to where this person was --------------
   *
   * WHICH PAGE THE APP OPENS ON IS TWO DIFFERENT QUESTIONS.
   *
   * Opening the app is not the same event as reloading it, and they want
   * opposite answers. Coming to the app fresh you want the Dashboard - the
   * state of the office. Pressing F5 you want the page you were already on,
   * because a reload is not a decision to go somewhere else.
   *
   * The app used to answer both with ui.section, the last page this PERSON
   * navigated to, saved with their layout. So leaving it on a proposal meant
   * every future visit opened inside that document, several clicks deep in one
   * project - and on a shared machine a brand-new account inherited the last
   * page of whoever used the browser before them, because a signed-in user with
   * no saved prefs yet adopts this browser's (see store.js, adoptUI).
   *
   * sessionStorage tells the two apart exactly: it survives a reload and dies
   * with the tab. So this is per tab, which is also what makes two tabs on two
   * different projects each reload onto their own.
   */
  var TAB_SECTION = 'dv.tab.section';
  var TAB_BID = 'dv.tab.bid';

  function rememberTab() {
    try {
      root.sessionStorage.setItem(TAB_SECTION, current.section);
      var bid = root.Project && root.Project.currentBid && root.Project.currentBid();
      if (bid) root.sessionStorage.setItem(TAB_BID, String(bid.id));
      else root.sessionStorage.removeItem(TAB_BID);
    } catch (e) { /* private mode: the tab just forgets, which is the old behaviour */ }
  }

  function tabValue(key) {
    try { return root.sessionStorage.getItem(key); } catch (e) { return null; }
  }

  /* The popped-out window deliberately does not persist where it is. A popout
     writing the marker - or ui.section - would drag the window that opened it to
     the popout's page on its next reload.

     Read through root.Nav.isPopout rather than the POPOUT variable so the guard
     can be exercised without opening a second window. */
  function persist() {
    if (root.Nav.isPopout()) return;
    var ui = root.Store.db.ui;
    ui.module = current.module;
    ui.section = current.section;
    // Settings reopens on the panel you left it on rather than always the first.
    if (current.module === 'settings') ui.settingsSection = current.section;
    rememberTab();
    root.Store.save();
  }

  root.Nav = {
    MENU: MENU,
    isPopout: function () { return POPOUT; },
    sectionKeys: sectionKeys,
    domOf: domOf,
    domIds: domIds,
    ownerOf: ownerOf,
    sectionOf: sectionOf,
    moduleOf: moduleOf,
    firstSectionOf: firstSectionOf,
    firstAllowedSection: firstAllowedSection,
    sectionsOf: sectionsOf,
    allows: allows,
    mayOpen: mayOpen,
    canPopout: canPopout,
    render: render,
    applyChrome: applyChrome,
    /* The bid a popped-out TakeOff/Proposal window was addressed with. */
    initialBidId: function () {
      var v = param('bid');
      return v && /^\d+$/.test(v) ? Number(v) : null;
    },
    get current() { return current; },
    setCurrent: setCurrent,
    persist: persist,

    /* Ctrl/Cmd+click pops out, because that is what a browser does with every
       other link and it is the first thing people try. */
    go: function (ev, sectionKey) {
      if (ev && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        root.Nav.popout(sectionKey);
        return;
      }
      root.App.switchTab(sectionKey);
    },

    goModule: function (moduleKey) {
      var target = firstSectionOf(moduleKey);
      if (target) root.App.switchTab(target);
    },

    /* Named windows: popping the same page twice focuses the window you already
       have instead of stacking duplicates. */
    popout: function (sectionKey) {
      var owner = ownerOf(sectionKey) || {};
      var url = root.location.pathname + '?module=' +
        encodeURIComponent(owner.key || '') +
        '&section=' + encodeURIComponent(sectionKey) + '&popout=1';
      // A TakeOff or Proposal is always somebody's; without the bid the new
      // window would open the picker instead of the project you clicked from.
      if (owner.key === 'project' && root.Project) {
        var bid = root.Project.currentBid();
        if (bid) url += '&bid=' + encodeURIComponent(bid.id);
      }
      var win = root.open(url, 'dvbid-' + sectionKey,
        'width=1280,height=860,menubar=no,toolbar=no,location=no');
      if (!win) { U.toast('Your browser blocked the pop-up. Allow pop-ups for this site.', 'warn'); return; }
      win.focus();
    },

    returnToMain: function () {
      // The opener can be gone - closed, or this window restored from a
      // bookmark - so fall back to navigating in place rather than throwing.
      try {
        if (root.opener && !root.opener.closed) { root.opener.focus(); root.close(); return; }
      } catch (e) { /* cross-origin or already gone */ }
      root.location.href = root.location.pathname;
    },

    /* Where to open on boot:
         1. the URL, which is how a popout and a bookmark are addressed
         2. this tab's own marker - i.e. this is a reload, so stay put
         3. the Dashboard: a fresh visit starts at the state of the office
       Their role may not admit the Dashboard at all - a Production-only account
       would land on a page it cannot see - so it falls through to the first page
       that does admit them.

       ui.section is deliberately NOT consulted. See rememberTab above. */
    initialSection: function () {
      var fromUrl = param('section');
      if (fromUrl && mayOpen(fromUrl)) return fromUrl;
      var mine = tabValue(TAB_SECTION);
      if (mine && mayOpen(mine)) return mine;
      return mayOpen('dashboard') ? 'dashboard' : (firstAllowedSection() || 'active');
    },

    /* The project this tab was on when it was last reloaded, if it was on one.
       Read by App.resumeLastSession in preference to ui.projectBidId, which is
       shared by every tab and so is whichever one navigated last. */
    tabBidId: function () {
      var v = tabValue(TAB_BID);
      return v && /^\d+$/.test(v) ? Number(v) : null;
    }
  };
})(window);
