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

  var user = null;          // { id, name, username, email, initials, role, permissions }
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
  /* The overlay centres a spinner in its other two states, and that is exactly
     what a full-height landing page must not be - so the centring comes off
     while the gate is up and goes back on afterwards. */
  function gateHTML() {
    return mode === 'setup' ? setupHTML() : loginHTML();
  }

  function showGate() {
    var el = U.$('bootOverlay');
    if (!el) return;
    el.classList.remove('hidden', 'items-center', 'justify-center');
    el.classList.add('overflow-auto');
    el.innerHTML = gateHTML();
    // After the markup is in the DOM: the scene measures itself.
    if (root.Intro) root.Intro.mount();
    var first = el.querySelector('input');
    if (first) first.focus();
  }

  function hideGate() {
    var el = U.$('bootOverlay');
    if (!el) return;
    el.classList.add('items-center', 'justify-center');
    el.classList.remove('overflow-auto');
    el.innerHTML =
      '<div class="text-center">' +
        '<i class="fas fa-circle-notch fa-spin text-3xl text-brand mb-3"></i>' +
        '<p class="text-sm text-muted">Opening the shared database...</p></div>';
  }

  /* THE SIGN-IN SCREEN IS THE ONLY PAGE MOST PEOPLE SEE BEFORE THEY DECIDE WHAT
     THIS IS. It used to be a username, a password and one line of text, which
     told a new estimator nothing at all.

     So it is a landing page: what the app does on the left, the form on the
     right. The left panel is written once, in js/guide.js, and is the headline
     half of the same guide the Help button opens - one document, so the short
     version cannot quietly stop being true.

     On a narrow screen the panel drops away and the form is what is left, which
     is the right order: somebody on a phone is signing in, not reading. */
  function shell(icon, title, blurb, body) {
    // 3:2 - the panel is the wider half, because it is what somebody who has
    // not been here before is actually reading. Each half scrolls on its own,
    // so a short screen never puts a control out of reach.
    return '<div class="w-full min-h-full grid lg:grid-cols-[3fr_2fr] items-stretch">' +
      brandPanel() +
      '<div class="flex items-center justify-center p-6 sm:p-10 lg:h-screen lg:overflow-y-auto">' +
        '<div class="w-full max-w-sm">' +
          '<div class="mb-6">' +
            '<img src="assets/diverse-logo.png" alt="DiVerse Industrial Solutions" ' +
                 'class="h-12 w-auto mb-5 lg:hidden" onerror="this.style.display=\'none\'">' +
            '<h1 class="text-xl font-bold text-ink-strong">' + U.esc(title) + '</h1>' +
            '<p class="text-sm text-muted mt-1">' + blurb + '</p>' +
          '</div>' +
          '<div class="auth-card rounded-2xl border border-line p-6">' + body + '</div>' +
          '<p id="authError" class="hidden mt-3 text-sm text-danger text-center"></p>' +
          '<p class="text-2xs text-faint text-center mt-6">' +
            'DiVerse Industrial Solutions &middot; Bid, takeoff and proposal manager' +
          '</p>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* The dark half. Deliberately the chrome colour rather than a photograph:
     it is the same surface as the app's own header, so signing in reads as
     stepping into the thing you were just looking at. */
  function brandPanel() {
    /* THE PANEL HAS TO FIT ON THE SCREEN IT IS ON.

       It is a fixed-height column - the viewport - so the buttons at the foot
       are pinned there and the middle scrolls if the laptop is short. They were
       laid out in one long flow, which on a 1080p screen at 100% put the
       guide's last section and all three buttons below the fold with no way to
       reach them: the overlay itself scrolls the whole page, and the form on
       the right would have gone with it. */
    return '<div class="hidden lg:flex flex-col bg-chrome text-white ' +
        'p-8 xl:p-12 overflow-hidden h-screen">' +
      // The mark is welded into place here rather than simply shown - see
      // js/intro.js. It carries the company's own two lines with it.
      '<div class="shrink-0">' + root.Intro.html() + '</div>' +
      '<div class="min-h-0 flex-1 overflow-y-auto scrollbar-hide mt-6 pr-2">' +
        '<h2 class="text-xl font-semibold tracking-tight text-white">Project Management</h2>' +
        '<p class="text-sm text-white/60 mt-1.5 max-w-md leading-relaxed">' +
          'Every enquiry from the day it arrives to the day it is won: the estimate, the ' +
          'proposal the client sees, the hours booked against it, and a record of everything ' +
          'that changed on the way.</p>' +
        '<div class="space-y-4 mt-6 max-w-md">' + root.Guide.landing() + '</div>' +
      '</div>' +
      '<div class="shrink-0 flex items-center gap-2 flex-wrap pt-5 mt-1 border-t border-white/10">' +
        panelBtn('fa-book-open', 'User guide', 'Guide.openFromGate()') +
        panelBtn('fa-circle-info', 'About this app', 'Guide.openFromGate()') +
        panelBtn('fa-rotate-right', 'Replay', 'Intro.play()') +
      '</div>' +
    '</div>';
  }

  function panelBtn(icon, label, onclick) {
    return '<button onclick="' + onclick + '" ' +
      'class="px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs ' +
      'font-semibold flex items-center gap-2 transition">' +
      '<i class="fas ' + icon + '"></i>' + U.esc(label) + '</button>';
  }

  var INPUT = 'w-full px-3 py-3 bg-raised border border-line rounded-lg text-sm ' +
    'focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand/25 outline-none transition';

  function field(id, label, type, extra) {
    return '<div class="mb-3">' +
      '<label for="' + id + '" class="block text-3xs font-bold text-muted uppercase tracking-wider mb-1.5">' +
        U.esc(label) + '</label>' +
      '<input id="' + id + '" type="' + type + '" ' + (extra || '') + ' ' +
        'class="' + INPUT + '">' +
    '</div>';
  }

  /* A PASSWORD YOU CANNOT SEE IS A PASSWORD YOU MISTYPE.
     On a shop-floor machine, with a long password and a keyboard somebody else
     was last using, hiding it costs more than it protects - so there is a
     button to show it, off by default. It is out of the tab order: Tab from the
     password field belongs to the submit button, not to a decision about
     whether the password is visible.

     Caps Lock is called out for the same reason. It is the single most common
     cause of "the password does not work", and the browser will not say so. */
  function passwordField(id, label, autocomplete) {
    return '<div class="mb-3">' +
      '<label for="' + id + '" class="block text-3xs font-bold text-muted uppercase tracking-wider mb-1.5">' +
        U.esc(label) + '</label>' +
      '<div class="relative">' +
        '<input id="' + id + '" type="password" required autocomplete="' + autocomplete + '" ' +
          'onkeyup="Auth.capsCheck(event)" onkeydown="Auth.capsCheck(event)" ' +
          'class="' + INPUT + ' auth-field">' +
        '<button type="button" tabindex="-1" id="' + id + 'Eye" ' +
          'onclick="Auth.toggleReveal(\'' + id + '\')" ' +
          'aria-label="Show the password" title="Show the password" ' +
          'class="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg ' +
          'text-faint hover:text-brand hover:bg-raised flex items-center justify-center transition">' +
          '<i class="fas fa-eye text-xs"></i></button>' +
      '</div>' +
      '<p id="capsWarn" class="hidden mt-1.5 text-2xs text-warn-ink flex items-center gap-1.5">' +
        '<i class="fas fa-arrow-up"></i>Caps Lock is on</p>' +
    '</div>';
  }

  function submitButton(icon, label) {
    return '<button type="submit" id="authSubmit" onmousedown="Auth.buttonSpark(event)" ' +
      'class="w-full mt-2 px-4 py-3 bg-brand hover:bg-brand-hover text-white rounded-lg ' +
      'text-sm font-semibold transition flex items-center justify-center gap-2 ' +
      'shadow-lg shadow-brand/25">' +
      '<i class="fas ' + icon + '"></i><span>' + U.esc(label) + '</span></button>';
  }

  function loginHTML() {
    return shell('fa-right-to-bracket', 'Sign in',
      'Your account reaches the shared bid register.',
      '<form onsubmit="Auth.submitLogin(event)">' +
        field('authUsername', 'Username', 'text',
              'autocomplete="username" required autocapitalize="none" spellcheck="false"') +
        passwordField('authPassword', 'Password', 'current-password') +
        submitButton('fa-right-to-bracket', 'Sign in') +
        '<p class="text-2xs text-faint text-center mt-4">' +
          'Sign in with your <strong class="text-muted">username</strong>, not your email ' +
          'address. Forgotten your password? An administrator can set a new one for you.</p>' +
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
        field('authUsername', 'Username', 'text',
              'autocomplete="username" required autocapitalize="none" spellcheck="false"') +
        field('authEmail', 'Email address (optional)', 'email', 'autocomplete="email"') +
        field('authInitials', 'Initials on the bids table', 'text',
          'maxlength="6" placeholder="e.g. MGJ" style="text-transform:uppercase"') +
        passwordField('authPassword', 'Password', 'new-password') +
        passwordField('authPassword2', 'Repeat the password', 'new-password') +
        '<p class="text-2xs text-faint mb-3">At least 8 characters, with a letter and a number.</p>' +
        submitButton('fa-user-shield', 'Create administrator') +
      '</form>');
  }

  function gateError(message) {
    var el = U.$('authError');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = message;
  }

  /* The button becomes a spinner in place and the fields lock, so a slow
     network cannot be signed in to twice. */
  function busy(on) {
    var b = U.$('authSubmit');
    if (b) {
      b.disabled = on;
      b.classList.toggle('opacity-60', on);
      var i = b.querySelector('i');
      var t = b.querySelector('span');
      if (i) i.className = on ? 'fas fa-circle-notch fa-spin' : i.dataset.rest || i.className;
      if (i && !i.dataset.rest && !on) i.dataset.rest = i.className;
      if (t) {
        if (on) { t.dataset.rest = t.textContent; t.textContent = 'Signing in...'; }
        else if (t.dataset.rest) t.textContent = t.dataset.rest;
      }
    }
    var form = b && b.closest('form');
    if (form) {
      Array.prototype.forEach.call(form.querySelectorAll('input'), function (el) {
        el.disabled = on;
      });
    }
  }

  /* ---- the person's own chip in the header ------------------------------ */

  function renderChip() {
    var host = U.$('userChip');
    if (!host) return;
    if (!user) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="relative">' +
        '<button onclick="Auth.toggleMenu(event)" ' +
          'class="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg bg-chrome-soft/70 hover:bg-chrome-soft transition">' +
          '<span class="w-7 h-7 rounded-md bg-brand text-white text-2xs font-bold flex items-center justify-center">' +
            U.esc(badgeFor(user)) + '</span>' +
          '<span class="text-left leading-tight hidden sm:block">' +
            '<span class="block text-xs font-semibold text-white">' + U.esc(user.name) + '</span>' +
            '<span class="block text-3xs text-faint">' + U.esc(user.role) + '</span>' +
          '</span>' +
          '<i class="fas fa-chevron-down text-3xs text-faint"></i>' +
        '</button>' +
        '<div id="userMenu" class="hidden absolute right-0 mt-1 w-56 bg-surface rounded-xl shadow-2xl ' +
             'border border-line py-1.5 z-50 text-ink">' +
          '<div class="px-3 py-2 border-b border-line">' +
            '<div class="text-xs font-semibold text-ink-strong truncate">' + U.esc(user.name) + '</div>' +
            '<div class="text-2xs text-muted truncate">' + U.esc(user.email || '@' + user.username) + '</div>' +
          '</div>' +
          menuItem('fa-key', 'Change my password', 'Auth.changePassword()') +
          menuItem('fa-table-columns', 'Reset my table layout', 'Auth.resetLayout()') +
          '<div class="border-t border-line my-1"></div>' +
          menuItem('fa-right-from-bracket', 'Sign out', 'Auth.logout()', true) +
        '</div>' +
      '</div>';
  }

  function menuItem(icon, label, onclick, danger) {
    return '<button onclick="' + onclick + '" class="w-full text-left px-3 py-2 text-sm ' +
      'hover:bg-raised flex items-center gap-2.5 ' + (danger ? 'text-danger' : '') + '">' +
      '<i class="fas ' + icon + ' w-4 text-xs ' + (danger ? '' : 'text-faint') + '"></i>' +
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
    /* What the sign-in screen draws, for whichever of the two states it is in.
       Exported because it is the one page in the app the test harness cannot
       reach any other way - off a server there is nobody to sign in as, so the
       gate never opens. */
    gateHTML: gateHTML,

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

    /* Show the password. Off by default; the icon and the label say which state
       it is in, because a button that toggles has to say what it will do. */
    toggleReveal: function (id) {
      var input = U.$(id), btn = U.$(id + 'Eye');
      if (!input || !btn) return;
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = '<i class="fas fa-eye' + (showing ? '' : '-slash') + ' text-xs"></i>';
      var label = showing ? 'Show the password' : 'Hide the password';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      // Put the cursor back where it was rather than at the start.
      var at = input.value.length;
      input.focus();
      try { input.setSelectionRange(at, at); } catch (e) { /* not all types allow it */ }
    },

    /* Caps Lock, called out while the password field has focus. getModifierState
       is not available on every event in every browser, so a null answer simply
       leaves the warning as it is rather than flapping it off. */
    capsCheck: function (ev) {
      var warn = U.$('capsWarn');
      if (!warn || !ev || typeof ev.getModifierState !== 'function') return;
      var on = ev.getModifierState('CapsLock');
      warn.classList.toggle('hidden', !on);
    },

    /* The submit button throws a few sparks when pressed - the same engine as
       the hero, so the page has one visual idea rather than two. */
    buttonSpark: function (ev) {
      if (!root.Sparks || !ev || root.Sparks.reduceMotion()) return;
      var canvas = U.$('introSparks');
      if (!canvas) return;
      var r = canvas.getBoundingClientRect();
      root.Sparks.burst(ev.clientX - r.left, ev.clientY - r.top, 14, 0.9);
    },

    submitLogin: function (ev) {
      ev.preventDefault();
      busy(true);
      api('/login', {
        method: 'POST',
        body: JSON.stringify({
          username: U.$('authUsername').value.trim(),
          password: U.$('authPassword').value
        })
      }).then(admitted).catch(function (e) {
        busy(false);
        gateError(e.message);
        // The username stays: it is almost never the thing that was wrong, and
        // retyping it every attempt is how three attempts become five.
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
          username: U.$('authUsername').value.trim(),
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
      var next = prompt('New password for ' + user.username +
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
