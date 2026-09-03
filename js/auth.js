/* auth.js - who is signed in, and what the screen lets them do.
 *
 * The server decides; this decides what to draw. Auth.can() is read by
 * js/nav.js for the module bar, by js/bids.js for the row actions and by
 * js/app.js for the header buttons, so a permission appears in one condition
 * rather than being spelled out in six places.
 *
 * Hiding a button is a courtesy, not a defence: every one of these checks has
 * its twin in server/api.js, which is the one that actually refuses. The point
 * of hiding is that nobody clicks something that was only ever going to fail.
 *
 * Off the server - a laptop opening the file directly, or the test suite - there
 * is nobody to sign in as and nothing to protect against, so can() answers yes
 * to everything and the app behaves exactly as it did before this file existed.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var user = null;          // { id, name, email, initials, role, permissions }
  var catalogue = [];       // the permission list, for the Roles screen
  var mode = 'solo';        // 'solo' (no server) | 'setup' | 'login' | 'in'
  var pending = null;       // resolve() of the promise begin() handed back

  function api(path, options) {
    return root.fetch('/api' + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  function serverThere() {
    return typeof root.fetch === 'function' &&
      root.location && /^https?:$/.test(root.location.protocol);
  }

  /* ---- boot ------------------------------------------------------------- */

  /* Resolves once the app may go on and open the database: either there is no
     server at all, or somebody is signed in. Until then the overlay owns the
     screen, so no module ever renders against data the person is not entitled
     to see. */
  function begin() {
    if (!serverThere()) { mode = 'solo'; return Promise.resolve(null); }

    return api('/session').then(function (body) {
      catalogue = body.catalogue || [];
      if (body.user) {
        user = body.user;
        mode = 'in';
        renderChip();
        return user;
      }
      mode = body.setupNeeded ? 'setup' : 'login';
      showGate();
      return new Promise(function (resolve) { pending = resolve; });
    }).catch(function () {
      // No server behind this page. The local backends take over, exactly as
      // they do for a file:// laptop.
      mode = 'solo';
      return null;
    });
  }

  function admitted(body) {
    user = body.user;
    catalogue = body.catalogue || catalogue;
    mode = 'in';
    renderChip();
    var go = pending;
    pending = null;
    hideGate();
    if (go) go(user);
  }

  /* ---- the sign-in screen ----------------------------------------------- */

  /* Drawn into #bootOverlay, which already covers the page while the database
     opens. One overlay, two states, rather than a second full-screen element
     that has to be kept from showing at the same time as the first. */
  function showGate() {
    var el = U.$('bootOverlay');
    if (!el) return;
    el.classList.remove('hidden');
    el.innerHTML = mode === 'setup' ? setupHTML() : loginHTML();
    var first = el.querySelector('input');
    if (first) first.focus();
  }

  function hideGate() {
    var el = U.$('bootOverlay');
    if (!el) return;
    el.innerHTML =
      '<div class="text-center">' +
        '<i class="fas fa-circle-notch fa-spin text-3xl text-blue-500 mb-3"></i>' +
        '<p class="text-sm text-slate-500">Opening the shared database...</p></div>';
  }

  function shell(icon, title, blurb, body) {
    return '<div class="w-full max-w-sm">' +
      '<div class="text-center mb-6">' +
        '<img src="assets/diverse-logo.png" alt="DiVerse Industrial Solutions" ' +
             'class="h-14 w-auto mx-auto mb-4 opacity-90" onerror="this.style.display=\'none\'">' +
        '<h1 class="text-lg font-bold text-slate-800">' + U.esc(title) + '</h1>' +
        '<p class="text-sm text-slate-500 mt-1">' + blurb + '</p>' +
      '</div>' +
      '<div class="bg-white rounded-2xl shadow-xl border border-slate-200 p-6">' + body + '</div>' +
      '<p id="authError" class="hidden mt-3 text-sm text-red-600 text-center"></p>' +
    '</div>';
  }

  function field(id, label, type, extra) {
    return '<div class="mb-3">' +
      '<label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">' +
        U.esc(label) + '</label>' +
      '<input id="' + id + '" type="' + type + '" ' + (extra || '') + ' ' +
        'class="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm ' +
        'focus:border-blue-400 focus:bg-white outline-none transition">' +
    '</div>';
  }

  function loginHTML() {
    return shell('fa-right-to-bracket', 'DiverSe Project Management',
      'Sign in to reach the shared bid register.',
      '<form onsubmit="Auth.submitLogin(event)">' +
        field('authEmail', 'Email address', 'email', 'autocomplete="username" required') +
        field('authPassword', 'Password', 'password', 'autocomplete="current-password" required') +
        '<button type="submit" id="authSubmit" ' +
          'class="w-full mt-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg ' +
          'text-sm font-semibold transition flex items-center justify-center gap-2">' +
          '<i class="fas fa-right-to-bracket"></i>Sign in</button>' +
        '<p class="text-[11px] text-slate-400 text-center mt-4">' +
          'Forgotten your password? An administrator can set a new one for you.</p>' +
      '</form>');
  }

  /* The first run. There is no default password anywhere in this app - the
     first Admin is created here, by whoever is sitting at the machine, and
     nothing works until they have. */
  function setupHTML() {
    return shell('fa-user-shield', 'Set up DiverSe',
      'This database has no accounts yet. Create the first administrator.',
      '<form onsubmit="Auth.submitSetup(event)">' +
        field('authName', 'Your name', 'text', 'required') +
        field('authEmail', 'Email address', 'email', 'autocomplete="username" required') +
        field('authInitials', 'Initials on the bids table', 'text',
          'maxlength="6" placeholder="e.g. MGJ" style="text-transform:uppercase"') +
        field('authPassword', 'Password', 'password', 'autocomplete="new-password" required') +
        field('authPassword2', 'Repeat the password', 'password', 'autocomplete="new-password" required') +
        '<p class="text-[11px] text-slate-400 mb-3">At least 8 characters, with a letter and a number.</p>' +
        '<button type="submit" id="authSubmit" ' +
          'class="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg ' +
          'text-sm font-semibold transition flex items-center justify-center gap-2">' +
          '<i class="fas fa-user-shield"></i>Create administrator</button>' +
      '</form>');
  }

  function gateError(message) {
    var el = U.$('authError');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = message;
  }

  function busy(on) {
    var b = U.$('authSubmit');
    if (!b) return;
    b.disabled = on;
    b.classList.toggle('opacity-60', on);
  }

  /* ---- the person's own chip in the header ------------------------------ */

  function renderChip() {
    var host = U.$('userChip');
    if (!host) return;
    if (!user) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="relative">' +
        '<button onclick="Auth.toggleMenu(event)" ' +
          'class="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg bg-slate-700/70 hover:bg-slate-600 transition">' +
          '<span class="w-7 h-7 rounded-md bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">' +
            U.esc(badgeFor(user)) + '</span>' +
          '<span class="text-left leading-tight hidden sm:block">' +
            '<span class="block text-xs font-semibold text-white">' + U.esc(user.name) + '</span>' +
            '<span class="block text-[10px] text-slate-400">' + U.esc(user.role) + '</span>' +
          '</span>' +
          '<i class="fas fa-chevron-down text-[9px] text-slate-400"></i>' +
        '</button>' +
        '<div id="userMenu" class="hidden absolute right-0 mt-1 w-56 bg-white rounded-xl shadow-2xl ' +
             'border border-slate-200 py-1.5 z-50 text-slate-700">' +
          '<div class="px-3 py-2 border-b border-slate-100">' +
            '<div class="text-xs font-semibold text-slate-800 truncate">' + U.esc(user.name) + '</div>' +
            '<div class="text-[11px] text-slate-500 truncate">' + U.esc(user.email) + '</div>' +
          '</div>' +
          menuItem('fa-key', 'Change my password', 'Auth.changePassword()') +
          menuItem('fa-table-columns', 'Reset my table layout', 'Auth.resetLayout()') +
          '<div class="border-t border-slate-100 my-1"></div>' +
          menuItem('fa-right-from-bracket', 'Sign out', 'Auth.logout()', true) +
        '</div>' +
      '</div>';
  }

  function menuItem(icon, label, onclick, danger) {
    return '<button onclick="' + onclick + '" class="w-full text-left px-3 py-2 text-sm ' +
      'hover:bg-slate-50 flex items-center gap-2.5 ' + (danger ? 'text-red-600' : '') + '">' +
      '<i class="fas ' + icon + ' w-4 text-xs ' + (danger ? '' : 'text-slate-400') + '"></i>' +
      U.esc(label) + '</button>';
  }

  function badgeFor(u) {
    if (u.initials) return u.initials.slice(0, 3).toUpperCase();
    return String(u.name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* ---- prompts ---------------------------------------------------------- */

  function toast(msg, tone) { if (U && U.toast) U.toast(msg, tone || 'ok'); }

  root.Auth = {
    begin: begin,
    renderChip: renderChip,

    get user() { return user; },
    get mode() { return mode; },
    get catalogue() { return catalogue; },
    /* True when accounts are in play at all. False on a laptop opening the file
       directly, where there is nobody to be. */
    get enforced() { return mode === 'in'; },

    /* The one question the rest of the app asks. Off the server there is no
       role to consult and nothing shared to protect, so everything is allowed -
       which is what keeps the single-user and test paths working unchanged. */
    can: function (perm) {
      if (mode !== 'in') return true;
      return !!user && user.permissions.indexOf(perm) >= 0;
    },

    /* Convenience for the many places that want a whole block hidden. */
    canAny: function (list) {
      for (var i = 0; i < list.length; i++) if (root.Auth.can(list[i])) return true;
      return false;
    },

    submitLogin: function (ev) {
      ev.preventDefault();
      busy(true);
      api('/login', {
        method: 'POST',
        body: JSON.stringify({
          email: U.$('authEmail').value.trim(),
          password: U.$('authPassword').value
        })
      }).then(admitted).catch(function (e) {
        busy(false);
        gateError(e.message);
        var p = U.$('authPassword');
        if (p) { p.value = ''; p.focus(); }
      });
    },

    submitSetup: function (ev) {
      ev.preventDefault();
      var pw = U.$('authPassword').value;
      if (pw !== U.$('authPassword2').value) {
        gateError('The two passwords do not match.');
        return;
      }
      busy(true);
      api('/setup', {
        method: 'POST',
        body: JSON.stringify({
          name: U.$('authName').value.trim(),
          email: U.$('authEmail').value.trim(),
          initials: U.$('authInitials').value.trim(),
          password: pw
        })
      }).then(admitted).catch(function (e) {
        busy(false);
        gateError(e.message);
      });
    },

    toggleMenu: function (ev) {
      if (ev) ev.stopPropagation();
      var menu = U.$('userMenu');
      if (!menu) return;
      var opening = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !opening);
      if (!opening) return;
      // One-shot: the next click anywhere else closes it.
      setTimeout(function () {
        document.addEventListener('click', function close() {
          var m = U.$('userMenu');
          if (m) m.classList.add('hidden');
          document.removeEventListener('click', close);
        });
      }, 0);
    },

    logout: function () {
      // Anything typed in the last few hundred milliseconds is still in the
      // debounce; sign out after it has landed, not on top of it.
      root.Store.flush().then(function () {
        return api('/logout', { method: 'POST' });
      }).catch(function () { /* signing out locally regardless */ })
        .then(function () { root.location.reload(); });
    },

    changePassword: function () {
      var next = prompt('New password for ' + user.email +
        '\n\nAt least 8 characters, with a letter and a number:');
      if (next === null) return;
      var again = prompt('Type it once more:');
      if (again === null) return;
      if (next !== again) { toast('The two passwords did not match.', 'err'); return; }
      api('/users/' + user.id, {
        method: 'PATCH',
        body: JSON.stringify({ password: next })
      }).then(function () {
        toast('Password changed. Any other machine you were signed in on has been signed out.', 'ok');
      }).catch(function (e) { toast(e.message, 'err'); });
    },

    /* The escape hatch for a table somebody has hidden every useful column on.
       Only their own layout - there is no route that writes anyone else's. */
    resetLayout: function () {
      if (!confirm('Put every table back to its default columns, widths and filters?\n\n' +
        'This only affects what you see. Nobody else\'s layout changes.')) return;
      // Reloaded rather than repainted: every grid, rail and collapsed card
      // reads ui at render time, and one reload is more dependable than
      // remembering to re-render each of them.
      root.Store.resetLayout().then(function () { root.location.reload(); });
    },

    /* ---- administration data (used by the Settings panels) --------------- */

    listUsers: function () { return api('/users'); },
    createUser: function (rec) {
      return api('/users', { method: 'POST', body: JSON.stringify(rec) });
    },
    updateUser: function (id, patch) {
      return api('/users/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    deleteUser: function (id) { return api('/users/' + id, { method: 'DELETE' }); },

    listRoles: function () { return api('/roles'); },
    createRole: function (name, permissions) {
      return api('/roles', { method: 'POST', body: JSON.stringify({ name: name, permissions: permissions }) });
    },
    updateRole: function (id, patch) {
      return api('/roles/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    deleteRole: function (id) { return api('/roles/' + id, { method: 'DELETE' }); }
  };
})(window);
