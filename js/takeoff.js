/* takeoff.js - Takeoff tab UI: product tree, material tables with catalog
   autofill, the cost/labour block, and the drawing-reference grids. */
(function (root) {
  'use strict';

  var M = root.TakeoffModel, U = root.U;
  var state = { takeoffId: null, productId: null, groupId: null, tab: 'materials',
                view: 'estimate' };   // 'estimate' | 'rates'
  var priceFlags = {};        // itemId -> {delta, from, to} shown as a chip after save
  var pendingDelete = null;   // cost row id awaiting the inline "Remove?" confirm

  function db() { return root.Store.db; }
  function takeoff() { return state.takeoffId ? db().takeoffs[state.takeoffId] : null; }
  function product() {
    var t = takeoff();
    if (!t) return null;
    var p = t.products.filter(function (x) { return x.id === state.productId; })[0];
    return p || t.products[0] || null;
  }
  /* Stamping the takeoff on every edit is what lets a generated proposal know
     it has fallen behind - see Proposal.isStale. */
  function save() {
    var t = takeoff();
    if (t) t.updatedAt = new Date().toISOString();
    root.Store.save();
    render();
  }

  /* ---- open / create --------------------------------------------------- */

  function openForBid(bidId) {
    var d = db();
    var bid = d.bids.filter(function (b) { return b.id === bidId; })[0];
    if (!bid) return;
    if (!bid.takeoffId || !d.takeoffs[bid.takeoffId]) {
      var t = M.newTakeoff(bid);
      d.takeoffs[t.id] = t;
      bid.takeoffId = t.id;
    }
    state.takeoffId = bid.takeoffId;
    state.productId = null;
    d.ui.lastTakeoffId = state.takeoffId;
    root.Store.save();
    root.App.switchTab('takeoff');
  }

  function openTakeoff(id) {
    state.takeoffId = id;
    state.productId = null;
    db().ui.lastTakeoffId = id;
    save();
  }

  function bidFor(t) {
    if (!t || !t.bidId) return null;
    return db().bids.filter(function (b) { return b.id === t.bidId; })[0] || null;
  }

  /* ---- write-back to the bid tracker ----------------------------------- */

  function pushToBid(t) {
    var bid = bidFor(t);
    if (!bid) return;
    var roll = M.computeTakeoff(t);
    bid.lf = roll.totalLF || null;
    if (!bid.priceLocked) bid.price = Math.round(roll.total);
    if (bid.status === 'Not Started' && t.products.length) bid.status = 'In Progress';
  }

  /* ---- catalog learning on save ---------------------------------------- */

  function commit() {
    var t = takeoff();
    if (!t) return;
    var learned = 0, repriced = 0, dups = [];
    priceFlags = {};
    t.products.forEach(function (p) {
      p.groups.forEach(function (g) {
        g.items.forEach(function (it) {
          if (!it.description && !it.partNo) return;
          var res = root.Catalog.learn(it, p.type, t.project.name);
          if (!res) return;
          if (res.action === 'added') {
            learned++;
            it.catalogId = res.item.id;
            if (res.dupOf) dups.push({ item: res.item, dupOf: res.dupOf });
          } else if (res.action === 'repriced') {
            repriced++;
            it.catalogId = res.item.id;
            priceFlags[it.id] = { from: res.from, to: res.to, delta: res.delta };
          } else {
            it.catalogId = res.item.id;
          }
        });
      });
    });
    pushToBid(t);
    root.Store.flush();

    var msg = 'Takeoff saved.';
    if (learned) msg += ' ' + learned + ' new part' + (learned > 1 ? 's' : '') + ' added to the rate library.';
    if (repriced) msg += ' ' + repriced + ' price' + (repriced > 1 ? 's' : '') + ' updated.';
    U.toast(msg, 'ok');
    if (dups.length) {
      U.toast(dups.length + ' possible duplicate part' + (dups.length > 1 ? 's' : '') +
        ' - review on the Rate Library tab.', 'warn');
    }
    render();
    if (root.Bids) root.Bids.refresh();
  }

  /* ---- mutations ------------------------------------------------------- */

  function addProduct(type) {
    var t = takeoff();
    if (!t) return;
    var p = M.newProduct(type, t);
    M.applyDerived(p, t);
    t.products.push(p);
    state.productId = p.id;
    state.groupId = p.groups[0] ? p.groups[0].id : null;
    save();
  }

  function removeProduct(id) {
    var t = takeoff();
    var p = t.products.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (!confirm('Delete "' + p.type + '" and all of its material rows and takeoff grids?\n\nThis cannot be undone.')) return;
    t.products = t.products.filter(function (x) { return x.id !== id; });
    if (state.productId === id) state.productId = null;
    save();
  }

  function duplicateProduct(id) {
    var t = takeoff();
    var p = t.products.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var copy = JSON.parse(JSON.stringify(p));
    copy.id = root.Store.uid('prd');
    copy.type = p.type + ' (copy)';
    copy.groups.forEach(function (g) {
      g.id = root.Store.uid('grp');
      g.items.forEach(function (i) { i.id = root.Store.uid('mi'); });
      var remap = {};
      g.grid.columns.forEach(function (c) {
        var old = c.key;
        c.key = root.Store.uid('col');
        remap[old] = c.key;
      });
      g.grid.rows.forEach(function (r) {
        var v = {};
        Object.keys(r.values).forEach(function (k) { v[remap[k] || k] = r.values[k]; });
        r.values = v;
      });
    });
    t.products.push(copy);
    state.productId = copy.id;
    save();
  }

  function moveProduct(id, dir) {
    var t = takeoff();
    var i = t.products.findIndex(function (x) { return x.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= t.products.length) return;
    var tmp = t.products[i];
    t.products[i] = t.products[j];
    t.products[j] = tmp;
    save();
  }

  function currentGroup() {
    var p = product();
    if (!p) return null;
    var g = p.groups.filter(function (x) { return x.id === state.groupId; })[0];
    return g || p.groups[0] || null;
  }

  /* The current group first, then anywhere on the product: a row added for a
     scope lands in the group that owns the column, which is not always the one
     being looked at. */
  function itemById(itemId) {
    var g = currentGroup();
    var hit = g && g.items.filter(function (x) { return x.id === itemId; })[0];
    if (hit) return hit;
    var p = product();
    if (!p) return null;
    for (var i = 0; i < p.groups.length; i++) {
      var found = p.groups[i].items.filter(function (x) { return x.id === itemId; })[0];
      if (found) return found;
    }
    return null;
  }

  function addItem() {
    var g = currentGroup();
    if (!g) return;
    g.items.push(M.newItem());
    save();
    setTimeout(function () {
      var rows = document.querySelectorAll('#matBody tr');
      var last = rows[rows.length - 1];
      if (last) { var inp = last.querySelector('input'); if (inp) inp.focus(); }
    }, 0);
  }

  function removeItem(itemId) {
    var g = currentGroup();
    g.items = g.items.filter(function (i) { return i.id !== itemId; });
    save();
  }

  function moveItem(itemId, dir) {
    var g = currentGroup();
    var i = g.items.findIndex(function (x) { return x.id === itemId; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= g.items.length) return;
    var tmp = g.items[i]; g.items[i] = g.items[j]; g.items[j] = tmp;
    save();
  }

  function setItemField(itemId, field, value) {
    var it = itemById(itemId);
    if (!it) return;
    if (['qty', 'unitCost', 'weightLb', 'packQty'].indexOf(field) >= 0) {
      it[field] = value === '' ? null : Number(value);
    } else if (field === 'um' || field === 'packUm') {
      // Units are compared, not just printed - see TakeoffModel.unitMismatch -
      // so they are stored the way the datalist offers them.
      it[field] = String(value == null ? '' : value).trim().toUpperCase();
    } else {
      it[field] = value;
    }
    root.Store.save();
    /* A stock size changes the order quantity, which changes whether the row is
       still marked as missing one - that is a repaint, not a number swap. */
    if (field === 'packQty') render(); else updateTotals();
  }

  function applyCatalogItem(itemId, catId) {
    var g = currentGroup();
    var it = g.items.filter(function (x) { return x.id === itemId; })[0];
    var c = root.Catalog.find(catId);
    if (!it || !c) return;
    // A linked row's Feature is the drawing scope's name and is not the part's
    // to overwrite - the whole product totals by that name.
    var scopeName = it.qtyMode === 'takeoff' ? it.feature : null;
    M.applyCatalogTo(it, c);
    if (scopeName) it.feature = scopeName;
    if (c.weightPerUnit != null && it.qty) it.weightLb = c.weightPerUnit * Number(it.qty);
    save();
    if (!(U.n(c.packQty) > 0) && it.qtyMode === 'takeoff') {
      U.toast('The rate library has no stock size for this part - type the ' +
        'Length/PKT Qty and it will be remembered when you save.', 'warn');
    }
  }

  function addGroup() {
    var p = product();
    var name = prompt('Name for the new component group (e.g. "Surface Mounted Bollard"):', '');
    if (name == null) return;
    var g = M.newGroup(name.trim() || 'Group ' + (p.groups.length + 1), []);
    p.groups.push(g);
    state.groupId = g.id;
    save();
  }

  function renameGroup(gid) {
    var p = product();
    var g = p.groups.filter(function (x) { return x.id === gid; })[0];
    var name = prompt('Rename group:', g.name);
    if (name == null) return;
    g.name = name.trim() || g.name;
    save();
  }

  function removeGroup(gid) {
    var p = product();
    if (p.groups.length <= 1) { U.toast('A product needs at least one group.', 'warn'); return; }
    var g = p.groups.filter(function (x) { return x.id === gid; })[0];
    if (!confirm('Delete group "' + g.name + '" with its ' + g.items.length + ' material row(s)?')) return;
    p.groups = p.groups.filter(function (x) { return x.id !== gid; });
    state.groupId = p.groups[0].id;
    save();
  }

  /* ---- rendering ------------------------------------------------------- */

  function render() {
    var host = U.$('section-takeoff');
    if (!host || host.classList.contains('hidden')) return;
    var t = takeoff();
    if (!t) { host.innerHTML = renderPicker(); return; }
    host.innerHTML =
      '<div class="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-6">' +
        // The tree stays up in both views, so the effect of a rate change on
        // Total Bid Cost is visible while you are making it.
        '<div>' + renderTree(t) + '</div>' +
        '<div>' + (state.view === 'rates' ? renderProjectRates(t) : renderProductPane(t)) + '</div>' +
      '</div>';
  }

  function renderPicker() {
    var d = db();
    var withT = d.bids.filter(function (b) { return b.takeoffId && d.takeoffs[b.takeoffId]; });
    return '<div class="bg-surface rounded-xl shadow-sm border border-line p-8">' +
      '<h3 class="text-lg font-bold text-ink-strong mb-1">Takeoff</h3>' +
      '<p class="text-sm text-muted mb-6">Pick a bid to estimate. A takeoff is created the first time you open one.</p>' +
      (withT.length ? '<p class="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Existing takeoffs</p>' +
        '<div class="space-y-2 mb-6">' + withT.map(function (b) {
          var roll = M.computeTakeoff(d.takeoffs[b.takeoffId]);
          return '<button onclick="Takeoff.openTakeoff(\'' + b.takeoffId + '\')" ' +
            'class="w-full text-left px-4 py-3 rounded-lg border border-line hover:border-brand hover:bg-brand-soft/40 transition flex items-center justify-between">' +
            '<span class="text-sm font-semibold text-ink-strong">' + U.esc(b.project) + '</span>' +
            '<span class="text-sm font-mono text-muted">' + U.currency(roll.total) + '</span></button>';
        }).join('') + '</div>' : '') +
      '<p class="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Start a takeoff</p>' +
      '<select onchange="if(this.value)Takeoff.openForBid(Number(this.value))" class="w-full px-3 py-2.5 bg-raised border border-line rounded-lg text-sm outline-none focus:border-brand">' +
      '<option value="">Select a bid...</option>' +
      d.bids.filter(function (b) { return !b.takeoffId; }).map(function (b) {
        return '<option value="' + b.id + '">' + U.esc(b.project) + (b.region ? ' - ' + U.esc(b.region) : '') + '</option>';
      }).join('') + '</select></div>';
  }

  function renderTree(t) {
    var roll = M.computeTakeoff(t);
    var collapsed = db().ui.collapsed;
    var bid = bidFor(t);

    var products = roll.products.map(function (x) {
      var p = x.product, c = x.calc;
      var open = !collapsed['p:' + p.id];
      var active = p.id === (product() ? product().id : null);
      var unitLabel = p.unit === 'EA'
        ? U.qty(p.totalQty || c.itemCount) + ' EA'
        : U.qty(p.totalLF) + ' LF';

      var head = '<div class="flex items-center gap-1 px-2 py-2 rounded-lg cursor-pointer ' +
        (active ? 'bg-brand-soft ring-1 ring-brand/40' : 'hover:bg-raised') + '">' +
        '<button onclick="event.stopPropagation();Takeoff.toggle(\'p:' + p.id + '\')" class="w-5 text-faint hover:text-ink text-xs">' +
          '<i class="fas fa-chevron-' + (open ? 'down' : 'right') + '"></i></button>' +
        '<button onclick="Takeoff.selectProduct(\'' + p.id + '\')" class="flex-1 text-left min-w-0">' +
          '<div class="text-sm font-semibold text-ink-strong truncate">' + U.esc(p.type) + '</div>' +
          '<div class="text-2xs text-muted font-mono">' + unitLabel + ' &middot; ' + U.currency2(c.total) + '</div>' +
        '</button>' +
        '<span class="relative"><button onclick="event.stopPropagation();Takeoff.menu(\'' + p.id + '\')" class="w-6 h-6 rounded hover:bg-line text-faint text-xs"><i class="fas fa-ellipsis-v"></i></button>' +
        '<span id="menu-' + p.id + '" class="hidden absolute right-0 top-7 z-20 bg-surface border border-line rounded-lg shadow-xl py-1 w-44 text-left">' +
          menuItem('fa-copy', 'Duplicate', "Takeoff.duplicateProduct('" + p.id + "')") +
          menuItem('fa-arrow-up', 'Move up', "Takeoff.moveProduct('" + p.id + "',-1)") +
          menuItem('fa-arrow-down', 'Move down', "Takeoff.moveProduct('" + p.id + "',1)") +
          menuItem('fa-file-excel', 'Export sheet', "Takeoff.exportProduct('" + p.id + "')") +
          '<div class="border-t border-line my-1"></div>' +
          menuItem('fa-trash', 'Delete', "Takeoff.removeProduct('" + p.id + "')", 'text-danger') +
        '</span></span></div>';

      if (!open) return head;

      var groups = p.groups.map(function (g) {
        var gOpen = !collapsed['g:' + g.id];
        var gCost = M.groupMaterialCost(g, p);
        return '<div class="ml-6">' +
          '<div class="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-raised cursor-pointer">' +
            '<button onclick="Takeoff.toggle(\'g:' + g.id + '\')" class="w-4 text-faint text-3xs"><i class="fas fa-chevron-' + (gOpen ? 'down' : 'right') + '"></i></button>' +
            '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + g.id + '\')" class="flex-1 text-left text-xs text-muted truncate">' +
              U.esc(g.name) + ' <span class="text-faint">(' + g.items.length + ')</span></button>' +
            '<span class="text-2xs font-mono text-muted">' + U.currency2(gCost) + '</span></div>' +
          (gOpen ? '<div class="ml-5 border-l border-line pl-2">' + (g.items.length ? g.items.map(function (it) {
            var q = M.itemQty(it, g, p);
            return '<div class="py-1 text-2xs text-muted flex items-baseline gap-2 hover:text-ink-strong">' +
              '<span class="truncate flex-1" title="' + U.escAttr(it.description) + '">' +
              U.esc(it.feature || it.description || 'Untitled row') + '</span>' +
              '<span class="font-mono whitespace-nowrap">' + U.qty(q) + ' ' + U.esc(it.um || '') + '</span>' +
              '<span class="font-mono whitespace-nowrap text-muted">' + U.currency2(M.itemTotal(it, g, p)) + '</span></div>';
          }).join('') : '<div class="py-1 text-2xs text-faint italic">no rows</div>') + '</div>' : '') +
          '</div>';
      }).join('');

      var labour = '<div class="ml-6 px-2 py-1.5 flex items-center justify-between text-xs text-muted">' +
        '<span class="pl-4">Labour &amp; Equipment</span>' +
        '<span class="font-mono text-muted">' + U.currency2(c.labourEquipTotal) + '</span></div>' +
        '<div class="ml-6 px-2 py-1.5 flex items-center justify-between text-xs text-muted">' +
        '<span class="pl-4">Markup ' + U.qty(p.markupPct) + '% + O&amp;P ' + U.qty(p.overheadPct) + '%</span>' +
        '<span class="font-mono text-muted">' + U.currency2(c.markup + c.overhead) + '</span></div>';

      return head + groups + labour;
    }).join('');

    return '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden sticky top-4">' +
      '<div class="px-4 py-3 border-b border-line bg-raised flex items-center justify-between">' +
        '<div class="min-w-0"><div class="text-sm font-bold text-ink-strong truncate">' +
          U.esc(t.project.name || 'Untitled project') + '</div>' +
          '<div class="text-2xs text-muted">' + (bid ? U.esc(bid.region || 'No region') : 'Not linked to a bid') + '</div></div>' +
        '<div class="flex items-center gap-1 shrink-0">' +
          '<button onclick="Takeoff.setView(\'rates\')" title="Labour, equipment and markup rates for this project" ' +
            'class="text-xs px-1.5 py-1 rounded ' +
            (state.view === 'rates' ? 'text-brand bg-brand-soft' : 'text-faint hover:text-ink') +
            '"><i class="fas fa-sliders-h"></i></button>' +
          '<button onclick="Takeoff.openTakeoff(null)" class="text-xs text-faint hover:text-ink px-1.5 py-1" title="Choose another takeoff"><i class="fas fa-exchange-alt"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="p-2 max-h-[520px] overflow-y-auto">' +
        (products || '<p class="text-sm text-faint text-center py-8">No product types yet.<br>Add one below.</p>') +
      '</div>' +
      renderRollup(t, roll) +
      '<div class="p-3 border-t border-line bg-raised flex gap-2">' +
        '<select id="addProductType" class="flex-1 px-2 py-2 bg-surface border border-line rounded-lg text-xs outline-none">' +
          root.Rates.TYPES.map(function (ty) { return '<option>' + U.esc(ty) + '</option>'; }).join('') +
          '<option value="__custom">Custom...</option></select>' +
        '<button onclick="Takeoff.addFromPicker()" class="px-3 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1"></i>Add</button>' +
      '</div></div>';
  }

  function menuItem(icon, label, onclick, cls) {
    return '<button onclick="' + onclick + '" class="w-full text-left px-3 py-1.5 text-xs hover:bg-raised ' +
      (cls || 'text-ink') + '"><i class="fas ' + icon + ' w-4 mr-1.5"></i>' + label + '</button>';
  }

  function renderRollup(t, roll) {
    var r = t.rollup;
    function line(label, value, extra) {
      return '<div class="flex items-center justify-between py-1 text-xs ' + (extra || 'text-muted') + '">' +
        '<span>' + label + '</span><span class="font-mono">' + U.currency2(value) + '</span></div>';
    }
    return '<div class="px-4 py-3 border-t border-line bg-surface">' +
      line('Project Base Cost', roll.base, 'text-ink-strong font-semibold') +
      '<div class="flex items-center justify-between py-1 text-xs text-muted"><span>Total LF</span>' +
        '<span class="font-mono">' + U.qty(roll.totalLF) + '</span></div>' +
      '<div class="border-t border-line my-2"></div>' +
      rollInput('Miscellaneous', 'miscPct', r.miscPct, '%', roll.misc) +
      rollInput('Delivery &amp; Freight', 'freight', r.freight, '$', roll.freight) +
      rollInput('Tax', 'taxPct', r.taxPct, '%', roll.tax) +
      roundoffLine(r, roll) +
      '<div class="flex items-center justify-between pt-2 mt-2 border-t-2 border-line-strong">' +
        '<span class="text-xs font-bold text-ink-strong uppercase tracking-wider">Total Bid Cost</span>' +
        '<span class="font-mono text-base font-bold text-ink-strong">' + U.currency2(roll.total) + '</span></div>' +
      '<div class="flex gap-2 mt-3">' +
        '<button onclick="Takeoff.commit()" class="flex-1 px-3 py-2 bg-ok hover:bg-ok-hover text-white rounded-lg text-xs font-semibold"><i class="fas fa-save mr-1"></i>Save takeoff</button>' +
        '<button onclick="Proposal.generateFromTakeoff(\'' + t.id + '\')" class="flex-1 px-3 py-2 bg-chrome hover:bg-chrome-soft text-white rounded-lg text-xs font-semibold"><i class="fas fa-file-contract mr-1"></i>Proposal</button>' +
      '</div>' +
      /* The whole takeoff as a workbook. There is a per-product export in each
         product's menu too, but the estimate is worked as one thing and that is
         how it is usually wanted on paper. Same permission as the bids table
         export - see Nav.MENU. */
      (root.Auth.can('bid.export')
        ? '<button onclick="Takeoff.exportWorkbook()" title="Every product as its own worksheet, plus a cost summary" ' +
          'class="w-full mt-2 px-3 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-file-excel mr-1"></i>Export to Excel</button>'
        : '') +
      '</div>';
  }

  /* In auto mode the roundoff is the uplift to the next ten, so it is reported
     rather than typed. Manual mode stays available for sheets like the
     Lancaster workbook that carry a negotiated roundoff. */
  function roundoffLine(r, roll) {
    var auto = r.roundMode !== 'manual';
    return '<div class="flex items-center justify-between py-1 text-xs text-muted gap-2">' +
      '<span class="flex-1">Roundoff ' +
        '<button onclick="Takeoff.toggleRoundMode()" title="' +
        (auto ? 'Switch to a manually entered roundoff' : 'Switch back to rounding up to the next 10') + '" ' +
        'class="ml-1 px-1.5 py-0.5 rounded text-3xs font-bold uppercase tracking-wider ' +
        (auto ? 'bg-brand-soft text-brand-ink' : 'bg-line text-muted') + '">' +
        (auto ? 'auto' : 'manual') + '</button></span>' +
      (auto
        ? '<span class="text-3xs text-faint">to next 10</span>'
        : '<input type="number" step="1" value="' + (r.roundoff == null ? '' : r.roundoff) +
          '" onchange="Takeoff.setRollup(\'roundoff\',this.value)" ' +
          'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-right font-mono text-xs outline-none focus:border-brand">') +
      '<span class="font-mono w-24 text-right' + (auto ? ' text-brand-ink' : '') + '">' +
        (auto && roll.roundoff > 0 ? '+' : '') + U.currency2(roll.roundoff) + '</span></div>';
  }

  function rollInput(label, field, value, unit, computed) {
    return '<div class="flex items-center justify-between py-1 text-xs text-muted gap-2">' +
      '<span class="flex-1">' + label + '</span>' +
      (unit === '%' ? '<input type="number" step="0.1" value="' + (value == null ? '' : value) +
        '" onchange="Takeoff.setRollup(\'' + field + '\',this.value)" class="w-14 px-1.5 py-1 bg-raised border border-line rounded text-right font-mono text-xs outline-none focus:border-brand"><span class="text-faint -ml-1">%</span>' : '') +
      (unit === '$' ? '<input type="number" step="1" value="' + (value == null ? '' : value) +
        '" onchange="Takeoff.setRollup(\'' + field + '\',this.value)" class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-right font-mono text-xs outline-none focus:border-brand">' : '') +
      '<span class="font-mono w-24 text-right">' + U.currency2(computed) + '</span></div>';
  }

  /* ---- project rates --------------------------------------------------- */

  function projectRates(t) {
    if (!t.rates) t.rates = { global: {}, byType: {} };
    if (!t.rates.global) t.rates.global = {};
    if (!t.rates.byType) t.rates.byType = {};
    return t.rates;
  }

  /* Which per-product rate each Cost & Labour row bills at, so the page can
     say which products disagree with the project rate. */
  var RATE_TO_PATH = {
    engineeringRate: ['labour.engineering.rate', 'Engineering'],
    fabricationRate: ['labour.fabrication.rate', 'Fabrication'],
    installationRate: ['labour.installation.rate', 'Installation'],
    supervisorRate: ['labour.supervisor.rate', 'Supervisor'],
    forkliftPerDay: ['equipment.forklift.rate', 'Forklift'],
    truckPerDay: ['equipment.truck.rate', 'Truck'],
    finishPerLF: ['finish.unitCost', 'Finish'],
    markupPct: ['markupPct', 'Markup'],
    overheadPct: ['overheadPct', 'Overhead']
  };

  /* Products carry their own copy of each unit rate, taken when they were
     added. Changing the project rate does not reach back into them - an
     estimator may have typed that number deliberately - so the mismatch is
     reported and applied on request, naming the products first. */
  function rateMismatches(t) {
    var out = [];
    Object.keys(RATE_TO_PATH).forEach(function (key) {
      var path = RATE_TO_PATH[key][0];
      var want = root.Rates.forType('', t)[key];
      if (want == null) return;
      var off = (t.products || []).filter(function (p) {
        // Compare against what this product type should bill, so the
        // workbook's per-type quirks are not reported as drift.
        var expected = root.Rates.forType(p.type, t)[key];
        return U.n(M.pathGet(p, path)) !== U.n(expected);
      });
      if (off.length) out.push({ key: key, label: RATE_TO_PATH[key][1], products: off });
    });
    return out;
  }

  function renderProjectRates(t) {
    var pr = projectRates(t);
    var overridden = Object.keys(pr.global);
    var mismatches = rateMismatches(t);

    var panel = root.RatesPanel.render({
      title: 'Labour, Equipment &amp; Markup &mdash; this project',
      subtitle: 'Blank fields follow the shop defaults set on the Rate Library tab. ' +
        'Anything you change here applies to this project only.',
      get: function (key) {
        return pr.global[key] !== undefined ? pr.global[key]
          : root.Rates.forType('', t)[key];
      },
      isOverridden: function (key) { return pr.global[key] !== undefined; },
      setter: function (key) { return 'Takeoff.setProjectRate(\'' + key + '\',this.value)'; },
      resetter: function (key) { return 'Takeoff.clearProjectRate(\'' + key + '\')'; },
      headerRight: overridden.length
        ? '<button onclick="Takeoff.clearAllProjectRates()" class="text-xs text-warn hover:text-warn-ink underline">' +
          'Reset all ' + overridden.length + ' override' + (overridden.length > 1 ? 's' : '') + '</button>'
        : '<span class="text-xs text-faint">Following the shop defaults</span>',
      footer:
        '<p class="mt-3 text-2xs text-faint">The hour formulas (factors and base hours) ' +
        'recalculate immediately. Unit rates are stored on each product, so those are applied ' +
        'on request below.</p>'
    });

    var strip = mismatches.length
      ? '<div class="bg-surface rounded-xl shadow-sm border border-warn/30 p-5">' +
        '<h4 class="text-sm font-bold text-ink-strong mb-3">' +
          '<i class="fas fa-triangle-exclamation text-warn mr-2"></i>Products billing a different rate</h4>' +
        mismatches.map(function (m) {
          var want = root.Rates.forType('', t)[m.key];
          return '<div class="flex flex-wrap items-center gap-3 py-2 border-t border-line text-xs">' +
            '<span class="font-semibold text-ink w-28 shrink-0">' + U.esc(m.label) + '</span>' +
            '<span class="flex-1 min-w-[180px] text-muted">' +
              m.products.map(function (p) {
                return U.esc(p.type) + ' <span class="font-mono text-faint">(' +
                  U.qty(M.pathGet(p, RATE_TO_PATH[m.key][0])) + ')</span>';
              }).join(', ') + '</span>' +
            '<button onclick="Takeoff.applyRateToProducts(\'' + m.key + '\')" ' +
              'class="px-2.5 py-1 bg-chrome hover:bg-chrome-soft text-white rounded text-2xs font-semibold whitespace-nowrap">' +
              'Apply ' + U.qty(want) + ' to ' + m.products.length + '</button>' +
          '</div>';
        }).join('') +
        '</div>'
      : '<div class="bg-surface rounded-xl shadow-sm border border-line p-5 text-xs text-muted">' +
        '<i class="fas fa-check-circle text-ok mr-1.5"></i>' +
        'Every product in this takeoff bills the project rates.</div>';

    return '<div>' +
      '<div class="flex items-center justify-between mb-4">' +
        '<div><h3 class="text-lg font-bold text-ink-strong">Project Rates</h3>' +
        '<p class="text-xs text-muted">' + U.esc(t.project.name || 'Untitled project') + '</p></div>' +
        '<button onclick="Takeoff.setView(\'estimate\')" class="px-3 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-arrow-left mr-1.5"></i>Back to the estimate</button>' +
      '</div>' + panel + strip + '</div>';
  }

  /* ---- right pane ------------------------------------------------------ */

  function renderProductPane(t) {
    var p = product();
    if (!p) {
      /* Documents is reachable before any product exists, because filing the
         drawings is what people do first - the tab strip below only appears
         once there is a product to put tabs on. */
      if (state.tab === 'docs') {
        return '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden">' +
          '<div class="px-5 py-3 border-b border-line bg-raised flex items-center gap-3">' +
            '<button onclick="Takeoff.setTab(\'materials\')" class="text-xs text-faint hover:text-ink">' +
              '<i class="fas fa-arrow-left mr-1"></i>Back</button>' +
            '<span class="text-sm font-bold text-ink-strong">Documents</span></div>' +
          '<div class="p-5">' + renderDocuments(t) + '</div></div>';
      }
      return '<div class="bg-surface rounded-xl shadow-sm border border-line p-12 text-center">' +
        '<i class="fas fa-cubes text-4xl text-chrome-ink mb-3"></i>' +
        '<p class="text-muted text-sm mb-4">Add a product type to start the takeoff.</p>' +
        '<button onclick="Takeoff.setTab(\'docs\')" class="px-3 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-folder-open mr-1.5"></i>Documents' +
          (M.documents(t).length ? ' (' + M.documents(t).length + ')' : '') + '</button></div>';
    }
    var c = M.computeProduct(p);
    var docCount = M.documents(t).length;
    /* Documents is last and deliberately not per-product: the drawings are the
       project's, and filing them once under the handrail and again under the
       bollards would be two lists to keep in step. The count is on the tab so
       an empty one reads as empty without being opened. */
    var tabs = [['materials', 'Materials', 'fa-list', ''],
                ['cost', 'Cost & Labour', 'fa-calculator', ''],
                ['grid', 'Drawing Takeoff', 'fa-ruler-combined', ''],
                ['docs', 'Documents', 'fa-folder-open', docCount ? String(docCount) : '']];

    var body = state.tab === 'materials' ? renderMaterials(p, c)
      : state.tab === 'cost' ? renderCost(p, c)
      : state.tab === 'docs' ? renderDocuments(t)
      : renderGrid(p);

    return '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden">' +
      '<div class="px-5 py-4 border-b border-line flex flex-wrap items-center gap-3 justify-between">' +
        '<div class="flex items-center gap-3 min-w-0">' +
          '<input value="' + U.escAttr(p.type) + '" onchange="Takeoff.setProductField(\'type\',this.value)" ' +
            'class="text-lg font-bold text-ink-strong bg-transparent border-b border-transparent hover:border-line focus:border-brand outline-none px-1 min-w-[180px]">' +
          '<span class="px-2 py-0.5 bg-neutral-soft rounded text-3xs font-semibold text-muted uppercase">' + U.esc(p.sow || '') + '</span>' +
        '</div>' +
        '<div class="font-mono text-lg font-bold text-ink-strong">' + U.currency2(c.total) + '</div>' +
      '</div>' +
      '<div class="flex border-b border-line bg-raised">' +
        tabs.map(function (tb) {
          var on = state.tab === tb[0];
          return '<button onclick="Takeoff.setTab(\'' + tb[0] + '\')" class="px-5 py-3 text-xs font-semibold transition ' +
            (on ? 'text-brand-ink border-b-2 border-brand bg-surface' : 'text-muted hover:text-ink-strong') + '">' +
            '<i class="fas ' + tb[2] + ' mr-1.5"></i>' + tb[1] +
            (tb[3] ? '<span class="ml-1.5 px-1.5 py-0.5 rounded-full text-3xs font-bold ' +
              (on ? 'bg-brand text-white' : 'bg-neutral-soft text-muted') + '">' + tb[3] + '</span>' : '') +
            '</button>';
        }).join('') +
      '</div>' +
      '<div class="p-5">' + body + '</div></div>';
  }

  function renderMaterials(p, c) {
    var g = currentGroup();
    var offCount = g.items.filter(function (it) { return !M.isItemOnProposal(it); }).length;
    var groupTabs = p.groups.map(function (gr) {
      var on = gr.id === g.id;
      var off = gr.items.filter(function (it) { return !M.isItemOnProposal(it); }).length;
      return '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + gr.id + '\')" ' +
        'class="px-3 py-1.5 rounded-lg text-xs font-medium transition ' +
        (on ? 'bg-chrome text-white' : 'bg-neutral-soft text-muted hover:bg-line') + '"' +
        (off ? ' title="' + off + ' row(s) hidden from the proposal"' : '') + '>' +
        U.esc(gr.name) + ' <span class="opacity-60">' + gr.items.length + '</span>' +
        (off ? '<span class="ml-1 opacity-60">&middot; ' + off + ' off</span>' : '') + '</button>';
    }).join('');

    /* No Options column. It held an abbreviated restatement of the Description
       ("8\" SCH 40" beside "Carbon Steel 8 SCH 40 PIPE A-500 GR B 8.625\" OD
       .322 Thk."), which meant typing the same specification twice and gave the
       proposal the shorter of the two to print. The Description is the one the
       client should read, so it is the one kept. */
    var scopes = M.productScopes(p);
    var needStock = g.items.filter(needsStockSize).length;

    var rows = g.items.map(function (it, idx) {
      return materialRow(p, g, it, idx, scopes);
    }).join('');

    return '<div class="flex flex-wrap items-center gap-2 mb-4">' + groupTabs +
        '<button onclick="Takeoff.addGroup()" class="px-2.5 py-1.5 rounded-lg text-xs text-faint hover:text-brand border border-dashed border-line-strong" title="Add a component group"><i class="fas fa-plus"></i></button>' +
        (p.groups.length > 1 ? '<button onclick="Takeoff.removeGroup(\'' + g.id + '\')" class="px-2.5 py-1.5 rounded-lg text-xs text-faint hover:text-danger" title="Delete this group"><i class="fas fa-trash"></i></button>' : '') +
        '<button onclick="Takeoff.renameGroup(\'' + g.id + '\')" class="px-2.5 py-1.5 rounded-lg text-xs text-faint hover:text-ink" title="Rename group"><i class="fas fa-pen"></i></button>' +
        '<span class="flex-1"></span>' +
        // Says what is missing without hiding anything: the rows themselves are
        // already marked, and a filter over a hand-ordered table you can move
        // rows around in would be a worse place to stand.
        (needStock
          ? '<button onclick="Takeoff.scrollToStockGap()" ' +
            'class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold bg-warn-soft text-warn-ink border border-warn/30 hover:bg-warn-soft/60" ' +
            'title="Order quantities on these rows assume one item per unit until a stock size is given">' +
            '<i class="fas fa-box-open mr-1"></i>' + needStock + ' row' + (needStock > 1 ? 's' : '') +
            ' need a stock size</button>'
          : '') +
        unlinkedScopesChip(p, scopes) +
      '</div>' +
      '<div class="overflow-x-auto border border-line rounded-lg">' +
      '<table class="w-full text-xs grid-table">' + materialHead(offCount) +
      '<tbody id="matBody">' + (rows ||
        '<tr><td colspan="' + MAT_COLS.length + '" class="px-3 py-8 text-center text-faint">No material rows yet.</td></tr>') +
      '</tbody><tfoot class="bg-raised border-t-2 border-line-strong"><tr>' +
        // Everything up to Total Cost, which carries the figure, then the
        // row-controls column. Counted off MAT_COLS rather than written out, so
        // adding a column cannot leave the label under the wrong heading.
        '<td colspan="' + (MAT_COLS.length - 2) + '" class="px-2 py-2.5 text-right font-bold text-ink uppercase text-3xs tracking-wider">Material Cost</td>' +
        '<td class="px-2 py-2.5 text-right font-mono font-bold text-ink-strong" id="matCost">' + U.currency2(c.materialCost) + '</td><td></td>' +
      '</tr></tfoot></table></div>' +
      umDatalist() +
      '<button onclick="Takeoff.addItem()" class="mt-3 px-4 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add material row</button>' +
      '<div class="mt-3 text-2xs text-faint space-y-1">' +
        '<p><i class="fas fa-link mr-1"></i>A row with the chain icon is measured off the <strong>Drawing Takeoff</strong> grid and totals every column of that name across the product. ' +
        'Give it the vendor\'s <strong>Length/PKT QTY</strong> - 21 LF to a stick, 100 EA to a packet - and the Order Qty is worked out and rounded up for you.</p>' +
        '<p>Start typing in <strong>Vendor Part No</strong> or <strong>Description</strong> to pull a part from the rate library, which brings its stock size with it. New parts are added to it automatically when you save.</p>' +
        '<p><i class="fas fa-file-contract mr-1"></i>Untick a row to keep it in the cost but leave it off the bid proposal.</p>' +
      '</div>';
  }

  /* THE MATERIAL TABLE'S COLUMNS, IN ONE PLACE.
   *
   * The table grew from eleven columns to sixteen, and three of them are called
   * U/M - the unit the drawing measured in, the unit the vendor's stock size is
   * in, and the unit being bought. Written out as literal <th>s they would be
   * indistinguishable, and the colspans in the header and footer would each be
   * a number somebody had counted by hand.
   *
   * So the columns are a list. The two header rows, the alignment and both
   * colspans are read off it, and a column added here appears everywhere at
   * once. `band` is the second-tier heading a run of columns sits under. */
  var MAT_COLS = [
    { key: 'proposal', label: '' },
    { key: 'feature', label: 'Features' },
    { key: 'vendor', label: 'Vendor' },
    { key: 'partNo', label: 'Vendor Part No' },
    { key: 'description', label: 'Description' },
    { key: 'reqQty', label: 'Qty', band: 'From Drawing Takeoff', right: true },
    { key: 'reqUm', label: 'U/M', band: 'From Drawing Takeoff', center: true },
    { key: 'packQty', label: 'Length/PKT Qty', band: 'Vendor Stock', right: true },
    { key: 'packUm', label: 'U/M', band: 'Vendor Stock', center: true },
    { key: 'orderQty', label: 'Qty', band: 'Order', right: true },
    { key: 'um', label: 'U/M', band: 'Order', center: true },
    { key: 'material', label: 'Material' },
    { key: 'grade', label: 'Grade' },
    { key: 'weightLb', label: 'Weight (lb)', right: true },
    { key: 'unitCost', label: 'Unit Cost', right: true },
    { key: 'total', label: 'Total Cost', right: true },
    { key: 'controls', label: '' }
  ];

  var BAND_TONE = {
    'From Drawing Takeoff': 'bg-brand-soft/50 text-brand-ink',
    'Vendor Stock': 'bg-warn-soft/40 text-warn-ink',
    'Order': 'bg-ok-soft/50 text-ok-ink'
  };

  function materialHead(offCount) {
    /* The band row. Consecutive columns sharing a band become one merged cell;
       everything else is an empty spacer, so the two rows stay in step without
       any column being described twice. */
    var bands = '', i = 0;
    while (i < MAT_COLS.length) {
      var band = MAT_COLS[i].band || '';
      var span = 1;
      while (i + span < MAT_COLS.length && (MAT_COLS[i + span].band || '') === band) span++;
      bands += '<th colspan="' + span + '" class="px-2 pt-2 pb-1 text-center font-bold uppercase text-3xs tracking-widest ' +
        (band ? (BAND_TONE[band] || 'bg-neutral-soft text-muted') + ' rounded-t' : '') + '">' +
        U.esc(band) + '</th>';
      i += span;
    }

    return '<thead><tr>' + bands + '</tr><tr>' +
      MAT_COLS.map(function (col) {
        if (col.key === 'proposal') {
          return '<th class="px-2 py-2 w-8 text-center font-semibold text-muted" title="Show these rows on the bid proposal">' +
            '<input type="checkbox" ' + (offCount === 0 ? 'checked ' : '') +
            'onchange="Takeoff.setAllItemsOnProposal(this.checked)" class="cursor-pointer" ' +
            'title="Tick or untick every row in this group"></th>';
        }
        var align = col.right ? 'text-right' : col.center ? 'text-center' : 'text-left';
        return '<th class="px-2 py-2 ' + align + ' font-semibold text-muted uppercase text-3xs tracking-wider whitespace-nowrap ' +
          (col.band ? (BAND_TONE[col.band] || '') : '') + '">' + U.esc(col.label) + '</th>';
      }).join('') + '</tr></thead>';
  }

  /* A row whose order quantity is being worked out with an assumed stock size
     of one. Not an error - a bracket really is bought one at a time - but on a
     row measured in feet it is the number nobody has filled in yet. */
  function needsStockSize(it) {
    return it.qtyMode === 'takeoff' && !(U.n(it.packQty) > 0);
  }

  function umDatalist() {
    return '<datalist id="umList">' +
      M.UNITS.map(function (u) { return '<option value="' + u + '">'; }).join('') +
      '</datalist>';
  }

  /* Scopes measured on the drawings that nothing is being bought for. Normally
     empty, because syncScopeRows adds the row as soon as a quantity is typed;
     it appears when somebody has deleted the row, or unlinked it. */
  function unlinkedScopesChip(p, scopes) {
    var linked = {};
    p.groups.forEach(function (g) {
      g.items.forEach(function (it) { if (it.scopeKey) linked[it.scopeKey] = true; });
    });
    var missing = scopes.filter(function (s) { return s.total && !linked[s.key]; });
    if (!missing.length) return '';
    return '<button onclick="Takeoff.addRowsForScopes()" ' +
      'class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold bg-brand-soft text-brand-ink border border-brand/30 hover:bg-brand-soft/60" ' +
      'title="' + U.escAttr(missing.map(function (s) { return s.name; }).join(', ')) + '">' +
      '<i class="fas fa-link mr-1"></i>' + missing.length + ' measured scope' +
      (missing.length > 1 ? 's have' : ' has') + ' no material row</button>';
  }

  function materialRow(p, g, it, idx, scopes) {
    var req = M.requiredQty(it, g, p);
    var order = M.orderQty(it, g, p);
    var err = M.itemQtyError(it, g, p);
    var flag = priceFlags[it.id];
    var mism = M.unitMismatch(it, g, p);
    var linked = it.qtyMode === 'takeoff';
    var scope = linked ? M.findScope(p, it.scopeKey) : null;
    var perPack = U.n(it.packQty);

    function td(inner, cls) { return '<td class="px-1 py-1 ' + (cls || '') + '">' + inner + '</td>'; }

    return '<tr class="hover:bg-raised/60 align-top"' +
        (needsStockSize(it) ? ' data-needs-stock="1"' : '') + ' id="row-' + it.id + '">' +
      '<td class="px-2 py-1 text-center">' + proposalCheckbox(
        'Takeoff.setItemOnProposal(\'' + it.id + '\',this.checked)',
        M.isItemOnProposal(it), false) + '</td>' +

      /* Features. On a linked row this is the scope's name, shown as the picker
         that chose it rather than as a text box - the name belongs to the
         drawing grid, and two spellings of one scope is exactly what the
         name-keyed total exists to prevent. Rename it on the Drawing Takeoff
         tab, or unlink and it becomes a plain row again. */
      td(linked ? scopeSelect(it, scopes, err) : featureCell(it, scopes), 'min-w-[150px]') +

      td('<input value="' + U.escAttr(it.vendor) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'vendor\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand">') +
      partNoCell(it, p.type) +
      comboCell(it, 'description', 'min-w-[220px] w-full', p.type) +

      /* From the drawing: what the job needs. Read-only when it is measured -
         the drawings are where that number is changed. */
      td(linked
        ? '<span class="block px-1 py-1 font-mono text-right text-ink-strong" ' +
          'title="' + U.escAttr(scope ? 'Totalled from "' + scope.name + '" across every group of ' + p.type : 'Scope missing') + '">' +
          (scope ? U.qty(req) : '<span class="text-danger">&mdash;</span>') + '</span>'
        : it.qtyMode === 'formula'
          ? '<input value="' + U.escAttr(it.qtyExpr) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'qtyExpr\',this.value)" ' +
            'placeholder="ROUNDUP(TK(&quot;col&quot;)/21,0)+1" title="' + (err ? U.escAttr(err) : U.escAttr('= ' + U.qty(req))) + '" ' +
            'class="w-32 px-1.5 py-1 border rounded text-xs font-mono outline-none ' +
            (err ? 'border-danger/40 bg-danger-soft text-danger-ink' : 'border-ok/40 bg-ok-soft') + '">' +
            (err ? '<div class="text-3xs text-danger mt-0.5 max-w-[130px]">' + U.esc(err) + '</div>' : '')
          : '<input type="number" step="any" value="' + (it.qty == null ? '' : it.qty) + '" ' +
            'onchange="Takeoff.setItem(\'' + it.id + '\',\'qty\',this.value)" ' +
            'class="w-20 px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand">',
        'text-right') +

      td(linked && scope
        ? '<span class="block px-1 py-1 text-center text-muted font-mono">' + U.esc(scope.um || '') + '</span>'
        : '<span class="block px-1 py-1 text-center text-faint">&mdash;</span>') +

      /* The vendor's stock size. Dashed amber while blank on a measured row,
         because the order quantity beside it is standing on an assumption. */
      td('<input type="number" step="any" min="0" value="' + (it.packQty == null ? '' : it.packQty) + '" ' +
        'onchange="Takeoff.setItem(\'' + it.id + '\',\'packQty\',this.value)" ' +
        'placeholder="' + (needsStockSize(it) ? '1' : '') + '" ' +
        'title="How much of the measured quantity comes in one purchased item - 21 LF to a stick of pipe, 100 EA to a packet of washers" ' +
        'class="w-20 px-1.5 py-1 rounded text-xs text-right font-mono outline-none focus:border-brand ' +
        (needsStockSize(it) ? 'bg-warn-soft/40 border border-dashed border-warn/60 placeholder-warn-ink/50' : 'bg-raised border border-line') + '">',
        'text-right') +

      td(umInput(it, 'packUm', 'Unit the stock size is counted in') +
        (mism
          ? '<div class="text-3xs text-warn-ink mt-0.5 leading-tight" title="' +
            U.escAttr('The drawing measured this in ' + mism.from + ' but the stock size is given in ' +
              mism.to + '. Dividing one by the other may not mean anything - worth a look.') + '">' +
            '<i class="fas fa-triangle-exclamation"></i> vs ' + U.esc(mism.from) + '</div>'
          : '')) +

      /* What gets bought, and what the row is costed at. Always whole, and
         always the estimator's to disagree with. */
      td(orderQtyCell(it, g, p, req, order, perPack), 'text-right') +

      td(umInput(it, 'um', 'Unit this is bought and priced in')) +

      td('<input value="' + U.escAttr(it.material) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'material\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand">') +
      td('<input value="' + U.escAttr(it.grade) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'grade\',this.value)" ' +
        'class="w-20 px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand">') +
      td('<input type="number" step="any" value="' + (it.weightLb == null ? '' : it.weightLb) + '" ' +
        'onchange="Takeoff.setItem(\'' + it.id + '\',\'weightLb\',this.value)" ' +
        'class="w-20 px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand">',
        'text-right') +

      td('<input type="number" step="any" value="' + (it.unitCost == null ? '' : it.unitCost) + '" ' +
        'onchange="Takeoff.setItem(\'' + it.id + '\',\'unitCost\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand">' +
        costBasisChip(it, scope) +
        (flag ? '<div class="text-3xs mt-0.5 ' + (flag.delta > 0 ? 'text-danger' : 'text-ok') + '" title="Was ' + U.currency2(flag.from) + '">' +
          (flag.delta > 0 ? '&#9650;' : '&#9660;') + ' ' + U.currency2(Math.abs(flag.delta || 0)) + '</div>' : ''),
        'text-right') +

      '<td class="px-2 py-1 text-right font-mono text-xs font-semibold text-ink-strong whitespace-nowrap" id="tot-' + it.id + '">' +
        U.currency2(M.itemTotal(it, g, p)) + '</td>' +
      '<td class="px-1 py-1 whitespace-nowrap">' +
        '<button onclick="Takeoff.moveItem(\'' + it.id + '\',-1)" class="w-5 h-5 text-faint hover:text-ink text-3xs" title="Move up"' + (idx === 0 ? ' disabled' : '') + '><i class="fas fa-chevron-up"></i></button>' +
        '<button onclick="Takeoff.moveItem(\'' + it.id + '\',1)" class="w-5 h-5 text-faint hover:text-ink text-3xs" title="Move down"' + (idx === g.items.length - 1 ? ' disabled' : '') + '><i class="fas fa-chevron-down"></i></button>' +
        '<button onclick="Takeoff.removeItem(\'' + it.id + '\')" class="w-5 h-5 text-faint hover:text-danger text-3xs" title="Delete row"><i class="fas fa-times"></i></button>' +
      '</td></tr>';
  }

  /* ORDER QTY: WORKED OUT, AND STILL YOURS TO CHANGE.
   *
   * Deliberately the same control the Cost & Labour rows use for a typed-over
   * hour count - amber field, undo arrow, the calculated value in the tooltip
   * (see costRow). It is the same idea and the estimator has already learned
   * it once; giving it a second appearance here would be a second thing to
   * learn for no reason.
   *
   * The calculation never stops running underneath. That is what makes the
   * stale chip possible: re-measure the drawings and the row can say that what
   * you told it to order no longer matches what it works out, without either
   * number being thrown away to find that out.
   */
  function orderQtyCell(it, g, p, req, order, perPack) {
    var calc = M.computedOrderQty(it, g, p);
    var over = it.orderQtyOverride != null && it.orderQtyOverride !== '';
    var stale = M.orderQtyStale(it, g, p);

    var title = over
      ? 'Typed by hand. ' + (calc == null ? 'Nothing to calculate from.'
          : 'Calculated value: ' + U.qty(calc) + '.') + ' Blank the box to go back to it.'
      : orderExplain(it, req, order, perPack);

    return '<input type="number" step="1" min="0" id="ord-' + it.id + '" ' +
        'value="' + (order == null ? '' : U.n(order)) + '" ' +
        'onchange="Takeoff.setOrderQty(\'' + it.id + '\',this.value)" ' +
        'title="' + U.escAttr(title) + '" aria-label="Quantity to order" ' +
        'class="w-20 px-1.5 py-1 rounded text-xs text-right font-mono font-bold outline-none focus:border-brand ' +
        (over ? 'bg-warn-soft border border-warn/40 text-warn-ink' : 'bg-raised border border-line text-ink-strong') + '">' +
      (over
        ? '<button onclick="Takeoff.clearOrderQty(\'' + it.id + '\')" ' +
          'title="' + U.escAttr(calc == null ? 'Go back to the calculated quantity'
            : 'Go back to the calculated quantity (' + U.qty(calc) + ')') + '" ' +
          'class="ml-1 text-warn hover:text-warn-ink text-2xs"><i class="fas fa-undo"></i></button>'
        : '') +
      /* Only when the drawings have moved since the number was typed - not
         merely because a typed number differs from the calculation, which is
         what typing it meant. See M.orderQtyStale. */
      (stale
        ? '<button onclick="Takeoff.clearOrderQty(\'' + it.id + '\')" ' +
          'title="' + U.escAttr('This was typed when the drawings came to ' + U.qty(stale.was) +
            '. They now come to ' + U.qty(stale.computes) + '. Click to take the new figure, ' +
            'or leave the ' + U.qty(stale.typed) + ' where it is.') + '" ' +
          'class="block w-full text-3xs text-warn-ink text-right leading-tight hover:underline">' +
          'now computes ' + U.qty(stale.computes) + '</button>'
        : '') +
      (needsStockSize(it) && !over
        ? '<div class="text-3xs text-warn-ink text-right leading-tight">1 per assumed</div>' : '');
  }

  /* The arithmetic, spelled out, on the cell that shows the answer. An order
     quantity nobody can check is the thing this whole feature exists to end. */
  function orderExplain(it, req, order, perPack) {
    if (order == null) return 'Nothing measured or typed yet';
    if (it.qtyMode !== 'takeoff' && !(perPack > 0)) return 'Typed by hand';
    if (!(perPack > 0)) {
      return U.qty(req) + ' needed, rounded up to ' + U.qty(order) +
        '. No stock size given, so one item per unit is assumed.';
    }
    return U.qty(req) + ' ' + (it.packUm || '') + ' needed / ' + U.qty(perPack) + ' ' +
      (it.packUm || '') + ' per ' + (it.um || 'item') + ', rounded up = ' + U.qty(order);
  }

  function umInput(it, field, title) {
    return '<input list="umList" value="' + U.escAttr(it[field]) + '" ' +
      'onchange="Takeoff.setItem(\'' + it.id + '\',\'' + field + '\',this.value)" ' +
      'title="' + U.escAttr(title) + '" aria-label="' + U.escAttr(title) + '" ' +
      'class="w-16 px-1.5 py-1 bg-raised border border-line rounded text-xs text-center uppercase outline-none focus:border-brand">';
  }

  /* Which way round the vendor quoted it. $96.73 is either the price of a
     twenty-one foot stick or the price of a foot of pipe, and no amount of
     looking at the number will say which. */
  function costBasisChip(it, scope) {
    var perUnit = it.costBasis === 'unit';
    var measure = (scope && scope.um) || it.packUm || 'unit';
    return '<button onclick="Takeoff.toggleCostBasis(\'' + it.id + '\')" ' +
      'title="' + U.escAttr(perUnit
        ? 'Unit Cost is the price of one ' + measure + ' of material. Click to price by the item bought instead.'
        : 'Unit Cost is the price of one ' + (it.um || 'item') + ' as bought. Click to price per ' + measure + ' of material instead.') + '" ' +
      'class="mt-0.5 px-1 rounded text-3xs font-semibold ' +
      (perUnit ? 'bg-warn-soft text-warn-ink' : 'text-faint hover:text-ink') + '">per ' +
      U.esc(perUnit ? measure : (it.um || 'EA')) + '</button>';
  }

  /* The scope picker, which is also how a linked row is unlinked. */
  function scopeSelect(it, scopes, err) {
    var known = scopes.filter(function (s) { return s.key === it.scopeKey; })[0];
    return '<div class="flex items-center gap-1">' +
      '<i class="fas fa-link text-3xs ' + (known ? 'text-brand' : 'text-danger') + '" ' +
        'title="Measured off the Drawing Takeoff grid"></i>' +
      '<select onchange="Takeoff.setScope(\'' + it.id + '\',this.value)" ' +
        'class="flex-1 min-w-0 px-1 py-1 rounded text-xs outline-none focus:border-brand ' +
        (known ? 'bg-brand-soft/40 border border-brand/30' : 'bg-danger-soft border border-danger/40') + '">' +
        (known ? '' : '<option value="' + U.escAttr(it.scopeKey || '') + '" selected>' +
          U.esc(it.feature || 'scope removed') + '</option>') +
        scopes.map(function (s) {
          return '<option value="' + U.escAttr(s.key) + '"' + (s.key === it.scopeKey ? ' selected' : '') + '>' +
            U.esc(s.name) + '</option>';
        }).join('') +
        '<option value="__unlink">&mdash; unlink, type a name &mdash;</option>' +
      '</select></div>' +
      (err && !known
        ? '<div class="text-3xs text-danger mt-0.5 leading-tight">' + U.esc(err) +
          ' &mdash; pick another or unlink.</div>'
        : '');
  }

  /* A free-standing row: freight, a bag of washers, anything nobody draws. The
     chain button links it to a scope once the drawings have one. */
  function featureCell(it, scopes) {
    return '<div class="flex items-center gap-1">' +
      '<input value="' + U.escAttr(it.feature) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'feature\',this.value)" ' +
        'class="flex-1 min-w-0 px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand">' +
      (scopes.length
        ? '<button onclick="Takeoff.linkToScope(\'' + it.id + '\')" title="Measure this row off the Drawing Takeoff grid" ' +
          'class="text-3xs text-faint hover:text-brand shrink-0"><i class="fas fa-link"></i></button>'
        : '') +
      (it.qtyMode === 'formula'
        ? '<button onclick="Takeoff.toggleQtyMode(\'' + it.id + '\')" title="Switch back to a typed quantity" ' +
          'class="text-3xs px-1 rounded bg-ok text-white shrink-0">fx</button>'
        : '<button onclick="Takeoff.toggleQtyMode(\'' + it.id + '\')" title="Write the quantity as a formula over the drawing grid" ' +
          'class="text-3xs px-1 rounded text-faint hover:text-ok shrink-0">fx</button>') +
    '</div>';
  }

  /* Vendor Part No. The same combobox as the Description, plus a caret, because
     "click here and a list of every part appears" is not something a bare text
     box says about itself - and picking from that list is now the step that
     brings the stock size onto the row. */
  function partNoCell(it, ptype) {
    return '<td class="px-1 py-1 relative"><div class="flex items-stretch">' +
      '<input value="' + U.escAttr(it.partNo) + '" ' +
        'autocomplete="off" data-item="' + it.id + '" data-field="partNo" data-ptype="' + U.escAttr(ptype) + '" ' +
        'oninput="Takeoff.combo(this)" onfocus="Takeoff.combo(this)" onblur="Takeoff.comboBlur(this)" ' +
        'onkeydown="Takeoff.comboKey(event,this)" ' +
        'onchange="Takeoff.setItem(\'' + it.id + '\',\'partNo\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-raised border border-line rounded-l text-xs outline-none focus:border-brand">' +
      '<button onmousedown="event.preventDefault();Takeoff.openPartList(this)" ' +
        'title="Pick a part from the rate library" ' +
        'class="px-1 border border-l-0 border-line rounded-r bg-neutral-soft text-faint hover:text-brand text-3xs">' +
        '<i class="fas fa-caret-down"></i></button>' +
    '</div></td>';
  }

  function comboCell(it, field, w, ptype) {
    return '<td class="px-1 py-1 relative"><input value="' + U.escAttr(it[field]) + '" ' +
      'autocomplete="off" data-item="' + it.id + '" data-field="' + field + '" data-ptype="' + U.escAttr(ptype) + '" ' +
      'oninput="Takeoff.combo(this)" onfocus="Takeoff.combo(this)" onblur="Takeoff.comboBlur(this)" ' +
      'onkeydown="Takeoff.comboKey(event,this)" ' +
      'onchange="Takeoff.setItem(\'' + it.id + '\',\'' + field + '\',this.value)" ' +
      'class="' + w + ' px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand"></td>';
  }

  /* ---- combobox -------------------------------------------------------- */

  var comboBox = null, comboIndex = -1, comboHits = [];

  function combo(input) {
    var q = input.value;
    var ptype = input.getAttribute('data-ptype');
    /* An empty box on a row that was measured off the drawings still knows what
       it is looking for - the scope's name. Searching on that turns "click the
       caret and read three hundred parts" into "here are the ones called Top
       Rail", which is the point of naming a scope after the part. */
    if (!String(q).trim()) {
      var g = currentGroup();
      var it = g && g.items.filter(function (x) { return x.id === input.getAttribute('data-item'); })[0];
      if (it && it.feature) q = it.feature;
    }
    comboHits = root.Catalog.suggest(q, ptype, 8);
    if (!comboHits.length) { comboClose(); return; }
    comboIndex = -1;

    if (!comboBox) {
      comboBox = document.createElement('div');
      comboBox.className = 'fixed z-50 bg-surface border border-line-strong rounded-lg shadow-2xl overflow-hidden text-xs';
      comboBox.style.minWidth = '340px';
      comboBox.style.maxWidth = '520px';
      document.body.appendChild(comboBox);
    }
    var r = input.getBoundingClientRect();
    comboBox.style.left = Math.min(r.left, window.innerWidth - 540) + 'px';
    comboBox.style.top = (r.bottom + 2) + 'px';
    comboBox.innerHTML = comboHits.map(function (h, i) {
      var c = h.item;
      return '<div data-i="' + i + '" onmousedown="Takeoff.comboPick(event,' + i + ')" ' +
        'class="combo-row px-3 py-2 cursor-pointer border-b border-line last:border-0 hover:bg-brand-soft">' +
        '<div class="flex items-center gap-2">' +
          '<span class="font-semibold text-ink-strong truncate flex-1">' + U.esc(c.feature || c.description) + '</span>' +
          (c.unitCost != null ? '<span class="font-mono text-ink whitespace-nowrap">' + U.currency2(c.unitCost) + '</span>' : '') +
        '</div>' +
        '<div class="text-3xs text-muted truncate">' +
          U.esc(c.vendor) + (c.partNo ? ' &middot; ' + U.esc(c.partNo) : '') + ' &middot; ' + U.esc(c.um) +
          // The stock size, where the library knows one - it is half of what
          // picking a part is for now, so it shows before you pick.
          (U.n(c.packQty) > 0
            ? ' &middot; <span class="text-warn-ink font-semibold">' + U.qty(c.packQty) + ' ' +
              U.esc(c.packUm || '') + '/' + U.esc(c.um || 'EA') + '</span>'
            : ' &middot; <span class="text-faint">no stock size</span>') +
          (h.onType ? ' <span class="text-brand font-semibold">&middot; used here</span>' : '') +
          (c.source === 'learned' ? ' <span class="text-ok">&middot; learned</span>' : '') +
        '</div>' +
        '<div class="text-3xs text-faint truncate">' + U.esc(c.description) + '</div></div>';
    }).join('');
    comboBox.dataset.item = input.getAttribute('data-item');
  }

  function comboClose() {
    if (comboBox) { comboBox.remove(); comboBox = null; }
    comboIndex = -1; comboHits = [];
  }

  function comboBlur() { setTimeout(comboClose, 120); }

  function comboKey(e, input) {
    if (!comboBox || !comboHits.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      comboIndex += e.key === 'ArrowDown' ? 1 : -1;
      if (comboIndex < 0) comboIndex = comboHits.length - 1;
      if (comboIndex >= comboHits.length) comboIndex = 0;
      Array.prototype.forEach.call(comboBox.querySelectorAll('.combo-row'), function (el, i) {
        el.classList.toggle('bg-brand-soft', i === comboIndex);
      });
    } else if (e.key === 'Enter' && comboIndex >= 0) {
      e.preventDefault();
      applyCatalogItem(input.getAttribute('data-item'), comboHits[comboIndex].item.id);
      comboClose();
    } else if (e.key === 'Escape') {
      comboClose();
    }
  }

  function comboPick(e, i) {
    e.preventDefault();
    var itemId = comboBox.dataset.item;
    var catId = comboHits[i].item.id;
    comboClose();
    applyCatalogItem(itemId, catId);
  }

  /* ---- cost & labour --------------------------------------------------- */

  function renderCost(p, c) {
    var lfLabel = p.unit === 'EA' ? 'Total Qty' : 'Total linear feet';

    return '<div class="mb-5 flex flex-wrap items-end gap-4">' +
      '<div><label class="block text-3xs font-semibold text-muted uppercase tracking-wider mb-1">' + lfLabel + '</label>' +
        '<input type="number" step="any" value="' + (p.totalLF == null ? '' : p.totalLF) + '" ' +
        'onchange="Takeoff.setTotalLF(this.value)" class="w-36 px-3 py-2 bg-surface border-2 border-brand/40 rounded-lg text-sm text-right font-mono font-bold outline-none focus:border-brand"></div>' +
      '<div><label class="block text-3xs font-semibold text-muted uppercase tracking-wider mb-1">Material</label>' +
        '<input value="' + U.escAttr(p.material) + '" onchange="Takeoff.setProductField(\'material\',this.value)" class="w-44 px-3 py-2 bg-raised border border-line rounded-lg text-sm outline-none focus:border-brand"></div>' +
      '<button onclick="Takeoff.resetAllOverrides()" class="px-3 py-2 text-xs text-muted hover:text-brand-ink underline">Reset all to formula</button>' +
      '</div>' +
      hiddenRowsBar(p) +
      '<div class="overflow-x-auto border border-line rounded-lg"><table class="w-full text-xs grid-table">' +
      '<thead><tr>' +
        '<th class="px-2 py-2 w-8 text-center font-semibold text-muted" title="Show this line on the bid proposal">' +
          '<i class="fas fa-file-contract text-3xs"></i></th>' +
        ['Description', 'Qty', 'U/M', 'Unit Price', 'Total'].map(function (h, i) {
          return '<th class="px-3 py-2 ' + (i >= 1 ? 'text-right' : 'text-left') +
            ' font-semibold text-muted uppercase text-3xs tracking-wider">' + h + '</th>';
        }).join('') +
        '<th class="px-2 py-2 w-16"></th></tr></thead><tbody>' +
      M.COST_ROWS.filter(function (def) { return !M.isRowHidden(p, def.id); })
        .map(function (def) { return costRow(p, def, c); }).join('') +
      // An extra fills the same five columns as the rows above it. It used to
      // span three of them with one amount box, which made "two lifts at
      // $1,000" a bare 2000 with the reasoning lost. Qty x Unit Price is the
      // line total when both are given; an amount on its own still works, which
      // is what keeps every charge already in the database valid.
      (p.extras || []).map(function (e, i) {
        var priced = e.qty !== null && e.qty !== undefined && e.qty !== '' &&
                     e.unitPrice !== null && e.unitPrice !== undefined && e.unitPrice !== '';
        function box(fieldName, value, cls) {
          return '<input type="number" step="any" value="' + (value == null ? '' : value) + '" ' +
            'onchange="Takeoff.setExtra(' + i + ',\'' + fieldName + '\',this.value)" ' +
            'class="' + cls + ' px-1.5 py-1 bg-surface border border-warn/30 rounded text-xs ' +
            'text-right font-mono outline-none focus:border-warn">';
        }
        return '<tr class="bg-warn-soft/40">' +
          '<td class="px-2 py-1.5 text-center">' + proposalCheckbox(
            'Takeoff.setExtra(' + i + ',\'showInProposal\',this.checked)',
            e.showInProposal !== false, false) + '</td>' +
          '<td class="px-3 py-1.5"><input value="' + U.escAttr(e.label) + '" ' +
            'onchange="Takeoff.setExtra(' + i + ',\'label\',this.value)" ' +
            'class="w-full px-1.5 py-1 bg-surface border border-warn/30 rounded text-xs outline-none focus:border-warn"></td>' +
          '<td class="px-3 py-1.5 text-right">' + box('qty', e.qty, 'w-24') + '</td>' +
          '<td class="px-2 py-1.5"><input value="' + U.escAttr(e.um || '') + '" ' +
            'onchange="Takeoff.setExtra(' + i + ',\'um\',this.value)" placeholder="EA" ' +
            'aria-label="Unit" class="w-16 px-1.5 py-1 bg-surface border border-warn/30 rounded ' +
            'text-xs text-center outline-none focus:border-warn"></td>' +
          // Unit price when the line is a rate x quantity; otherwise this is the
          // flat amount, and the placeholder says which one it is being used as.
          '<td class="px-3 py-1.5 text-right">' +
            box(priced || e.amount == null ? 'unitPrice' : 'amount',
                priced || e.amount == null ? e.unitPrice : e.amount, 'w-24') + '</td>' +
          '<td class="px-3 py-1.5 text-right font-mono text-ink-strong">' +
            U.currency2(M.extraAmount(e)) + '</td>' +
          '<td class="px-2 text-center"><button onclick="Takeoff.removeExtra(' + i + ')" class="text-faint hover:text-danger text-3xs" title="Delete this charge"><i class="fas fa-times"></i></button></td></tr>';
      }).join('') +
      '<tr class="border-t-2 border-line-strong bg-raised"><td></td><td class="px-3 py-2.5 font-bold text-ink">Material + Engg + Fab + Install Cost</td>' +
        '<td colspan="3" class="px-3 py-2.5 text-right text-3xs text-muted">Material ' + U.currency2(c.materialCost) + '</td>' +
        '<td class="px-3 py-2.5 text-right font-mono font-bold text-ink-strong">' + U.currency2(c.subtotal) + '</td><td></td></tr>' +
      pctRow('Overall Mark ups + Margine', 'markupPct', p.markupPct, c.markup) +
      pctRow('Overhead &amp; Profit', 'overheadPct', p.overheadPct, c.overhead) +
      '<tr class="border-t-2 border-line-strong bg-neutral-soft"><td></td><td class="px-3 py-3 font-bold text-ink-strong uppercase tracking-wider">Total Cost</td>' +
        '<td colspan="3"></td><td class="px-3 py-3 text-right font-mono text-base font-bold text-ink-strong">' + U.currency2(c.total) + '</td><td></td></tr>' +
      '</tbody></table></div>' +
      '<button onclick="Takeoff.addExtra()" class="mt-3 px-4 py-2 bg-warn-soft hover:bg-warn-soft/60 text-warn-ink border border-warn/30 rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add other charge</button>' +
      '<div class="mt-3 text-2xs text-faint space-y-1">' +
        '<p><i class="fas fa-file-contract mr-1"></i>The tick box controls whether a line is <em>described</em> on the bid ' +
        'proposal. Unticking never changes the price &mdash; use <i class="fas fa-times"></i> to take a line out of the cost.</p>' +
        '<p>Amber fields have been typed over and no longer follow the formula. ' +
        'Use <i class="fas fa-undo"></i> to put one back, or <em>Reset all to formula</em> above.</p>' +
      '</div>';
  }

  /* Restore strip, only present once something has been removed. */
  function hiddenRowsBar(p) {
    var hidden = M.COST_ROWS.filter(function (d) { return M.isRowHidden(p, d.id); });
    if (!hidden.length) return '';
    return '<div class="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 bg-neutral-soft border border-line rounded-lg">' +
      '<span class="text-2xs font-semibold text-muted uppercase tracking-wider">' +
        hidden.length + ' row' + (hidden.length > 1 ? 's' : '') + ' removed</span>' +
      hidden.map(function (d) {
        return '<button onclick="Takeoff.restoreRow(\'' + d.id + '\')" ' +
          'class="px-2 py-1 bg-surface border border-line-strong rounded text-2xs text-ink hover:border-brand hover:text-brand-ink" ' +
          'title="Put this row back with its values">' +
          '<i class="fas fa-rotate-left mr-1 text-3xs"></i>' + U.esc(M.rowLabel(p, d.id)) + '</button>';
      }).join('') + '</div>';
  }

  function proposalCheckbox(onchange, checked, disabled) {
    return '<input type="checkbox" ' + (checked ? 'checked ' : '') + (disabled ? 'disabled ' : '') +
      'onchange="' + onchange + '" class="cursor-pointer" ' +
      'title="Show this line on the bid proposal">';
  }

  /* The description cell. Finish is the exception: its "Finish - " prefix is
     rendered as static text outside the input, so it cannot be selected,
     deleted or typed over - only added to. The input holds the rest. */
  function labelCell(p, def, label, labelChanged) {
    if (def.id === 'finish') {
      var suffix = p.finish && p.finish.label ? p.finish.label : '';
      return '<div class="flex items-stretch rounded border border-transparent hover:border-line focus-within:border-brand overflow-hidden">' +
        '<span class="px-1.5 py-1 bg-neutral-soft text-muted text-xs font-semibold whitespace-nowrap select-none border-r border-line" ' +
          'title="Every product\'s finish line starts this way and cannot be changed">' +
          U.esc(M.FINISH_PREFIX.trim()) + '</span>' +
        '<input value="' + U.escAttr(suffix) + '" onchange="Takeoff.setRowLabel(\'finish\',this.value)" ' +
          'placeholder="Painted / Powder coated / Hot Dip Galvanized..." ' +
          'title="Describe the finish - the prefix is fixed" ' +
          'class="flex-1 min-w-0 px-1.5 py-1 bg-transparent text-xs outline-none border-0">' +
      '</div>';
    }
    return '<div class="flex items-center gap-1">' +
      '<input value="' + U.escAttr(label) + '" onchange="Takeoff.setRowLabel(\'' + def.id + '\',this.value)" ' +
        'title="' + (labelChanged ? 'Renamed from &quot;' + U.escAttr(M.defaultRowLabel(p, def.id)) + '&quot;' : 'Click to rename this line') + '" ' +
        'class="flex-1 min-w-0 px-1.5 py-1 border rounded text-xs outline-none focus:border-brand ' +
        (labelChanged ? 'bg-warn-soft border-warn/40 text-warn-ink' : 'bg-transparent border-transparent hover:border-line') + '">' +
      (labelChanged
        ? '<button onclick="Takeoff.resetRowLabel(\'' + def.id + '\')" title="Restore the default description" ' +
          'class="text-warn hover:text-warn-ink text-2xs shrink-0"><i class="fas fa-undo"></i></button>'
        : '') +
    '</div>';
  }

  function costRow(p, def, c) {
    var qtyPath = def.qtyPath, ratePath = def.ratePath;
    var qty = M.pathGet(p, qtyPath);
    var rate = M.pathGet(p, ratePath);
    var um = M.rowUnit(p, def.id);
    var unitChanged = um !== M.defaultRowUnit(p, def.id);
    var total = c[def.totalKey];
    var derived = def.derived;
    var overridden = derived && !!p.overrides[qtyPath];
    var formulaVal = derived ? M.derivedValue(p, qtyPath, takeoff()) : null;

    var label = M.rowLabel(p, def.id);
    var labelChanged = label !== M.defaultRowLabel(p, def.id);
    var confirming = pendingDelete === def.id;

    return '<tr class="' + (confirming ? 'bg-warn-soft' : 'hover:bg-raised/50') + '">' +
      '<td class="px-2 py-1.5 text-center">' + proposalCheckbox(
        'Takeoff.setRowOnProposal(\'' + def.id + '\',this.checked)',
        M.isRowOnProposal(p, def.id), false) + '</td>' +
      '<td class="px-3 py-1.5">' + labelCell(p, def, label, labelChanged) + '</td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="any" value="' + (qty == null ? '' : qty) + '" ' +
        'onchange="Takeoff.setCost(\'' + qtyPath + '\',this.value)" ' +
        'class="w-24 px-1.5 py-1 border rounded text-xs text-right font-mono outline-none focus:border-brand ' +
        (overridden ? 'bg-warn-soft border-warn/40 text-warn-ink' : 'bg-raised border-line') + '"' +
        (derived && formulaVal != null ? ' title="Formula value: ' + U.qty(formulaVal) + '"' : '') + '></td>' +
      // The unit is typed, not fixed: supervision is sometimes quoted by the
      // week and a truck by the load. Only the exceptions are stored - see
      // M.rowUnit - so a row left alone keeps showing its default.
      '<td class="px-2 py-1.5"><input value="' + U.escAttr(um) + '" ' +
        'onchange="Takeoff.setRowUnit(\'' + def.id + '\',this.value)" ' +
        'title="Unit this line is billed in" aria-label="Unit for ' + U.escAttr(label) + '" ' +
        'class="w-16 px-1.5 py-1 border rounded text-xs text-center outline-none focus:border-brand ' +
        (unitChanged ? 'bg-warn-soft border-warn/40 text-warn-ink' : 'bg-raised border-line text-muted') +
        '"></td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="any" value="' + (rate == null ? '' : rate) + '" ' +
        'onchange="Takeoff.setCost(\'' + ratePath + '\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand"></td>' +
      '<td class="px-3 py-1.5 text-right font-mono text-ink-strong">' + U.currency2(total) + '</td>' +
      '<td class="px-2 py-1.5 text-center whitespace-nowrap">' +
        (overridden
          ? '<button onclick="Takeoff.clearOverride(\'' + qtyPath + '\')" title="Restore the formula value (' + U.qty(formulaVal) + ')" class="text-warn hover:text-warn-ink text-2xs mr-1"><i class="fas fa-undo"></i></button>'
          : '') +
        // Step one of two: an inline confirm, so a stray click on a small icon
        // cannot pull a line out of the estimate.
        (confirming
          ? '<span class="inline-flex items-center gap-1">' +
              '<button onclick="Takeoff.confirmRemoveRow(\'' + def.id + '\')" class="px-1.5 py-0.5 bg-danger hover:bg-danger-hover text-white rounded text-3xs font-semibold">Remove?</button>' +
              '<button onclick="Takeoff.cancelRemoveRow()" class="px-1 text-faint hover:text-ink text-3xs">Cancel</button>' +
            '</span>'
          : '<button onclick="Takeoff.askRemoveRow(\'' + def.id + '\')" title="Remove this line from the cost" class="text-faint hover:text-danger text-2xs"><i class="fas fa-times"></i></button>') +
      '</td></tr>';
  }

  function pctRow(label, field, value, total) {
    return '<tr><td></td><td class="px-3 py-1.5 text-ink">' + label + '</td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="0.1" value="' + (value == null ? '' : value) + '" ' +
        'onchange="Takeoff.setProductNum(\'' + field + '\',this.value)" class="w-20 px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand"></td>' +
      '<td class="px-3 py-1.5 text-right text-muted">%</td><td></td>' +
      '<td class="px-3 py-1.5 text-right font-mono text-ink-strong">' + U.currency2(total) + '</td><td></td></tr>';
  }

  /* ---- documents ------------------------------------------------------- *
   *
   * Links to the drawings, not copies of them. See TakeoffModel.documents for
   * why. One list for the whole takeoff, so a drawing reference on any product
   * resolves through the same star.
   */
  function renderDocuments(t) {
    var docs = M.documents(t);

    var rows = docs.map(function (d) {
      var url = U.safeUrl(d.url);
      var isDrawing = t.drawingDocId === d.id;
      var refs = M.docRefCount(t, d.id);
      return '<tr class="border-t border-line align-middle hover:bg-raised/60">' +
        // The star is what "all the drawing refs point here" is made of, so it
        // is the first thing on the row rather than an action at the end.
        '<td class="px-2 py-2 w-8 text-center">' +
          '<button onclick="Takeoff.setDrawingDoc(\'' + d.id + '\')" ' +
            'title="' + U.escAttr(isDrawing
              ? 'Every drawing reference opens this unless it says otherwise'
              : 'Make this what the drawing references open') + '" ' +
            'class="text-sm ' + (isDrawing ? 'text-warn' : 'text-faint hover:text-warn') + '">' +
            '<i class="fa' + (isDrawing ? 's' : 'r') + ' fa-star"></i></button></td>' +
        '<td class="px-2 py-2 min-w-[180px]">' +
          '<input value="' + U.escAttr(d.name) + '" onchange="Takeoff.setDoc(\'' + d.id + '\',\'name\',this.value)" ' +
            'placeholder="Untitled document" ' +
            'class="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-line focus:border-brand rounded text-xs font-semibold text-ink-strong outline-none"></td>' +
        '<td class="px-2 py-2">' +
          '<select onchange="Takeoff.setDoc(\'' + d.id + '\',\'category\',this.value)" ' +
            'class="px-1.5 py-1 bg-raised border border-line rounded text-2xs outline-none focus:border-brand">' +
            M.DOC_CATEGORIES.map(function (c) {
              return '<option' + (c === d.category ? ' selected' : '') + '>' + U.esc(c) + '</option>';
            }).join('') + '</select></td>' +
        '<td class="px-2 py-2 max-w-[300px]">' +
          '<input value="' + U.escAttr(d.url) + '" onchange="Takeoff.setDoc(\'' + d.id + '\',\'url\',this.value)" ' +
            'placeholder="https://..." spellcheck="false" ' +
            'class="w-full px-1.5 py-1 rounded text-2xs font-mono outline-none focus:border-brand ' +
            (url ? 'bg-raised border border-line' : 'bg-danger-soft border border-danger/40 text-danger-ink') + '">' +
          (url || !d.url ? '' : '<div class="text-3xs text-danger mt-0.5">' + badLinkNote() + '</div>') +
        '</td>' +
        '<td class="px-2 py-2 text-center whitespace-nowrap">' +
          (refs
            ? '<span class="text-2xs text-muted font-mono" title="Drawing references that open this">' +
              refs + ' ref' + (refs > 1 ? 's' : '') + '</span>'
            : '<span class="text-2xs text-faint">&mdash;</span>') + '</td>' +
        '<td class="px-2 py-2 text-right whitespace-nowrap">' +
          (url
            ? '<a href="' + U.escAttr(url) + '" target="_blank" rel="noopener noreferrer" ' +
              'class="px-2 py-1 bg-brand hover:bg-brand-hover text-white rounded text-2xs font-semibold">' +
              'Open <i class="fas fa-external-link-alt ml-0.5"></i></a>'
            : '<span class="px-2 py-1 bg-neutral-soft text-faint rounded text-2xs">No link</span>') +
          '<button onclick="Takeoff.removeDoc(\'' + d.id + '\')" title="Remove this document" ' +
            'class="ml-2 text-faint hover:text-danger text-2xs"><i class="fas fa-times"></i></button></td>' +
      '</tr>';
    }).join('');

    return '<div class="flex flex-wrap items-baseline gap-2 mb-4">' +
        '<h3 class="text-sm font-bold text-ink-strong">Documents</h3>' +
        '<span class="text-2xs text-muted">shared by every product in this takeoff</span>' +
      '</div>' +
      (docs.length
        ? '<div class="overflow-x-auto border border-line rounded-lg"><table class="w-full text-xs grid-table">' +
          '<thead><tr>' +
            ['', 'Name', 'Category', 'Link', 'Used by', ''].map(function (h, i) {
              return '<th class="px-2 py-2 ' + (i === 4 ? 'text-center' : i === 5 ? 'text-right' : 'text-left') +
                ' font-semibold text-muted uppercase text-3xs tracking-wider whitespace-nowrap">' + h + '</th>';
            }).join('') +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="border border-dashed border-line-strong rounded-lg py-10 text-center">' +
          '<i class="fas fa-folder-open text-3xl text-chrome-ink mb-3"></i>' +
          '<p class="text-sm text-muted max-w-md mx-auto">Nothing filed yet. Paste the OneDrive link to the ' +
          'drawing set below &mdash; every <strong>Drawing Ref. No</strong> on the Drawing Takeoff tab ' +
          'becomes a link straight to it.</p></div>') +

      '<div class="mt-4 p-3 bg-raised border border-line rounded-lg">' +
        '<div class="flex flex-wrap items-end gap-2">' +
          '<div class="flex-1 min-w-[160px]">' +
            '<label class="block text-3xs font-semibold text-muted uppercase tracking-wider mb-1" for="docName">Name</label>' +
            '<input id="docName" placeholder="Filcore Shell - Drawings.pdf" ' +
              'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-xs outline-none focus:border-brand"></div>' +
          '<div class="flex-[2] min-w-[220px]">' +
            '<label class="block text-3xs font-semibold text-muted uppercase tracking-wider mb-1" for="docUrl">OneDrive link</label>' +
            '<input id="docUrl" placeholder="https://..." spellcheck="false" ' +
              'onkeydown="if(event.key===\'Enter\')Takeoff.addDoc()" ' +
              'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-xs font-mono outline-none focus:border-brand"></div>' +
          '<div><label class="block text-3xs font-semibold text-muted uppercase tracking-wider mb-1" for="docCat">Category</label>' +
            '<select id="docCat" class="px-2 py-1.5 bg-surface border border-line rounded text-xs outline-none focus:border-brand">' +
            M.DOC_CATEGORIES.map(function (c) { return '<option>' + U.esc(c) + '</option>'; }).join('') +
            '</select></div>' +
          '<button onclick="Takeoff.addDoc()" class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold">' +
            '<i class="fas fa-plus mr-1"></i>Add</button>' +
        '</div>' +
      '</div>' +
      '<div class="mt-3 text-2xs text-faint space-y-1">' +
        '<p><i class="fas fa-star mr-1"></i>The starred document is what every <strong>Drawing Ref. No</strong> ' +
        'opens. A single reference can be pointed somewhere else from the chain icon beside it.</p>' +
        '<p>Links are stored, not files &mdash; the drawings stay in OneDrive, where whoever issues them keeps them current.</p>' +
      '</div>';
  }

  /* THE DRAWING REFERENCE, AS A LINK.
   *
   * "2/A-101" names a sheet that lives in OneDrive, and the whole cost of
   * using it was leaving the app to go and find that sheet - every reference,
   * every time.
   *
   * The chain is one button and no column: rows following the drawing set look
   * identical to each other, and only a row deliberately pointed elsewhere
   * carries a mark. The caret that changes it appears on hover, so the common
   * case - which is every row - shows nothing to decide about.
   */
  function refLink(row, ri) {
    var t = takeoff();
    var doc = M.docForRow(t, row);
    var url = doc ? U.safeUrl(doc.url) : null;
    var custom = !!(row.docId && doc);

    var open = url
      ? '<a href="' + U.escAttr(url) + '" target="_blank" rel="noopener noreferrer" ' +
        'title="' + U.escAttr('Open ' + (doc.name || 'this document') +
          (custom ? ' - this reference only' : '') + ' in a new tab') + '" ' +
        'class="relative text-brand hover:text-brand-ink text-xs">' +
        '<i class="fas fa-file-lines"></i>' +
        // A row that has been pointed somewhere other than the drawing set says
        // so without needing to be opened to find out.
        (custom ? '<span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warn"></span>' : '') +
        '</a>'
      : '<button onclick="Takeoff.setTab(\'docs\')" ' +
        'title="' + U.escAttr(doc
          ? 'This document has no usable link - open Documents to fix it'
          : M.documents(t).length
            ? 'No drawing set chosen yet - open Documents and star one'
            : 'No documents filed yet - open Documents to add the drawing set') + '" ' +
        'class="text-faint hover:text-brand text-xs"><i class="far fa-file"></i></button>';

    return open +
      '<button onmousedown="event.preventDefault();Takeoff.refMenu(this,' + ri + ')" ' +
        'title="Point this reference at a different document" ' +
        'class="opacity-0 group-hover/ref:opacity-100 focus:opacity-100 transition text-3xs text-faint hover:text-ink">' +
        '<i class="fas fa-caret-down"></i></button>';
  }

  /* The picker, built the way the part-number combobox is: fixed, on the body,
     positioned off the button. It cannot be an absolutely-positioned child
     like the product menus are - the drawing grid lives inside overflow-x-auto,
     which would clip it to the width of the cell. */
  var refBox = null;

  function refMenuClose() {
    if (refBox) { refBox.remove(); refBox = null; }
  }

  function refMenu(btn, ri) {
    refMenuClose();
    var t = takeoff();
    var docs = M.documents(t);
    var row = currentGroup().grid.rows[ri];

    function line(onclick, icon, label, sub, active) {
      return '<button onmousedown="event.preventDefault();' + onclick + '" ' +
        'class="w-full text-left px-3 py-2 hover:bg-brand-soft border-b border-line last:border-0 ' +
        (active ? 'bg-brand-soft/50' : '') + '">' +
        '<div class="flex items-center gap-2">' +
          '<i class="fas ' + icon + ' w-3.5 text-faint text-3xs"></i>' +
          '<span class="flex-1 truncate text-ink-strong">' + label + '</span>' +
          (active ? '<i class="fas fa-check text-brand text-3xs"></i>' : '') +
        '</div>' +
        (sub ? '<div class="text-3xs text-muted truncate pl-5">' + sub + '</div>' : '') +
        '</button>';
    }

    var html = docs.length
      ? line('Takeoff.setRowDoc(' + ri + ',\'\')', 'fa-star',
          'Use the drawing set', defaultDocName(t), !row.docId) +
        docs.map(function (d) {
          return line('Takeoff.setRowDoc(' + ri + ',\'' + d.id + '\')', 'fa-file-lines',
            U.esc(d.name || 'Untitled'), U.esc(d.category), row.docId === d.id);
        }).join('') +
        line('Takeoff.linkAllRefs(\'' + (row.docId || '') + '\')', 'fa-link',
          'Point every reference here', 'All ' + currentGroup().grid.rows.length +
          ' row(s) in this grid', false) +
        line('Takeoff.setTab(\'docs\')', 'fa-folder-open', 'Manage documents&hellip;', '', false)
      : line('Takeoff.setTab(\'docs\')', 'fa-folder-open', 'Add a document&hellip;',
          'Nothing filed for this takeoff yet', false);

    refBox = document.createElement('div');
    refBox.id = 'refDocMenu';
    refBox.className = 'fixed z-50 bg-surface border border-line-strong rounded-lg shadow-2xl overflow-hidden text-xs';
    refBox.style.width = '260px';
    refBox.innerHTML = html;
    document.body.appendChild(refBox);

    var r = btn.getBoundingClientRect();
    refBox.style.left = Math.min(r.left, window.innerWidth - 272) + 'px';
    // Flip above the button when there is not room below it.
    var h = refBox.offsetHeight;
    refBox.style.top = (r.bottom + h > window.innerHeight ? Math.max(4, r.top - h - 2) : r.bottom + 2) + 'px';
  }

  function defaultDocName(t) {
    var d = M.findDocument(t, t.drawingDocId);
    return d ? U.esc(d.name || 'Untitled') : '<span class="text-warn-ink">none starred yet</span>';
  }

  function badLinkNote() {
    return '<i class="fas fa-triangle-exclamation mr-1"></i>Not a web link &mdash; it has to start with ' +
      '<code>https://</code>. Nothing will open until it does.';
  }

  /* ---- drawing grid ---------------------------------------------------- */

  function renderGrid(p) {
    var g = currentGroup();
    var subs = M.gridSubtotals(g);
    var groupTabs = p.groups.map(function (gr) {
      var on = gr.id === g.id;
      return '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + gr.id + '\')" class="px-3 py-1.5 rounded-lg text-xs font-medium ' +
        (on ? 'bg-chrome text-white' : 'bg-neutral-soft text-muted hover:bg-line') + '">' + U.esc(gr.name) + '</button>';
    }).join('');

    var cols = g.grid.columns;
    var scopes = M.productScopes(p);
    function scopeFor(col) {
      var k = M.scopeKey(col.label);
      return scopes.filter(function (s) { return s.key === k; })[0] || null;
    }

    return '<div class="flex flex-wrap items-center gap-2 mb-4">' + groupTabs + '</div>' +
      scopeStrip(p, scopes) +
      '<div class="overflow-x-auto border border-line rounded-lg"><table class="w-full text-xs grid-table">' +
      '<thead><tr>' +
        '<th class="px-2 py-2 text-left font-semibold text-muted uppercase text-3xs tracking-wider sticky left-0 bg-raised">Drawing Ref. No</th>' +
        // Column headings carry long labels like 'Top Rail_1-1/2" Pipe'. They
        // used to be nowrap in a 110px cell, so they ran over their neighbours;
        // now they wrap and the delete only appears on hover. The unit moved
        // out of the label into a box of its own - see the note on
        // Store.splitColumnUnit.
        cols.map(function (col) {
          var s = scopeFor(col);
          var shared = s && s.columns.length > 1;
          return '<th class="group px-2 py-2 align-bottom text-right font-semibold text-muted text-3xs min-w-[150px]">' +
            '<div class="flex items-start gap-1">' +
              '<textarea rows="2" onchange="Takeoff.setColLabel(\'' + col.key + '\',this.value)" ' +
                'title="' + U.escAttr(col.label) + '" ' +
                'class="flex-1 min-w-0 px-1 py-0.5 bg-transparent border-b border-transparent hover:border-line-strong focus:border-brand ' +
                'text-right text-3xs font-semibold outline-none resize-none leading-tight">' +
                U.esc(col.label) + '</textarea>' +
              '<button onclick="Takeoff.removeCol(\'' + col.key + '\')" title="Delete this column" ' +
                'class="opacity-0 group-hover:opacity-100 transition text-3xs text-faint hover:text-danger shrink-0">' +
                '<i class="fas fa-times"></i></button>' +
            '</div>' +
            '<div class="flex items-center justify-end gap-1 mt-1">' +
              (shared
                ? '<span class="text-3xs text-brand font-semibold" title="' +
                  U.escAttr('Also measured in ' + (s.columns.length - 1) + ' other column(s) of ' +
                    p.type + '. They total as one scope.') + '">' +
                  '<i class="fas fa-link"></i> &times;' + s.columns.length + '</span>'
                : '') +
              '<input list="umList" value="' + U.escAttr(col.um || '') + '" ' +
                'onchange="Takeoff.setColUnit(\'' + col.key + '\',this.value)" ' +
                'title="What this column is measured in" aria-label="Unit for ' + U.escAttr(col.label) + '" ' +
                'class="w-12 px-1 py-0.5 bg-raised border border-line rounded text-3xs text-center uppercase outline-none focus:border-brand">' +
            '</div></th>';
        }).join('') +
        '<th class="px-2 py-2 w-8"><button onclick="Takeoff.addCol()" class="text-faint hover:text-brand" title="Add column"><i class="fas fa-plus"></i></button></th>' +
      '</tr></thead><tbody>' +
      (g.grid.rows.length ? g.grid.rows.map(function (row, ri) {
        return '<tr class="border-t border-line hover:bg-raised/60">' +
          '<td class="px-2 py-1 sticky left-0 bg-surface"><div class="group/ref flex items-center gap-1">' +
            '<input value="' + U.escAttr(row.ref) + '" onchange="Takeoff.setRowRef(' + ri + ',this.value)" ' +
              'placeholder="2/A-101" class="w-28 px-1.5 py-1 bg-raised border border-line rounded text-xs outline-none focus:border-brand">' +
            refLink(row, ri) +
          '</div></td>' +
          cols.map(function (col) {
            return '<td class="px-1 py-1"><input type="number" step="any" value="' + (row.values[col.key] == null ? '' : row.values[col.key]) + '" ' +
              'onchange="Takeoff.setCellValue(' + ri + ',\'' + col.key + '\',this.value)" ' +
              'class="w-full px-1.5 py-1 bg-raised border border-line rounded text-xs text-right font-mono outline-none focus:border-brand"></td>';
          }).join('') +
          '<td class="px-1"><button onclick="Takeoff.removeRow(' + ri + ')" class="text-faint hover:text-danger text-3xs"><i class="fas fa-times"></i></button></td></tr>';
      }).join('') : '<tr><td colspan="' + (cols.length + 2) + '" class="px-3 py-8 text-center text-faint">No drawing references yet.</td></tr>') +
      '</tbody><tfoot class="bg-raised border-t-2 border-line-strong"><tr>' +
        '<td class="px-2 py-2.5 font-bold text-ink uppercase text-3xs tracking-wider sticky left-0 bg-raised">Sub Total</td>' +
        /* Two figures where a scope is measured in more than one group: this
           group's own subtotal, and the product-wide total the material row is
           actually ordering against. Showing only the first was how a scope
           split across two groups came to be bought twice. */
        cols.map(function (col) {
          var s = scopeFor(col);
          var shared = s && s.columns.length > 1;
          return '<td class="px-2 py-2.5 text-right">' +
            '<div class="font-mono font-bold text-ink-strong">' + U.qty(subs[col.key]) +
              (col.um ? ' <span class="text-3xs font-normal text-muted">' + U.esc(col.um) + '</span>' : '') + '</div>' +
            (shared
              ? '<div class="text-3xs text-brand font-mono" title="' +
                U.escAttr('Total for "' + s.name + '" across every group of ' + p.type) + '">' +
                'scope ' + U.qty(s.total) + '</div>'
              : '') +
          '</td>';
        }).join('') + '<td></td></tr></tfoot></table></div>' +
      umDatalist() +
      '<button onclick="Takeoff.addRow()" class="mt-3 px-4 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add drawing reference</button>' +
      '<div class="mt-3 text-2xs text-faint space-y-1">' +
        '<p>Every column with a quantity in it becomes a row on the <strong>Materials</strong> tab under its own name. ' +
        'Two columns with the same name are one scope and total together, wherever they are in this product.</p>' +
        '<p>For a quantity that is not a straight column total, switch a material row to ' +
        '<code class="bg-neutral-soft px-1 rounded">fx</code> and write it out with ' +
        '<code class="bg-neutral-soft px-1 rounded">TK("column name")</code>.</p>' +
      '</div>';
  }

  /* What has been measured, and whether anything is being bought for it. The
     drawing grid is where a scope is created, so it is where the consequence of
     creating one belongs - rather than the estimator having to switch tabs to
     find out whether the row appeared. */
  function scopeStrip(p, scopes) {
    if (!scopes.length) return '';
    var linked = {};
    p.groups.forEach(function (g) {
      g.items.forEach(function (it) { if (it.scopeKey) linked[it.scopeKey] = true; });
    });
    var gaps = scopes.filter(function (s) { return s.total && !linked[s.key]; }).length;

    return '<div class="mb-3 px-3 py-2 bg-neutral-soft border border-line rounded-lg">' +
      '<div class="flex items-center gap-2 mb-1.5">' +
        '<span class="text-3xs font-bold text-muted uppercase tracking-wider">Scopes measured on ' + U.esc(p.type) + '</span>' +
        '<span class="flex-1"></span>' +
        (gaps
          ? '<button onclick="Takeoff.addRowsForScopes()" class="px-2 py-0.5 bg-brand hover:bg-brand-hover text-white rounded text-3xs font-semibold">' +
            'Add ' + gaps + ' material row' + (gaps > 1 ? 's' : '') + '</button>'
          : '<span class="text-3xs text-ok-ink"><i class="fas fa-check-circle mr-1"></i>all on the Materials tab</span>') +
      '</div>' +
      '<div class="flex flex-wrap gap-1.5">' + scopes.map(function (s) {
        var on = linked[s.key];
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-3xs font-medium ' +
          (on ? 'bg-brand-soft text-brand-ink' : s.total ? 'bg-warn-soft text-warn-ink' : 'bg-surface text-faint') + '" ' +
          'title="' + U.escAttr(on ? 'A material row is measured by this scope'
            : s.total ? 'Measured, but nothing is being bought for it' : 'No quantities entered yet') + '">' +
          '<i class="fas ' + (on ? 'fa-link' : s.total ? 'fa-unlink' : 'fa-minus') + '"></i>' +
          U.esc(s.name) + ' <span class="font-mono opacity-70">' + U.qty(s.total) + ' ' + U.esc(s.um || '') + '</span></span>';
      }).join('') + '</div></div>';
  }

  /* Cheap partial refresh so typing in a qty cell does not rebuild the table
     and steal focus. */
  function updateTotals() {
    var p = product(), g = currentGroup();
    if (!p || !g) return;
    g.items.forEach(function (it) {
      var el = U.$('tot-' + it.id);
      if (el) el.textContent = U.currency2(M.itemTotal(it, g, p));
      /* An input now, not a label - so never while it is the box being typed
         in, or a half-typed "1" on its way to "12" gets rewritten underneath
         the caret. */
      var ord = U.$('ord-' + it.id);
      if (ord && document.activeElement !== ord) {
        var q = M.orderQty(it, g, p);
        ord.value = q == null ? '' : U.n(q);
      }
    });
    var mc = U.$('matCost');
    if (mc) mc.textContent = U.currency2(M.computeProduct(p).materialCost);
  }

  /* ---- XLSX export ------------------------------------------------------ */

  /* Both exports go through js/estimate.xlsx.js, which writes the takeoff into
     the shop's own workbook - its fonts, its colours, its lookup sheets, and
     live formulas rather than a snapshot of the arithmetic. A single product
     still gets the References sheet and the cost summary with it, because a
     sheet with nothing behind it cannot be worked on. */
  function exportProduct(pid) {
    var t = takeoff();
    var p = t && t.products.filter(function (x) { return x.id === pid; })[0];
    if (!p || !root.Estimate) { U.toast('Export unavailable.', 'err'); return; }
    if (root.Estimate.download(t, p.id, filename(t) + ' - ' + p.type + '.xlsx')) {
      U.toast('Exported ' + p.type + '.', 'ok');
    }
  }

  /* The whole takeoff: the cost summary, then a sheet per product. */
  function exportWorkbook() {
    var t = takeoff();
    if (!t) return;
    if (!root.Estimate) { U.toast('The estimate exporter did not load.', 'err'); return; }
    if (!t.products.length) { U.toast('Nothing to export yet - add a product first.', 'warn'); return; }

    if (root.Estimate.download(t, null, filename(t) + ' - Takeoff.xlsx')) {
      U.toast('Exported ' + t.products.length + ' product sheet' +
        (t.products.length === 1 ? '' : 's') + '.', 'ok');
    }
  }

  function filename(t) {
    return String(t.project.name || 'Takeoff').replace(/[\\/:*?"<>|]/g, '-');
  }

  /* ---- public API ------------------------------------------------------ */

  root.Takeoff = {
    render: render,
    openForBid: openForBid,
    openTakeoff: function (id) { openTakeoff(id); },
    hasTakeoff: function (bid) { return !!(bid.takeoffId && db().takeoffs[bid.takeoffId]); },
    currentId: function () { return state.takeoffId; },
    commit: commit,

    toggle: function (key) {
      var c = db().ui.collapsed;
      c[key] = !c[key];
      save();
    },
    selectProduct: function (id) {
      state.productId = id; state.groupId = null;
      state.view = 'estimate';       // picking a product means you want it shown
      save();
    },
    selectGroup: function (pid, gid) {
      state.productId = pid; state.groupId = gid;
      state.view = 'estimate';
      save();
    },
    setTab: function (tb) { state.tab = tb; render(); },
    setView: function (v) { state.view = v; render(); },
    currentView: function () { return state.view; },

    /* ---- project rates ------------------------------------------------ */

    /* Blank clears the override, so emptying a field means "follow the shop
       default again" rather than "this project bills zero". */
    setProjectRate: function (key, v) {
      var t = takeoff();
      if (!t) return;
      var pr = projectRates(t);
      if (v === '' || v == null) delete pr.global[key];
      else pr.global[key] = Number(v);
      // Hour factors feed the formulas, so every product that has not been
      // typed over recalculates straight away.
      (t.products || []).forEach(function (p) { M.applyDerived(p, t); });
      save();
    },
    clearProjectRate: function (key) {
      var t = takeoff();
      if (!t) return;
      delete projectRates(t).global[key];
      (t.products || []).forEach(function (p) { M.applyDerived(p, t); });
      save();
    },
    clearAllProjectRates: function () {
      var t = takeoff();
      if (!t) return;
      var n = Object.keys(projectRates(t).global).length;
      if (!n) return;
      if (!confirm('Drop all ' + n + ' project rate override(s) and go back to the shop defaults?\n\n' +
        'Rates already written onto this project\'s products are not changed.')) return;
      t.rates.global = {};
      (t.products || []).forEach(function (p) { M.applyDerived(p, t); });
      save();
      U.toast('Project rates reset to the shop defaults.', 'ok');
    },
    applyRateToProducts: function (key) {
      var t = takeoff();
      if (!t) return;
      var path = RATE_TO_PATH[key][0];
      var hits = rateMismatches(t).filter(function (m) { return m.key === key; })[0];
      if (!hits) return;
      if (!confirm('Set ' + RATE_TO_PATH[key][1] + ' on ' + hits.products.length + ' product(s)?\n\n' +
        hits.products.map(function (p) { return '  ' + p.type; }).join('\n') +
        '\n\nAny rate typed by hand on those products is replaced.')) return;
      hits.products.forEach(function (p) {
        M.pathSet(p, path, root.Rates.forType(p.type, t)[key]);
      });
      save();
      U.toast('Applied to ' + hits.products.length + ' product(s).', 'ok');
    },
    menu: function (id) {
      var el = U.$('menu-' + id);
      var wasHidden = el.classList.contains('hidden');
      document.querySelectorAll('[id^="menu-"]').forEach(function (m) { m.classList.add('hidden'); });
      if (wasHidden) el.classList.remove('hidden');
    },

    addFromPicker: function () {
      var sel = U.$('addProductType');
      var v = sel.value;
      if (v === '__custom') {
        var name = prompt('Name for the custom product type:', '');
        if (name == null || !name.trim()) return;
        addProduct(name.trim());
      } else addProduct(v);
    },
    addProduct: addProduct,
    removeProduct: removeProduct,
    duplicateProduct: duplicateProduct,
    moveProduct: moveProduct,
    exportProduct: exportProduct,
    exportWorkbook: exportWorkbook,

    addItem: addItem,
    removeItem: removeItem,
    moveItem: moveItem,
    setItem: setItemField,
    setItemOnProposal: function (itemId, checked) {
      var g = currentGroup();
      var it = g.items.filter(function (x) { return x.id === itemId; })[0];
      if (!it) return;
      it.showInProposal = !!checked;
      save();
    },
    setAllItemsOnProposal: function (checked) {
      currentGroup().items.forEach(function (it) { it.showInProposal = !!checked; });
      save();
    },
    toggleQtyMode: function (itemId) {
      var it = itemById(itemId);
      if (!it) return;
      it.qtyMode = it.qtyMode === 'formula' ? 'manual' : 'formula';
      save();
    },

    /* ---- drawing scopes ----------------------------------------------- */

    /* Point a row at a different scope, or off all of them. Unlinking keeps the
       scope's name in the Feature box and its last total as the typed quantity,
       so the row carries on saying what it was for instead of emptying. */
    setScope: function (itemId, key) {
      var p = product(), g = currentGroup();
      var it = itemById(itemId);
      if (!it) return;
      if (key === '__unlink') {
        var last = M.requiredQty(it, g, p);
        it.qty = last == null ? it.qty : last;
        it.qtyMode = 'manual';
        it.scopeKey = null;
        save();
        U.toast('Unlinked. The quantity is now typed on this row.', 'ok');
        return;
      }
      var s = M.findScope(p, key);
      if (!s) return;
      it.qtyMode = 'takeoff';
      it.scopeKey = s.key;
      it.feature = s.name;
      if (!it.um || it.um === 'EA') it.um = s.um || it.um;
      save();
    },

    /* Link a free-standing row. Offers the scope whose name is closest to what
       the row is already called, because a row called "Mid Rail" being linked
       is almost always being linked to the scope of that name. */
    linkToScope: function (itemId) {
      var p = product();
      var it = itemById(itemId);
      var scopes = M.productScopes(p);
      if (!it || !scopes.length) return;
      var want = M.scopeKey(it.feature);
      var best = scopes.filter(function (s) { return s.key === want; })[0];
      if (!best) {
        var names = scopes.map(function (s, i) { return '  ' + (i + 1) + '. ' + s.name; }).join('\n');
        var pick = prompt('Measure "' + (it.feature || 'this row') +
          '" off which drawing scope?\n\n' + names + '\n\nType a number:', '1');
        if (pick == null) return;
        best = scopes[Number(pick) - 1];
        if (!best) { U.toast('No scope with that number.', 'warn'); return; }
      }
      it.qtyMode = 'takeoff';
      it.scopeKey = best.key;
      it.feature = best.name;
      if (!it.um || it.um === 'EA') it.um = best.um || it.um;
      save();
      U.toast('Measured by "' + best.name + '" - ' + U.qty(best.total) + ' ' + (best.um || '') + '.', 'ok');
    },

    /* Everything measured but not yet being bought, given a row. */
    addRowsForScopes: function () {
      var p = product();
      var added = M.syncScopeRows(p);
      save();
      U.toast(added.length
        ? 'Added ' + added.length + ' material row' + (added.length > 1 ? 's' : '') + '.'
        : 'Every measured scope already has a row.', added.length ? 'ok' : 'warn');
    },

    /* Blank means "go back to the calculation", not "order nothing".
       Same rule setProjectRate applies to an emptied rate box, and for the same
       reason: an empty field reads as "I have not said", and treating it as a
       zero would silently take the row out of the estimate. */
    setOrderQty: function (itemId, v) {
      var it = itemById(itemId);
      if (!it) return;
      var s = String(v == null ? '' : v).trim();
      if (!s) { delete it.orderQtyOverride; delete it.orderQtyBase; save(); return; }
      // Whole items only - the field is what you hand a vendor.
      it.orderQtyOverride = Math.max(0, Math.ceil(Number(s) || 0));
      /* What the calculation said at the moment of the decision. Kept so the
         row can tell later whether the drawings have moved since, rather than
         only that the typed figure differs from the calculation - which is
         what an override is, and not news. See M.orderQtyStale. */
      it.orderQtyBase = M.computedOrderQty(it, currentGroup(), product());
      save();
    },
    clearOrderQty: function (itemId) {
      var it = itemById(itemId);
      if (!it) return;
      delete it.orderQtyOverride;
      delete it.orderQtyBase;
      save();
    },

    toggleCostBasis: function (itemId) {
      var it = itemById(itemId);
      if (!it) return;
      it.costBasis = it.costBasis === 'unit' ? 'pack' : 'unit';
      save();
    },

    scrollToStockGap: function () {
      var el = document.querySelector('#matBody tr[data-needs-stock]');
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      var box = el.querySelector('input[type="number"][placeholder="1"]');
      if (box) box.focus();
    },

    /* The caret beside Vendor Part No. The list is the combobox the field
       already has, so there is one list and one way of picking from it. */
    openPartList: function (btn) {
      var input = btn.parentNode.querySelector('input');
      if (!input) return;
      input.focus();
      combo(input);
    },
    combo: combo, comboBlur: comboBlur, comboKey: comboKey, comboPick: comboPick,
    applyCatalogItem: applyCatalogItem,

    addGroup: addGroup, renameGroup: renameGroup, removeGroup: removeGroup,

    setTotalLF: function (v) {
      var p = product();
      p.totalLF = v === '' ? null : Number(v);
      M.applyDerived(p, takeoff());
      save();
    },
    setProductField: function (f, v) { product()[f] = v; save(); },
    setProductNum: function (f, v) { product()[f] = v === '' ? null : Number(v); save(); },
    setCost: function (path, v) { M.setField(product(), path, v); save(); },
    clearOverride: function (path) { M.clearOverride(product(), path, takeoff()); save(); },
    resetAllOverrides: function () { M.clearAllOverrides(product(), takeoff()); save(); },

    /* ---- Cost & Labour row controls ----------------------------------- */

    /* Ticked = described on the proposal. Deliberately does not touch cost. */
    setRowOnProposal: function (rowId, checked) {
      var p = product();
      if (checked) delete p.proposalRows[rowId];
      else p.proposalRows[rowId] = false;
      save();
    },
    setRowLabel: function (rowId, value) {
      var p = product();
      var v = String(value || '').trim();
      // The finish row writes to finish.label, which is only the text after the
      // fixed prefix. Routing it through rowLabels would let someone store a
      // label with no prefix at all.
      if (rowId === 'finish') { p.finish.label = v; save(); return; }
      if (!v || v === M.defaultRowLabel(p, rowId)) delete p.rowLabels[rowId];
      else p.rowLabels[rowId] = v;
      save();
    },
    resetRowLabel: function (rowId) {
      var p = product();
      if (rowId === 'finish') {
        p.finish.label = root.Rates.template(p.type).finishLabel || '';
        save();
        return;
      }
      delete p.rowLabels[rowId];
      save();
    },

    /* Two-step delete. Step one is the inline chip; step two names the row and
       the money it takes out, so the second prompt says something the first
       one did not. */
    askRemoveRow: function (rowId) { pendingDelete = rowId; render(); },
    cancelRemoveRow: function () { pendingDelete = null; render(); },
    confirmRemoveRow: function (rowId) {
      var p = product();
      var def = M.costRowDef(rowId);
      var amount = M.computeProduct(p)[def.totalKey];
      var ok = confirm(
        'Remove "' + M.rowLabel(p, rowId) + '" from ' + p.type + '?\n\n' +
        U.currency2(amount) + ' will come out of this product\'s total cost.\n\n' +
        'The values you typed are kept, and the row can be restored from the ' +
        'strip above the table.');
      pendingDelete = null;
      if (!ok) { render(); return; }
      p.hiddenRows[rowId] = true;
      save();
      U.toast('"' + M.rowLabel(p, rowId) + '" removed from the cost.', 'ok');
    },
    restoreRow: function (rowId) {
      var p = product();
      delete p.hiddenRows[rowId];
      save();
      U.toast('"' + M.rowLabel(p, rowId) + '" restored.', 'ok');
    },
    setRollup: function (f, v) { takeoff().rollup[f] = v === '' ? 0 : Number(v); save(); },
    toggleRoundMode: function () {
      var r = takeoff().rollup;
      if (r.roundMode === 'manual') {
        r.roundMode = 'auto10';
      } else {
        // Seed the manual box with the uplift it was already applying, so
        // switching over does not jump the total.
        r.roundoff = Math.round(M.computeTakeoff(takeoff()).roundoff * 100) / 100;
        r.roundMode = 'manual';
      }
      save();
    },

    addExtra: function () {
      var p = product();
      p.extras = p.extras || [];
      // qty and unitPrice start empty rather than zero: an empty pair is what
      // tells M.extraAmount to fall back to the flat amount, and a new charge
      // has not been told which kind it is yet.
      p.extras.push({ id: root.Store.uid('x'), label: 'Other charge',
                      qty: null, um: '', unitPrice: null, amount: null });
      save();
    },
    setExtra: function (i, f, v) {
      var p = product();
      var numeric = f === 'amount' || f === 'qty' || f === 'unitPrice';
      p.extras[i][f] = numeric ? (v === '' ? null : Number(v))
        : f === 'showInProposal' ? !!v
        : String(v == null ? '' : v).trim();
      // A charge given a quantity and a unit price is priced by them from now
      // on, so a flat amount left over from before would be dead data that the
      // XLSX export would still print.
      if ((f === 'qty' || f === 'unitPrice') && M.extraAmount(p.extras[i]) !== U.n(p.extras[i].amount)) {
        p.extras[i].amount = null;
      }
      save();
    },
    removeExtra: function (i) { product().extras.splice(i, 1); save(); },

    /* The unit a standard Cost & Labour row is billed in. Stored only when it
       differs from the default, the same way a renamed label is - see
       M.rowUnit. Clearing it puts the default back rather than leaving a blank
       column. */
    setRowUnit: function (id, value) {
      var p = product();
      var next = String(value == null ? '' : value).trim();
      if (!p.rowUnits) p.rowUnits = {};
      if (!next || next === M.defaultRowUnit(p, id)) delete p.rowUnits[id];
      else p.rowUnits[id] = next;
      save();
    },

    /* Name it after the thing being bought - that name is what the material row
       will be called, and what a second column of the same name totals with, so
       it is worth typing carefully. The unit is asked for separately rather
       than being written into the heading, because the order quantity divides
       by it and cannot read prose. */
    addCol: function () {
      var label = prompt('What is being measured? (e.g. \'Top Rail 1-1/2" Pipe\')\n\n' +
        'A material row is created under this name, and another column called ' +
        'the same thing totals with it.', '');
      if (label == null || !label.trim()) return;
      var um = prompt('What is it measured in?\n\n' + M.UNITS.join('  '), 'LF');
      if (um == null) return;
      currentGroup().grid.columns.push(M.newColumn(label.trim(), um.trim().toUpperCase()));
      save();
    },
    removeCol: function (key) {
      var g = currentGroup(), p = product();
      var col = g.grid.columns.filter(function (c) { return c.key === key; })[0];
      /* Material rows are never removed with the column that fed them. A
         costed, part-numbered line is not something to lose to a deletion aimed
         at a spreadsheet column - so the rows are named in the prompt and left
         behind to be relinked or unlinked deliberately. */
      var orphan = M.scopeKey(col.label);
      var scope = M.findScope(p, orphan);
      var elsewhere = scope && scope.columns.length > 1;
      var rows = 0;
      p.groups.forEach(function (gr) {
        gr.items.forEach(function (it) { if (it.scopeKey === orphan) rows++; });
      });
      if (!confirm('Delete column "' + col.label + '" and its values?' +
        (rows && !elsewhere
          ? '\n\n' + rows + ' material row(s) are measured by it. They are kept, and ' +
            'will ask you to point them at another scope or unlink them.'
          : ''))) return;
      g.grid.columns = g.grid.columns.filter(function (c) { return c.key !== key; });
      g.grid.rows.forEach(function (r) { delete r.values[key]; });
      save();
    },
    /* Renaming a column renames the scope, so every row measured by it follows.
       Without this, fixing a typo in a heading would strand the material rows
       it was feeding. */
    setColLabel: function (key, v) {
      var p = product();
      var col = currentGroup().grid.columns.filter(function (c) { return c.key === key; })[0];
      var from = M.scopeKey(col.label);
      var to = M.scopeKey(v);
      col.label = v;
      if (from && to && from !== to) {
        p.groups.forEach(function (gr) {
          gr.items.forEach(function (it) {
            if (it.scopeKey !== from) return;
            it.scopeKey = to;
            it.feature = v;
          });
        });
      }
      save();
    },
    setColUnit: function (key, v) {
      var col = currentGroup().grid.columns.filter(function (c) { return c.key === key; })[0];
      col.um = String(v == null ? '' : v).trim().toUpperCase();
      save();
    },
    addRow: function () {
      currentGroup().grid.rows.push({ ref: '', values: {} });
      save();
    },
    removeRow: function (i) { currentGroup().grid.rows.splice(i, 1); save(); },
    setRowRef: function (i, v) { currentGroup().grid.rows[i].ref = v; root.Store.save(); },

    /* ---- documents ---------------------------------------------------- */

    addDoc: function () {
      var t = takeoff();
      if (!t) return;
      var name = (U.$('docName').value || '').trim();
      var url = (U.$('docUrl').value || '').trim();
      if (!url) { U.toast('Paste the link to the document first.', 'warn'); return; }
      if (!U.safeUrl(url)) {
        U.toast('That is not a web link - it has to start with https://.', 'err');
        return;
      }
      var docs = M.documents(t);
      // The name is optional at the point of pasting: the last path segment of
      // a OneDrive link is rarely readable, so a plain numbered fallback beats
      // a mangled one somebody then has to clear out.
      var doc = M.newDocument({
        name: name || 'Document ' + (docs.length + 1),
        url: url,
        category: U.$('docCat').value || 'Drawing set',
        // Auth.user is a getter, not a function - see js/auth.js. Empty on the
        // single-user path, same as js/history.js's actor(): there is nobody to
        // be, and attributing the add to a name would be an invention.
        addedBy: (root.Auth.user && (root.Auth.user.initials || root.Auth.user.name)) || ''
      });
      docs.push(doc);
      // The first one filed is the drawing set, so the common case - one PDF,
      // every reference pointing at it - takes no further decision.
      if (!t.drawingDocId) t.drawingDocId = doc.id;
      save();
      U.toast('"' + doc.name + '" added' +
        (t.drawingDocId === doc.id ? ' and set as the drawing set.' : '.'), 'ok');
    },
    setDoc: function (id, field, v) {
      var d = M.findDocument(takeoff(), id);
      if (!d) return;
      d[field] = String(v == null ? '' : v).trim();
      save();
    },
    setDrawingDoc: function (id) {
      var t = takeoff();
      t.drawingDocId = t.drawingDocId === id ? null : id;
      save();
    },
    /* Named counts in the confirm, because "delete" here disconnects drawing
       references somewhere else in the takeoff and there is no way to see how
       many from the row being deleted. */
    removeDoc: function (id) {
      var t = takeoff();
      var d = M.findDocument(t, id);
      if (!d) return;
      var refs = M.docRefCount(t, id);
      if (!confirm('Remove "' + (d.name || 'this document') + '" from this takeoff?' +
        (refs ? '\n\n' + refs + ' drawing reference(s) open it. They are kept, and will ' +
          'show as having no document until you point them at another one.' : '') +
        '\n\nThe file itself is not touched - this only removes the link.')) return;
      t.documents = M.documents(t).filter(function (x) { return x.id !== id; });
      if (t.drawingDocId === id) t.drawingDocId = null;
      // Rows that named this one explicitly go back to following the drawing
      // set, rather than being left pointing at an id nothing answers to.
      (t.products || []).forEach(function (p) {
        (p.groups || []).forEach(function (g) {
          ((g.grid && g.grid.rows) || []).forEach(function (r) {
            if (r.docId === id) delete r.docId;
          });
        });
      });
      save();
      U.toast('Link removed.', 'ok');
    },

    refMenu: refMenu,
    setRowDoc: function (i, docId) {
      refMenuClose();
      var row = currentGroup().grid.rows[i];
      if (docId) row.docId = docId; else delete row.docId;
      save();
    },
    /* "All the drawing refs point at the same pdf" without setting it as the
       default - for a grid measured off an addendum, say, while the rest of the
       takeoff still follows the drawing set. */
    linkAllRefs: function (docId) {
      refMenuClose();
      var t = takeoff();
      var g = currentGroup();
      var d = docId ? M.findDocument(t, docId) : null;
      var label = d ? '"' + (d.name || 'Untitled') + '"' : 'the drawing set';
      if (!confirm('Point all ' + g.grid.rows.length + ' drawing reference(s) in "' +
        g.name + '" at ' + label + '?')) return;
      g.grid.rows.forEach(function (r) {
        if (docId) r.docId = docId; else delete r.docId;
      });
      save();
      U.toast(g.grid.rows.length + ' reference(s) now open ' + label + '.', 'ok');
    },
    /* Measuring something is asking to buy it, so the material row appears as
       the quantity is typed rather than waiting to be asked for. */
    setCellValue: function (i, key, v) {
      currentGroup().grid.rows[i].values[key] = v === '' ? null : Number(v);
      var added = M.syncScopeRows(product());
      save();
      if (added.length) {
        U.toast(added.length === 1
          ? 'Added "' + added[0].feature + '" to the Materials tab.'
          : 'Added ' + added.length + ' rows to the Materials tab.', 'ok');
      }
    },
  };

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('[id^="menu-"]')) {
      document.querySelectorAll('[id^="menu-"]').forEach(function (m) { m.classList.add('hidden'); });
    }
    // The reference picker lives on the body, so it is not inside anything a
    // click can be "outside" of structurally - it closes on any click that is
    // not on itself.
    if (refBox && !refBox.contains(e.target)) refMenuClose();
  });
  window.addEventListener('scroll', comboClose, true);
  // Both floating panels are positioned once, from a rectangle that scrolling
  // invalidates - so they close rather than drift away from what opened them.
  window.addEventListener('scroll', refMenuClose, true);
  window.addEventListener('resize', refMenuClose);
})(window);
