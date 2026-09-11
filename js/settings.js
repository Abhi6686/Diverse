/* settings.js - the Settings page: shop-wide reference data.
 *
 * Rate Library, References, Regions, Engineers and Company are not about any
 * one bid, so they moved out of Bid Management's sub-menu and behind the header
 * button. Rate Library and References already render themselves into their own
 * hosts and are untouched here; this file draws the rail beside them and owns
 * the three panels that used to be modals.
 *
 * The Regions and Engineers panels reproduce the element ids the modals used
 * (#regionList, #engineerList, #newRegionName, ...), so every add/remove/update
 * function in js/bids.js keeps working exactly as it did.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  /* Which panels this page offers, and in what order, comes from the Settings
     module in Nav.MENU - one list, not two that drift apart. Filtered through
     Nav so a panel this role may not open is not offered in the rail either. */
  function sections() {
    return root.Nav.sectionsOf(root.Nav.moduleOf('settings'));
  }

  function renderRail() {
    var host = U.$('settingsRail');
    if (!host) return;
    var current = root.Nav.current.section;

    host.innerHTML =
      '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden sticky top-4">' +
        '<div class="px-4 py-3 border-b border-line bg-raised">' +
          '<div class="text-sm font-bold text-ink-strong flex items-center gap-2">' +
            '<i class="fas fa-gear text-faint"></i>Settings</div>' +
          '<div class="text-2xs text-muted mt-0.5">Shop-wide, across every bid</div>' +
        '</div>' +
        '<nav class="p-2">' +
          sections().map(function (s) {
            var on = s.key === current;
            return '<button onclick="App.switchTab(\'' + s.key + '\')" ' +
              'class="w-full text-left px-3 py-2 rounded-lg text-sm mb-0.5 flex items-center gap-2.5 transition ' +
              (on ? 'bg-brand-soft text-brand-ink font-semibold'
                  : 'text-muted hover:bg-raised') + '">' +
              '<i class="fas ' + s.icon + ' w-4 text-xs ' + (on ? 'text-brand' : 'text-faint') + '"></i>' +
              U.esc(s.label) + '</button>';
          }).join('') +
        '</nav>' +
      '</div>';
  }

  /* ---- panel shell ------------------------------------------------------ */

  /* The same card shell the project overview uses, in its roomier size - see
     js/ui.js. It was a near-identical hand-built copy until they were merged. */
  function panel(title, blurb, body) {
    return root.UI.card({ title: title, blurb: blurb, body: body, size: 'lg' });
  }

  /* ---- panels ----------------------------------------------------------- */

  function regionsPanel() {
    return panel('Regions', 'The region/county list offered on every bid. Correcting a name ' +
      'carries the change onto every bid filed under it; removing one leaves the value on ' +
      'bids that already use it.',
      '<div class="flex gap-2 mb-4">' +
        '<input type="text" id="newRegionName" placeholder="New region/county name..." ' +
          'class="flex-1 px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===\'Enter\')Bids.addRegion()">' +
        '<button onclick="Bids.addRegion()" class="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
          '<i class="fas fa-plus"></i></button>' +
      '</div>' +
      '<div id="regionList" class="space-y-2 max-h-[520px] overflow-y-auto"></div>');
  }

  function engineersPanel() {
    return panel('Engineers', 'Initials appear on the bids table; the full name shows on hover. ' +
      'Renaming initials carries the change onto every bid that used them. Entries marked ' +
      '<span class="text-brand font-semibold">account</span> belong to somebody who signs in &mdash; ' +
      'add or remove those under People.',
      '<div class="flex gap-2 mb-4">' +
        '<input type="text" id="newEngineerInitials" placeholder="Initials" maxlength="6" ' +
          'class="w-24 px-3 py-2 bg-raised border border-line rounded-lg text-sm font-semibold uppercase focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===\'Enter\')Bids.addEngineerFromModal()">' +
        '<input type="text" id="newEngineerName" placeholder="Full name (optional)" ' +
          'class="flex-1 px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===\'Enter\')Bids.addEngineerFromModal()">' +
        '<button onclick="Bids.addEngineerFromModal()" class="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
          '<i class="fas fa-plus"></i></button>' +
      '</div>' +
      '<div id="engineerList" class="space-y-2 max-h-[520px] overflow-y-auto"></div>');
  }

  function taskTypesPanel() {
    return panel('Task Types', 'What an engineer\'s time on an active bid is booked against, ' +
      'offered on the Team &amp; Hours card. Adding one from that card puts it in this list too.',
      '<div class="flex gap-2 mb-4">' +
        '<input type="text" id="newTaskType" placeholder="New task type..." ' +
          'class="flex-1 px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===\'Enter\')Settings.addTaskType()">' +
        '<button onclick="Settings.addTaskType()" class="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
          '<i class="fas fa-plus"></i></button>' +
      '</div>' +
      '<div id="taskTypeList" class="space-y-2 max-h-[520px] overflow-y-auto"></div>');
  }

  /* Editable in place, with the count of rows using each one - the number that
     decides whether deleting it is safe. */
  function renderTaskTypeList() {
    var host = U.$('taskTypeList');
    if (!host) return;
    var list = (db().taskTypes || []).slice();
    host.innerHTML = list.length ? list.map(function (t, i) {
      var used = root.Assign.countTaskType(t);
      return '<div class="flex items-center gap-2 px-3 py-2 bg-raised rounded-lg">' +
        '<input value="' + U.escAttr(t) + '" onchange="Settings.renameTaskType(' + i + ',this.value)" ' +
          'class="flex-1 px-2 py-1 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
        '<span class="text-xs text-faint w-20 text-right">' +
          (used ? used + ' row' + (used > 1 ? 's' : '') : '') + '</span>' +
        '<button onclick="Settings.removeTaskType(' + i + ')" class="text-danger hover:text-danger-ink text-xs">' +
          '<i class="fas fa-trash"></i></button></div>';
    }).join('') : '<p class="text-sm text-faint text-center py-6">No task types yet.</p>';
  }

  function materialsPanel() {
    return panel('Materials',
      'What a product is made from, offered on the Products &amp; Materials card. ' +
      'A product can carry more than one; adding a material from that card puts it ' +
      'in this list too.',
      '<div class="flex gap-2 mb-4">' +
        '<input type="text" id="newMaterial" placeholder="New material..." ' +
          'class="flex-1 px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===&#39;Enter&#39;)Settings.addMaterial()">' +
        '<button onclick="Settings.addMaterial()" class="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
          '<i class="fas fa-plus"></i></button>' +
      '</div>' +
      '<div id="materialList" class="space-y-2 max-h-[520px] overflow-y-auto"></div>');
  }

  /* Same shape as the task type list: editable in place, with the count of 
     product rows using each one - the number that decides whether deleting it
     is safe. */
  function renderMaterialList() {
    var host = U.$('materialList');
    if (!host) return;
    var list = (db().materials || []).slice();
    host.innerHTML = list.length ? list.map(function (m, i) {
      var used = root.Products.countMaterial(m);
      return '<div class="flex items-center gap-2 px-3 py-2 bg-raised rounded-lg">' +
        '<input value="' + U.escAttr(m) + '" onchange="Settings.renameMaterial(' + i + ',this.value)" ' +
          'class="flex-1 px-2 py-1 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
        '<span class="text-xs text-faint w-20 text-right">' +
          (used ? used + ' row' + (used > 1 ? 's' : '') : '') + '</span>' +
        '<button onclick="Settings.removeMaterial(' + i + ')" class="text-danger hover:text-danger-ink text-xs">' +
          '<i class="fas fa-trash"></i></button></div>';
    }).join('') : '<p class="text-sm text-faint text-center py-6">No materials yet.</p>';
  }

  var COMPANY_FIELDS = [
    ['name', 'Company name'], ['address', 'Address'], ['phone', 'Phone'],
    ['email', 'Email'], ['brandSlogan', 'Slogan'], ['logoUrl', 'Logo URL']
  ];

  function companyPanel() {
    var c = db().company || {};
    return panel('Company', 'The letterhead every proposal is printed under.',
      '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' +
        COMPANY_FIELDS.map(function (f) {
          return '<div>' +
            '<label class="block text-3xs font-bold text-muted uppercase tracking-wider mb-1.5">' +
              U.esc(f[1]) + '</label>' +
            '<input value="' + U.escAttr(c[f[0]] || '') + '" ' +
              'onchange="Settings.setCompany(\'' + f[0] + '\',this.value)" ' +
              'class="w-full px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none">' +
          '</div>';
        }).join('') +
      '</div>');
  }

  /* ---- people ----------------------------------------------------------- */

  /* Accounts and roles are the one part of Settings that does not live in
     Store.db: they are on the server, behind admin.users / admin.roles, and are
     never synced to browsers that have no business holding them. So these two
     panels draw a shell and then fill it from the API, rather than rendering
     straight out of the in-memory database like every other panel here. */
  var people = { users: [], roles: [], loaded: false };

  function employeesPanel() {
    return panel('People', 'Everyone with an account. Each person is also an entry in the ' +
      'Engineers register, matched on their initials, so the bids they work show their name.',
      '<div id="peopleHost"><p class="text-sm text-faint text-center py-6">' +
        '<i class="fas fa-circle-notch fa-spin mr-2"></i>Loading...</p></div>');
  }

  function loadPeople(then) {
    root.Auth.listUsers().then(function (body) {
      people.users = body.users || [];
      people.roles = body.roles || [];
      people.loaded = true;
      then();
    }).catch(function (e) {
      var host = U.$('peopleHost');
      if (host) host.innerHTML = '<p class="text-sm text-danger text-center py-6">' + U.esc(e.message) + '</p>';
    });
  }

  function roleOptions(selectedId) {
    return people.roles.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === selectedId ? ' selected' : '') + '>' +
        U.esc(r.name) + '</option>';
    }).join('');
  }

  function renderPeople() {
    var host = U.$('peopleHost');
    if (!host) return;
    if (!people.loaded) { loadPeople(renderPeople); return; }

    host.innerHTML =
      /* The add form asks for a password rather than emailing an invitation:
         there is no mail server on an office LAN, and a link nobody can receive
         is worse than telling somebody their first password in person. */
      '<div class="bg-raised border border-line rounded-xl p-4 mb-5">' +
        '<div class="text-xs font-bold text-muted uppercase tracking-wider mb-3">Add someone</div>' +
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">' +
          inp('newUserName', 'Full name', 'text', '') +
          inp('newUserUsername', 'Username', 'text', '') +
          inp('newUserEmail', 'Email address (optional)', 'email', '') +
          inp('newUserInitials', 'Initials', 'text', 'maxlength="6" style="text-transform:uppercase"') +
          '<div><label class="block text-3xs font-bold text-muted uppercase tracking-wider mb-1.5">Role</label>' +
            '<select id="newUserRole" class="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm outline-none focus:border-brand">' +
              roleOptions((people.roles.find(function (r) { return r.name === 'Employee'; }) || {}).id) +
            '</select></div>' +
          inp('newUserPassword', 'First password', 'password', 'autocomplete="new-password"') +
          '<div class="flex items-end">' +
            '<button onclick="Settings.addUser()" class="w-full px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
              '<i class="fas fa-user-plus mr-1.5"></i>Create account</button></div>' +
        '</div>' +
        '<p class="text-2xs text-faint mt-2">Username: 3-32 characters, letters, numbers, dots, ' +
        'underscores or hyphens. Password: at least 8 characters, with a letter and a number. ' +
        'They can change their password from the menu under their name.</p>' +
      '</div>' +

      '<div class="space-y-2">' + people.users.map(userRow).join('') + '</div>';
  }

  function inp(id, label, type, extra) {
    return '<div>' +
      '<label class="block text-3xs font-bold text-muted uppercase tracking-wider mb-1.5">' +
        U.esc(label) + '</label>' +
      '<input id="' + id + '" type="' + type + '" ' + (extra || '') + ' ' +
        'class="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm outline-none focus:border-brand">' +
    '</div>';
  }

  /* THE AVATAR IS THE PICKER.

     Everyone gets a colour, and it is the same colour that picks their hours
     out of the Employee view's calendar - so the place to change it is the
     square showing it. Clicking it opens a strip of fourteen inside the row.

     The colour is stored on the ENGINEER RECORD, not on the account: an
     ordinary employee never sees the account list, but they do see the
     schedule, and the register is synced to every browser. Bids.engineerForUser
     follows the link the server made when the account was created. Somebody
     with no initials has no register entry yet, so there is nowhere to put a
     colour - the square says so rather than doing nothing. */
  function userRow(u) {
    var me = root.Auth.user && root.Auth.user.id === u.id;
    var eng = root.Bids.engineerForUser(u);
    var ini = U.esc(u.initials || initialsOf(u.name));
    return '<div class="flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-lg border ' +
        (u.active ? 'bg-surface border-line' : 'bg-raised border-line opacity-60') + '">' +
      (eng
        ? '<button type="button" onclick="Bids.toggleColorPicker(\'palUser-' + u.id + '\')" ' +
            'title="Choose ' + U.escAttr(u.name) + '\'s colour" ' +
            'class="person-chip pal-' + root.Bids.colorOf(eng) + ' ' +
            'w-8 h-8 rounded-lg text-3xs shrink-0">' + ini + '</button>'
        : '<span title="Give them initials to put them in the engineers register" ' +
            'class="w-8 h-8 rounded-lg bg-chrome text-white text-3xs font-bold ' +
            'flex items-center justify-center shrink-0">' + ini + '</span>') +
      '<div class="min-w-0 flex-1">' +
        '<div class="text-sm font-semibold text-ink-strong truncate">' + U.esc(u.name) +
          (me ? '<span class="ml-1.5 text-3xs font-normal text-brand">you</span>' : '') +
          (u.active ? '' : '<span class="ml-1.5 text-3xs font-normal text-muted">deactivated</span>') +
        '</div>' +
        '<div class="text-2xs text-muted truncate">@' + U.esc(u.username) +
          (u.email ? ' &middot; ' + U.esc(u.email) : '') + '</div>' +
      '</div>' +
      '<input value="' + U.escAttr(u.initials || '') + '" maxlength="6" placeholder="INI" ' +
        'onchange="Settings.setUserField(' + u.id + ',\'initials\',this.value)" ' +
        'class="w-16 px-2 py-1 bg-raised border border-line rounded text-sm font-semibold uppercase text-center outline-none focus:border-brand">' +
      '<select onchange="Settings.setUserField(' + u.id + ',\'roleId\',this.value)" ' +
        'class="px-2 py-1 bg-raised border border-line rounded text-sm outline-none focus:border-brand">' +
        roleOptions(u.roleId) + '</select>' +
      '<button onclick="Settings.resetUserPassword(' + u.id + ')" title="Set a new password" ' +
        'class="w-7 h-7 rounded-lg bg-neutral-soft text-muted hover:bg-line flex items-center justify-center">' +
        '<i class="fas fa-key text-xs"></i></button>' +
      '<button onclick="Settings.toggleUserActive(' + u.id + ',' + (u.active ? 'false' : 'true') + ')" ' +
        'title="' + (u.active ? 'Deactivate - they can no longer sign in' : 'Reactivate') + '" ' +
        'class="w-7 h-7 rounded-lg flex items-center justify-center ' +
        (u.active ? 'bg-warn-soft text-warn-ink hover:bg-warn-soft/60' : 'bg-ok-soft text-ok-ink hover:bg-ok-soft/60') + '">' +
        '<i class="fas ' + (u.active ? 'fa-user-slash' : 'fa-user-check') + ' text-xs"></i></button>' +
      '<button onclick="Settings.removeUser(' + u.id + ')" title="Delete this account" ' +
        'class="w-7 h-7 rounded-lg bg-danger-soft text-danger-ink hover:bg-danger-soft/60 flex items-center justify-center">' +
        '<i class="fas fa-trash text-xs"></i></button>' +
      (eng ? root.Bids.colorPicker(eng.id, U.n(eng.color), 'palUser-' + u.id) : '') +
    '</div>';
  }

  /* Called by Bids.setEngineerColor, because the colour it just changed is
     drawn here as well as on the schedule and the register. The list is held
     in `people` and not re-fetched: nothing about the ACCOUNT changed. */
  function repaintPeople() {
    if (U.$('peopleHost') && people.loaded) renderPeople();
  }

  function initialsOf(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* ---- roles ------------------------------------------------------------ */

  function rolesPanel() {
    return panel('Roles &amp; Access', 'What each role may do. Ticking a box here changes it for ' +
      'everyone in that role the next time they load the page. The server enforces these, so ' +
      'unticking something removes the ability, not just the button.',
      '<div id="rolesHost"><p class="text-sm text-faint text-center py-6">' +
        '<i class="fas fa-circle-notch fa-spin mr-2"></i>Loading...</p></div>');
  }

  function renderRoles() {
    var host = U.$('rolesHost');
    if (!host) return;
    if (!people.loaded) { loadPeople(renderRoles); return; }

    var catalogue = root.Auth.catalogue || [];
    var groups = [];
    catalogue.forEach(function (p) {
      var g = groups.filter(function (x) { return x.name === p.group; })[0];
      if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
      g.items.push(p);
    });

    host.innerHTML =
      '<div class="flex gap-2 mb-5">' +
        '<input type="text" id="newRoleName" placeholder="New role name..." ' +
          'class="flex-1 px-3 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none" ' +
          'onkeypress="if(event.key===\'Enter\')Settings.addRole()">' +
        '<button onclick="Settings.addRole()" class="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-medium transition">' +
          '<i class="fas fa-plus mr-1.5"></i>Add role</button>' +
      '</div>' +
      '<p class="text-2xs text-faint mb-4">A new role starts with the Employee access ' +
        'level; tick and untick from there.</p>' +
      people.roles.map(function (r) { return roleCard(r, groups); }).join('');
  }

  function roleCard(role, groups) {
    return '<div class="border border-line rounded-xl mb-4 overflow-hidden">' +
      '<div class="px-4 py-3 bg-raised border-b border-line flex items-center gap-3">' +
        '<i class="fas fa-user-shield text-faint"></i>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="text-sm font-bold text-ink-strong">' + U.esc(role.name) +
            (role.builtin ? '<span class="ml-2 text-3xs font-medium text-faint uppercase tracking-wider">built in</span>' : '') +
          '</div>' +
          '<div class="text-2xs text-muted">' +
            role.users + ' ' + (role.users === 1 ? 'person' : 'people') + ' &middot; ' +
            role.permissions.length + ' of ' + (root.Auth.catalogue || []).length + ' permissions</div>' +
        '</div>' +
        '<button onclick="Settings.saveRole(' + role.id + ')" ' +
          'class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold transition">' +
          '<i class="fas fa-check mr-1"></i>Save</button>' +
        (role.builtin ? '' :
          '<button onclick="Settings.removeRole(' + role.id + ')" title="Delete this role" ' +
            'class="w-7 h-7 rounded-lg bg-danger-soft text-danger-ink hover:bg-danger-soft/60 flex items-center justify-center">' +
            '<i class="fas fa-trash text-xs"></i></button>') +
      '</div>' +
      '<div class="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">' +
        groups.map(function (g) {
          return '<div>' +
            '<div class="text-3xs font-bold text-faint uppercase tracking-wider mb-2">' +
              U.esc(g.name) + '</div>' +
            g.items.map(function (p) {
              var on = role.permissions.indexOf(p.key) >= 0;
              return '<label class="flex items-start gap-2 py-1 cursor-pointer group">' +
                '<input type="checkbox" data-role="' + role.id + '" value="' + U.escAttr(p.key) + '" ' +
                  (on ? 'checked ' : '') +
                  'class="mt-0.5 rounded border-line-strong text-brand focus:ring-brand">' +
                '<span class="text-xs text-muted group-hover:text-ink-strong leading-snug">' +
                  U.esc(p.label) + '</span></label>';
            }).join('') +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function tickedFor(roleId) {
    var boxes = document.querySelectorAll('input[type=checkbox][data-role="' + roleId + '"]');
    return Array.prototype.filter.call(boxes, function (b) { return b.checked; })
      .map(function (b) { return b.value; });
  }

  /* Panels that live in #section-settings. Rate Library and References have
     their own hosts and their own modules; App.switchTab reveals those. */
  var PANELS = {
    regions: { html: regionsPanel, after: function () { root.Bids.renderRegionList(); } },
    engineers: { html: engineersPanel, after: function () { root.Bids.renderEngineerList(); } },
    tasktypes: { html: taskTypesPanel, after: renderTaskTypeList },
    materials: { html: materialsPanel, after: renderMaterialList },
    company: { html: companyPanel, after: null },
    employees: { html: employeesPanel, after: renderPeople },
    roles: { html: rolesPanel, after: renderRoles }
  };

  function render() {
    var host = U.$('section-settings');
    if (!host || host.classList.contains('hidden')) return;
    var p = PANELS[root.Nav.current.section];
    if (!p) { host.innerHTML = ''; return; }
    host.innerHTML = p.html();
    if (p.after) p.after();
  }

  root.Settings = {
    render: render,
    renderRail: renderRail,
    repaintPeople: repaintPeople,
    setCompany: function (key, value) {
      db().company[key] = String(value == null ? '' : value).trim();
      root.Store.save();
      U.toast('Company details saved.', 'ok');
    },

    addTaskType: function () {
      var input = U.$('newTaskType');
      var name = input.value.trim();
      if (!name) return;
      var d = db();
      if (d.taskTypes.some(function (t) { return t.toLowerCase() === name.toLowerCase(); })) {
        U.toast('That task type already exists.', 'warn');
        return;
      }
      d.taskTypes.push(name);
      input.value = '';
      root.Store.save();
      renderTaskTypeList();
    },

    /* A rename has to carry onto the rows using it, or those assignments
       quietly lose their task type - the same rule engineer initials follow. */
    renameTaskType: function (i, value) {
      var d = db();
      var from = d.taskTypes[i];
      var to = String(value || '').trim();
      if (from === undefined) return;
      if (!to) { renderTaskTypeList(); return; }
      if (to === from) return;
      if (d.taskTypes.some(function (t, j) {
        return j !== i && t.toLowerCase() === to.toLowerCase();
      })) {
        U.toast('"' + to + '" is already in the list.', 'warn');
        renderTaskTypeList();
        return;
      }
      d.taskTypes[i] = to;
      var moved = root.Assign.renameTaskType(from, to);
      root.Store.save();
      renderTaskTypeList();
      U.toast(moved ? 'Renamed on ' + moved + ' row' + (moved > 1 ? 's' : '') + '.' : 'Renamed.', 'ok');
    },

    /* Materials follow exactly the same three rules as task types: a new one
       joins the shared list, a rename carries onto every row using it, and a
       deletion leaves the value on the rows that already have it. */
    addMaterial: function () {
      var input = U.$('newMaterial');
      var name = input.value.trim();
      if (!name) return;
      var d = db();
      if (d.materials.some(function (m) { return m.toLowerCase() === name.toLowerCase(); })) {
        U.toast('That material already exists.', 'warn');
        return;
      }
      d.materials.push(name);
      input.value = '';
      root.Store.save();
      renderMaterialList();
    },

    renameMaterial: function (i, value) {
      var d = db();
      var from = d.materials[i];
      var to = String(value || '').trim();
      if (from === undefined) return;
      if (!to) { renderMaterialList(); return; }
      if (to === from) return;
      if (d.materials.some(function (m, j) {
        return j !== i && m.toLowerCase() === to.toLowerCase();
      })) {
        U.toast('"' + to + '" is already in the list.', 'warn');
        renderMaterialList();
        return;
      }
      d.materials[i] = to;
      var moved = root.Products.renameMaterial(from, to);
      root.Store.save();
      renderMaterialList();
      if (root.Bids) root.Bids.filterTable();
      U.toast(moved ? 'Renamed on ' + moved + ' product row' + (moved > 1 ? 's' : '') + '.' : 'Renamed.', 'ok');
    },

    removeMaterial: function (i) {
      var d = db();
      var name = d.materials[i];
      if (name === undefined) return;
      var used = root.Products.countMaterial(name);
      if (used && !confirm('"' + name + '" is on ' + used + ' product row(s).\n\n' +
        'Remove it from the list anyway? Those rows keep the value but it will no ' +
        'longer be offered on new ones.')) return;
      d.materials.splice(i, 1);
      root.Store.save();
      renderMaterialList();
    },

    /* Deleting leaves the value on the rows that carry it: those rows are a
       record of work done, and blanking them would lose that. */
    removeTaskType: function (i) {
      var d = db();
      var name = d.taskTypes[i];
      if (name === undefined) return;
      var used = root.Assign.countTaskType(name);
      if (used && !confirm('"' + name + '" is on ' + used + ' assignment row(s).\n\n' +
        'Remove it from the list anyway? Those rows keep the value but it will no ' +
        'longer be offered on new ones.')) return;
      d.taskTypes.splice(i, 1);
      root.Store.save();
      renderTaskTypeList();
    },

    /* ---- people ---------------------------------------------------------- */

    /* Every one of these reloads the whole list afterwards rather than patching
       the row in place. The server applies guard rails these screens cannot see
       - the last Admin, a role in use - so what came back is the truth and what
       is on screen is only what we asked for. */
    addUser: function () {
      root.Auth.createUser({
        name: U.$('newUserName').value.trim(),
        username: U.$('newUserUsername').value.trim(),
        email: U.$('newUserEmail').value.trim(),
        initials: U.$('newUserInitials').value.trim(),
        roleId: Number(U.$('newUserRole').value),
        password: U.$('newUserPassword').value
      }).then(function (body) {
        people.loaded = false;
        renderPeople();
        // The account also became an entry in the Engineers register, so the
        // dropdowns that name people need to know about it.
        root.Bids.refresh();
        U.toast(body.user.name + ' can now sign in.', 'ok');
      }).catch(function (e) { U.toast(e.message, 'err'); });
    },

    setUserField: function (id, field, value) {
      var patch = {};
      patch[field] = field === 'roleId' ? Number(value) : value;
      root.Auth.updateUser(id, patch).then(function () {
        people.loaded = false;
        renderPeople();
        if (field === 'initials') root.Bids.refresh();
      }).catch(function (e) {
        U.toast(e.message, 'err');
        people.loaded = false;
        renderPeople();          // put the control back to what is actually true
      });
    },

    toggleUserActive: function (id, active) {
      var u = people.users.filter(function (x) { return x.id === id; })[0] || {};
      if (!active && !confirm('Deactivate ' + u.name + '?\n\n' +
        'They will be signed out everywhere and cannot sign in again until you ' +
        'reactivate them. Their name stays on every bid they worked.')) return;
      root.Auth.updateUser(id, { active: !!active }).then(function () {
        people.loaded = false;
        renderPeople();
      }).catch(function (e) { U.toast(e.message, 'err'); });
    },

    resetUserPassword: function (id) {
      var u = people.users.filter(function (x) { return x.id === id; })[0] || {};
      var pw = prompt('New password for ' + u.name + ' (@' + u.username + ')\n\n' +
        'At least 8 characters, with a letter and a number. Tell it to them in person;\n' +
        'they can change it themselves from the menu under their name.');
      if (pw === null || pw === '') return;
      root.Auth.updateUser(id, { password: pw }).then(function () {
        U.toast('Password set. ' + u.name + ' has been signed out everywhere.', 'ok');
      }).catch(function (e) { U.toast(e.message, 'err'); });
    },

    /* Deactivating is almost always what is wanted instead - it keeps the
       account's history intact - so the confirmation says so rather than
       letting somebody delete a colleague's account by reflex. */
    removeUser: function (id) {
      var u = people.users.filter(function (x) { return x.id === id; })[0] || {};
      if (!confirm('Delete the account for ' + u.name + '?\n\n' +
        'Their entry in the Engineers register and their name on past bids stay, but the ' +
        'account is gone and cannot be restored.\n\n' +
        'If they have simply left, deactivating them is usually better.')) return;
      root.Auth.deleteUser(id).then(function () {
        people.loaded = false;
        renderPeople();
        U.toast('Account deleted.', 'ok');
      }).catch(function (e) { U.toast(e.message, 'err'); });
    },

    /* ---- roles ----------------------------------------------------------- */

    addRole: function () {
      var input = U.$('newRoleName');
      var name = input.value.trim();
      if (!name) return;
      var base = people.roles.filter(function (r) { return r.name === 'Employee'; })[0];
      root.Auth.createRole(name, base ? base.permissions : []).then(function () {
        input.value = '';
        people.loaded = false;
        renderRoles();
        U.toast('"' + name + '" created. Tick what it may do, then Save.', 'ok');
      }).catch(function (e) { U.toast(e.message, 'err'); });
    },

    saveRole: function (id) {
      root.Auth.updateRole(id, { permissions: tickedFor(id) }).then(function (body) {
        people.loaded = false;
        renderRoles();
        U.toast('"' + body.role.name + '" updated. Anyone in it sees the change when they ' +
          'next load the page.', 'ok');
        // Their own role may have just changed under them.
        if (root.Auth.user && root.Auth.user.roleId === id) {
          U.toast('That is your own role - reload to apply it to this window.', 'warn');
        }
      }).catch(function (e) {
        U.toast(e.message, 'err');
        people.loaded = false;
        renderRoles();
      });
    },

    removeRole: function (id) {
      var r = people.roles.filter(function (x) { return x.id === id; })[0] || {};
      if (!confirm('Delete the role "' + r.name + '"?')) return;
      root.Auth.deleteRole(id).then(function () {
        people.loaded = false;
        renderRoles();
        U.toast('Role deleted.', 'ok');
      }).catch(function (e) { U.toast(e.message, 'err'); });
    }
  };
})(window);
