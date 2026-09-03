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
    var g = currentGroup();
    var it = g.items.filter(function (x) { return x.id === itemId; })[0];
    if (!it) return;
    if (['qty', 'unitCost', 'weightLb'].indexOf(field) >= 0) {
      it[field] = value === '' ? null : Number(value);
    } else {
      it[field] = value;
    }
    root.Store.save();
    updateTotals();
  }

  function applyCatalogItem(itemId, catId) {
    var g = currentGroup();
    var it = g.items.filter(function (x) { return x.id === itemId; })[0];
    var c = root.Catalog.find(catId);
    if (!it || !c) return;
    it.vendor = c.vendor;
    it.partNo = c.partNo;
    it.description = c.description;
    if (c.feature) it.feature = c.feature;
    if (c.option) it.option = c.option;
    it.material = c.material;
    it.grade = c.grade;
    it.um = c.um || it.um;
    it.unitCost = c.unitCost;
    it.catalogId = c.id;
    if (c.weightPerUnit != null && it.qty) it.weightLb = c.weightPerUnit * Number(it.qty);
    save();
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
    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-8">' +
      '<h3 class="text-lg font-bold text-slate-800 mb-1">Takeoff</h3>' +
      '<p class="text-sm text-slate-500 mb-6">Pick a bid to estimate. A takeoff is created the first time you open one.</p>' +
      (withT.length ? '<p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Existing takeoffs</p>' +
        '<div class="space-y-2 mb-6">' + withT.map(function (b) {
          var roll = M.computeTakeoff(d.takeoffs[b.takeoffId]);
          return '<button onclick="Takeoff.openTakeoff(\'' + b.takeoffId + '\')" ' +
            'class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 transition flex items-center justify-between">' +
            '<span class="text-sm font-semibold text-slate-800">' + U.esc(b.project) + '</span>' +
            '<span class="text-sm font-mono text-slate-600">' + U.currency(roll.total) + '</span></button>';
        }).join('') + '</div>' : '') +
      '<p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Start a takeoff</p>' +
      '<select onchange="if(this.value)Takeoff.openForBid(Number(this.value))" class="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">' +
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
        (active ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50') + '">' +
        '<button onclick="event.stopPropagation();Takeoff.toggle(\'p:' + p.id + '\')" class="w-5 text-slate-400 hover:text-slate-700 text-xs">' +
          '<i class="fas fa-chevron-' + (open ? 'down' : 'right') + '"></i></button>' +
        '<button onclick="Takeoff.selectProduct(\'' + p.id + '\')" class="flex-1 text-left min-w-0">' +
          '<div class="text-sm font-semibold text-slate-800 truncate">' + U.esc(p.type) + '</div>' +
          '<div class="text-[11px] text-slate-500 font-mono">' + unitLabel + ' &middot; ' + U.currency2(c.total) + '</div>' +
        '</button>' +
        '<span class="relative"><button onclick="event.stopPropagation();Takeoff.menu(\'' + p.id + '\')" class="w-6 h-6 rounded hover:bg-slate-200 text-slate-400 text-xs"><i class="fas fa-ellipsis-v"></i></button>' +
        '<span id="menu-' + p.id + '" class="hidden absolute right-0 top-7 z-20 bg-white border border-slate-200 rounded-lg shadow-xl py-1 w-44 text-left">' +
          menuItem('fa-copy', 'Duplicate', "Takeoff.duplicateProduct('" + p.id + "')") +
          menuItem('fa-arrow-up', 'Move up', "Takeoff.moveProduct('" + p.id + "',-1)") +
          menuItem('fa-arrow-down', 'Move down', "Takeoff.moveProduct('" + p.id + "',1)") +
          menuItem('fa-file-excel', 'Export sheet', "Takeoff.exportProduct('" + p.id + "')") +
          '<div class="border-t border-slate-100 my-1"></div>' +
          menuItem('fa-trash', 'Delete', "Takeoff.removeProduct('" + p.id + "')", 'text-red-600') +
        '</span></span></div>';

      if (!open) return head;

      var groups = p.groups.map(function (g) {
        var gOpen = !collapsed['g:' + g.id];
        var gCost = M.groupMaterialCost(g);
        return '<div class="ml-6">' +
          '<div class="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">' +
            '<button onclick="Takeoff.toggle(\'g:' + g.id + '\')" class="w-4 text-slate-300 text-[10px]"><i class="fas fa-chevron-' + (gOpen ? 'down' : 'right') + '"></i></button>' +
            '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + g.id + '\')" class="flex-1 text-left text-xs text-slate-600 truncate">' +
              U.esc(g.name) + ' <span class="text-slate-400">(' + g.items.length + ')</span></button>' +
            '<span class="text-[11px] font-mono text-slate-500">' + U.currency2(gCost) + '</span></div>' +
          (gOpen ? '<div class="ml-5 border-l border-slate-100 pl-2">' + (g.items.length ? g.items.map(function (it) {
            var q = M.itemQty(it, g);
            return '<div class="py-1 text-[11px] text-slate-500 flex items-baseline gap-2 hover:text-slate-800">' +
              '<span class="truncate flex-1" title="' + U.escAttr(it.description) + '">' +
              U.esc(it.feature || it.description || 'Untitled row') + '</span>' +
              '<span class="font-mono whitespace-nowrap">' + U.qty(q) + ' ' + U.esc(it.um || '') + '</span>' +
              '<span class="font-mono whitespace-nowrap text-slate-600">' + U.currency2(M.itemTotal(it, g)) + '</span></div>';
          }).join('') : '<div class="py-1 text-[11px] text-slate-300 italic">no rows</div>') + '</div>' : '') +
          '</div>';
      }).join('');

      var labour = '<div class="ml-6 px-2 py-1.5 flex items-center justify-between text-xs text-slate-600">' +
        '<span class="pl-4">Labour &amp; Equipment</span>' +
        '<span class="font-mono text-slate-500">' + U.currency2(c.labourEquipTotal) + '</span></div>' +
        '<div class="ml-6 px-2 py-1.5 flex items-center justify-between text-xs text-slate-600">' +
        '<span class="pl-4">Markup ' + U.qty(p.markupPct) + '% + O&amp;P ' + U.qty(p.overheadPct) + '%</span>' +
        '<span class="font-mono text-slate-500">' + U.currency2(c.markup + c.overhead) + '</span></div>';

      return head + groups + labour;
    }).join('');

    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden sticky top-4">' +
      '<div class="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">' +
        '<div class="min-w-0"><div class="text-sm font-bold text-slate-800 truncate">' +
          U.esc(t.project.name || 'Untitled project') + '</div>' +
          '<div class="text-[11px] text-slate-500">' + (bid ? U.esc(bid.region || 'No region') : 'Not linked to a bid') + '</div></div>' +
        '<div class="flex items-center gap-1 shrink-0">' +
          '<button onclick="Takeoff.setView(\'rates\')" title="Labour, equipment and markup rates for this project" ' +
            'class="text-xs px-1.5 py-1 rounded ' +
            (state.view === 'rates' ? 'text-blue-600 bg-blue-50' : 'text-slate-400 hover:text-slate-700') +
            '"><i class="fas fa-sliders-h"></i></button>' +
          '<button onclick="Takeoff.openTakeoff(null)" class="text-xs text-slate-400 hover:text-slate-700 px-1.5 py-1" title="Choose another takeoff"><i class="fas fa-exchange-alt"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="p-2 max-h-[520px] overflow-y-auto">' +
        (products || '<p class="text-sm text-slate-400 text-center py-8">No product types yet.<br>Add one below.</p>') +
      '</div>' +
      renderRollup(t, roll) +
      '<div class="p-3 border-t border-slate-200 bg-slate-50 flex gap-2">' +
        '<select id="addProductType" class="flex-1 px-2 py-2 bg-white border border-slate-200 rounded-lg text-xs outline-none">' +
          root.Rates.TYPES.map(function (ty) { return '<option>' + U.esc(ty) + '</option>'; }).join('') +
          '<option value="__custom">Custom...</option></select>' +
        '<button onclick="Takeoff.addFromPicker()" class="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1"></i>Add</button>' +
      '</div></div>';
  }

  function menuItem(icon, label, onclick, cls) {
    return '<button onclick="' + onclick + '" class="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ' +
      (cls || 'text-slate-700') + '"><i class="fas ' + icon + ' w-4 mr-1.5"></i>' + label + '</button>';
  }

  function renderRollup(t, roll) {
    var r = t.rollup;
    function line(label, value, extra) {
      return '<div class="flex items-center justify-between py-1 text-xs ' + (extra || 'text-slate-600') + '">' +
        '<span>' + label + '</span><span class="font-mono">' + U.currency2(value) + '</span></div>';
    }
    return '<div class="px-4 py-3 border-t border-slate-200 bg-white">' +
      line('Project Base Cost', roll.base, 'text-slate-800 font-semibold') +
      '<div class="flex items-center justify-between py-1 text-xs text-slate-600"><span>Total LF</span>' +
        '<span class="font-mono">' + U.qty(roll.totalLF) + '</span></div>' +
      '<div class="border-t border-slate-100 my-2"></div>' +
      rollInput('Miscellaneous', 'miscPct', r.miscPct, '%', roll.misc) +
      rollInput('Delivery &amp; Freight', 'freight', r.freight, '$', roll.freight) +
      rollInput('Tax', 'taxPct', r.taxPct, '%', roll.tax) +
      roundoffLine(r, roll) +
      '<div class="flex items-center justify-between pt-2 mt-2 border-t-2 border-slate-800">' +
        '<span class="text-xs font-bold text-slate-800 uppercase tracking-wider">Total Bid Cost</span>' +
        '<span class="font-mono text-base font-bold text-slate-900">' + U.currency2(roll.total) + '</span></div>' +
      '<div class="flex gap-2 mt-3">' +
        '<button onclick="Takeoff.commit()" class="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold"><i class="fas fa-save mr-1"></i>Save takeoff</button>' +
        '<button onclick="Proposal.generateFromTakeoff(\'' + t.id + '\')" class="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold"><i class="fas fa-file-contract mr-1"></i>Proposal</button>' +
      '</div>' +
      /* The whole takeoff as a workbook. There is a per-product export in each
         product's menu too, but the estimate is worked as one thing and that is
         how it is usually wanted on paper. Same permission as the bids table
         export - see Nav.MENU. */
      (root.Auth.can('bid.export')
        ? '<button onclick="Takeoff.exportWorkbook()" title="Every product as its own worksheet, plus a cost summary" ' +
          'class="w-full mt-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-file-excel mr-1"></i>Export to Excel</button>'
        : '') +
      '</div>';
  }

  /* In auto mode the roundoff is the uplift to the next ten, so it is reported
     rather than typed. Manual mode stays available for sheets like the
     Lancaster workbook that carry a negotiated roundoff. */
  function roundoffLine(r, roll) {
    var auto = r.roundMode !== 'manual';
    return '<div class="flex items-center justify-between py-1 text-xs text-slate-600 gap-2">' +
      '<span class="flex-1">Roundoff ' +
        '<button onclick="Takeoff.toggleRoundMode()" title="' +
        (auto ? 'Switch to a manually entered roundoff' : 'Switch back to rounding up to the next 10') + '" ' +
        'class="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ' +
        (auto ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600') + '">' +
        (auto ? 'auto' : 'manual') + '</button></span>' +
      (auto
        ? '<span class="text-[10px] text-slate-400">to next 10</span>'
        : '<input type="number" step="1" value="' + (r.roundoff == null ? '' : r.roundoff) +
          '" onchange="Takeoff.setRollup(\'roundoff\',this.value)" ' +
          'class="w-24 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-right font-mono text-xs outline-none focus:border-blue-400">') +
      '<span class="font-mono w-24 text-right' + (auto ? ' text-blue-700' : '') + '">' +
        (auto && roll.roundoff > 0 ? '+' : '') + U.currency2(roll.roundoff) + '</span></div>';
  }

  function rollInput(label, field, value, unit, computed) {
    return '<div class="flex items-center justify-between py-1 text-xs text-slate-600 gap-2">' +
      '<span class="flex-1">' + label + '</span>' +
      (unit === '%' ? '<input type="number" step="0.1" value="' + (value == null ? '' : value) +
        '" onchange="Takeoff.setRollup(\'' + field + '\',this.value)" class="w-14 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-right font-mono text-xs outline-none focus:border-blue-400"><span class="text-slate-400 -ml-1">%</span>' : '') +
      (unit === '$' ? '<input type="number" step="1" value="' + (value == null ? '' : value) +
        '" onchange="Takeoff.setRollup(\'' + field + '\',this.value)" class="w-24 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-right font-mono text-xs outline-none focus:border-blue-400">' : '') +
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
        ? '<button onclick="Takeoff.clearAllProjectRates()" class="text-xs text-amber-600 hover:text-amber-800 underline">' +
          'Reset all ' + overridden.length + ' override' + (overridden.length > 1 ? 's' : '') + '</button>'
        : '<span class="text-xs text-slate-400">Following the shop defaults</span>',
      footer:
        '<p class="mt-3 text-[11px] text-slate-400">The hour formulas (factors and base hours) ' +
        'recalculate immediately. Unit rates are stored on each product, so those are applied ' +
        'on request below.</p>'
    });

    var strip = mismatches.length
      ? '<div class="bg-white rounded-xl shadow-sm border border-amber-200 p-5">' +
        '<h4 class="text-sm font-bold text-slate-800 mb-3">' +
          '<i class="fas fa-triangle-exclamation text-amber-500 mr-2"></i>Products billing a different rate</h4>' +
        mismatches.map(function (m) {
          var want = root.Rates.forType('', t)[m.key];
          return '<div class="flex flex-wrap items-center gap-3 py-2 border-t border-slate-100 text-xs">' +
            '<span class="font-semibold text-slate-700 w-28 shrink-0">' + U.esc(m.label) + '</span>' +
            '<span class="flex-1 min-w-[180px] text-slate-500">' +
              m.products.map(function (p) {
                return U.esc(p.type) + ' <span class="font-mono text-slate-400">(' +
                  U.qty(M.pathGet(p, RATE_TO_PATH[m.key][0])) + ')</span>';
              }).join(', ') + '</span>' +
            '<button onclick="Takeoff.applyRateToProducts(\'' + m.key + '\')" ' +
              'class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-[11px] font-semibold whitespace-nowrap">' +
              'Apply ' + U.qty(want) + ' to ' + m.products.length + '</button>' +
          '</div>';
        }).join('') +
        '</div>'
      : '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-xs text-slate-500">' +
        '<i class="fas fa-check-circle text-emerald-500 mr-1.5"></i>' +
        'Every product in this takeoff bills the project rates.</div>';

    return '<div>' +
      '<div class="flex items-center justify-between mb-4">' +
        '<div><h3 class="text-lg font-bold text-slate-800">Project Rates</h3>' +
        '<p class="text-xs text-slate-500">' + U.esc(t.project.name || 'Untitled project') + '</p></div>' +
        '<button onclick="Takeoff.setView(\'estimate\')" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-arrow-left mr-1.5"></i>Back to the estimate</button>' +
      '</div>' + panel + strip + '</div>';
  }

  /* ---- right pane ------------------------------------------------------ */

  function renderProductPane(t) {
    var p = product();
    if (!p) {
      return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">' +
        '<i class="fas fa-cubes text-4xl text-slate-200 mb-3"></i>' +
        '<p class="text-slate-500 text-sm">Add a product type to start the takeoff.</p></div>';
    }
    var c = M.computeProduct(p);
    var tabs = [['materials', 'Materials', 'fa-list'],
                ['cost', 'Cost & Labour', 'fa-calculator'],
                ['grid', 'Drawing Takeoff', 'fa-ruler-combined']];

    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">' +
      '<div class="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center gap-3 justify-between">' +
        '<div class="flex items-center gap-3 min-w-0">' +
          '<input value="' + U.escAttr(p.type) + '" onchange="Takeoff.setProductField(\'type\',this.value)" ' +
            'class="text-lg font-bold text-slate-800 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-400 outline-none px-1 min-w-[180px]">' +
          '<span class="px-2 py-0.5 bg-slate-100 rounded text-[10px] font-semibold text-slate-600 uppercase">' + U.esc(p.sow || '') + '</span>' +
        '</div>' +
        '<div class="font-mono text-lg font-bold text-slate-900">' + U.currency2(c.total) + '</div>' +
      '</div>' +
      '<div class="flex border-b border-slate-200 bg-slate-50">' +
        tabs.map(function (tb) {
          var on = state.tab === tb[0];
          return '<button onclick="Takeoff.setTab(\'' + tb[0] + '\')" class="px-5 py-3 text-xs font-semibold transition ' +
            (on ? 'text-blue-700 border-b-2 border-blue-600 bg-white' : 'text-slate-500 hover:text-slate-800') + '">' +
            '<i class="fas ' + tb[2] + ' mr-1.5"></i>' + tb[1] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="p-5">' +
        (state.tab === 'materials' ? renderMaterials(p, c) :
         state.tab === 'cost' ? renderCost(p, c) : renderGrid(p)) +
      '</div></div>';
  }

  function renderMaterials(p, c) {
    var g = currentGroup();
    var offCount = g.items.filter(function (it) { return !M.isItemOnProposal(it); }).length;
    var groupTabs = p.groups.map(function (gr) {
      var on = gr.id === g.id;
      var off = gr.items.filter(function (it) { return !M.isItemOnProposal(it); }).length;
      return '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + gr.id + '\')" ' +
        'class="px-3 py-1.5 rounded-lg text-xs font-medium transition ' +
        (on ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200') + '"' +
        (off ? ' title="' + off + ' row(s) hidden from the proposal"' : '') + '>' +
        U.esc(gr.name) + ' <span class="opacity-60">' + gr.items.length + '</span>' +
        (off ? '<span class="ml-1 opacity-60">&middot; ' + off + ' off</span>' : '') + '</button>';
    }).join('');

    /* No Options column. It held an abbreviated restatement of the Description
       ("8\" SCH 40" beside "Carbon Steel 8 SCH 40 PIPE A-500 GR B 8.625\" OD
       .322 Thk."), which meant typing the same specification twice and gave the
       proposal the shorter of the two to print. The Description is the one the
       client should read, so it is the one kept. */
    var head = ['Features', 'Vendor', 'Vendor Part No', 'Description', 'Qty',
      'U/M', 'Material', 'Grade', 'Weight (lb)', 'Unit Cost', 'Total Cost', ''];

    var rows = g.items.map(function (it, idx) {
      var q = M.itemQty(it, g);
      var err = M.itemQtyError(it, g);
      var flag = priceFlags[it.id];
      var isFormula = it.qtyMode === 'formula';
      return '<tr class="hover:bg-slate-50/60 align-top">' +
        '<td class="px-2 py-1 text-center">' + proposalCheckbox(
          'Takeoff.setItemOnProposal(\'' + it.id + '\',this.checked)',
          M.isItemOnProposal(it), false) + '</td>' +
        cell(it, 'feature', 'w-32') +
        cell(it, 'vendor', 'w-28') +
        comboCell(it, 'partNo', 'w-28', p.type) +
        comboCell(it, 'description', 'min-w-[240px]', p.type) +
        '<td class="px-1 py-1">' +
          (isFormula
            ? '<input value="' + U.escAttr(it.qtyExpr) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'qtyExpr\',this.value)" ' +
              'placeholder="ROUNDUP(TK(&quot;col&quot;)/21,0)+1" title="' + (err ? U.escAttr(err) : U.escAttr('= ' + U.qty(q))) + '" ' +
              'class="w-32 px-1.5 py-1 border rounded text-xs font-mono outline-none ' +
              (err ? 'border-red-300 bg-red-50 text-red-700' : 'border-emerald-300 bg-emerald-50') + '">'
            : '<input type="number" step="any" value="' + (it.qty == null ? '' : it.qty) + '" ' +
              'onchange="Takeoff.setItem(\'' + it.id + '\',\'qty\',this.value)" ' +
              'class="w-20 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400">') +
          '<button onclick="Takeoff.toggleQtyMode(\'' + it.id + '\')" title="' +
            (isFormula ? 'Switch back to a typed quantity' : 'Derive this quantity from the drawing takeoff grid') + '" ' +
            'class="ml-1 text-[10px] px-1 rounded ' + (isFormula ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-emerald-600') + '">fx</button>' +
          (isFormula && !err ? '<div class="text-[10px] text-emerald-700 font-mono mt-0.5">= ' + U.qty(q) + '</div>' : '') +
          (err ? '<div class="text-[10px] text-red-600 mt-0.5 max-w-[130px]">' + U.esc(err) + '</div>' : '') +
        '</td>' +
        '<td class="px-1 py-1"><input value="' + U.escAttr(it.um) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'um\',this.value)" class="w-14 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs outline-none focus:border-blue-400"></td>' +
        cell(it, 'material', 'w-28') +
        cell(it, 'grade', 'w-24') +
        '<td class="px-1 py-1"><input type="number" step="any" value="' + (it.weightLb == null ? '' : it.weightLb) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'weightLb\',this.value)" class="w-20 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400"></td>' +
        '<td class="px-1 py-1"><input type="number" step="any" value="' + (it.unitCost == null ? '' : it.unitCost) + '" onchange="Takeoff.setItem(\'' + it.id + '\',\'unitCost\',this.value)" class="w-24 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400">' +
          (flag ? '<div class="text-[10px] mt-0.5 ' + (flag.delta > 0 ? 'text-red-600' : 'text-emerald-600') + '" title="Was ' + U.currency2(flag.from) + '">' +
            (flag.delta > 0 ? '&#9650;' : '&#9660;') + ' ' + U.currency2(Math.abs(flag.delta || 0)) + '</div>' : '') +
        '</td>' +
        '<td class="px-2 py-1 text-right font-mono text-xs font-semibold text-slate-800 whitespace-nowrap" id="tot-' + it.id + '">' +
          U.currency2(M.itemTotal(it, g)) + '</td>' +
        '<td class="px-1 py-1 whitespace-nowrap">' +
          '<button onclick="Takeoff.moveItem(\'' + it.id + '\',-1)" class="w-5 h-5 text-slate-300 hover:text-slate-700 text-[10px]" title="Move up"' + (idx === 0 ? ' disabled' : '') + '><i class="fas fa-chevron-up"></i></button>' +
          '<button onclick="Takeoff.moveItem(\'' + it.id + '\',1)" class="w-5 h-5 text-slate-300 hover:text-slate-700 text-[10px]" title="Move down"' + (idx === g.items.length - 1 ? ' disabled' : '') + '><i class="fas fa-chevron-down"></i></button>' +
          '<button onclick="Takeoff.removeItem(\'' + it.id + '\')" class="w-5 h-5 text-slate-300 hover:text-red-600 text-[10px]" title="Delete row"><i class="fas fa-times"></i></button>' +
        '</td></tr>';
    }).join('');

    return '<div class="flex flex-wrap items-center gap-2 mb-4">' + groupTabs +
        '<button onclick="Takeoff.addGroup()" class="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-blue-600 border border-dashed border-slate-300" title="Add a component group"><i class="fas fa-plus"></i></button>' +
        (p.groups.length > 1 ? '<button onclick="Takeoff.removeGroup(\'' + g.id + '\')" class="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-600" title="Delete this group"><i class="fas fa-trash"></i></button>' : '') +
        '<button onclick="Takeoff.renameGroup(\'' + g.id + '\')" class="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-700" title="Rename group"><i class="fas fa-pen"></i></button>' +
      '</div>' +
      '<div class="overflow-x-auto border border-slate-200 rounded-lg">' +
      '<table class="w-full text-xs grid-table"><thead><tr>' +
        '<th class="px-2 py-2 w-8 text-center font-semibold text-slate-600" title="Show these rows on the bid proposal">' +
          '<input type="checkbox" ' + (offCount === 0 ? 'checked ' : '') +
          'onchange="Takeoff.setAllItemsOnProposal(this.checked)" class="cursor-pointer" ' +
          'title="Tick or untick every row in this group"></th>' +
        // The numeric columns right-align: Qty, and Weight through Total Cost.
        // Named rather than counted so removing a column cannot silently move
        // the alignment onto the wrong headings.
        head.map(function (h) {
          var right = ['Qty', 'Weight (lb)', 'Unit Cost', 'Total Cost'].indexOf(h) >= 0;
          return '<th class="px-2 py-2 ' + (right ? 'text-right' : 'text-left') +
            ' font-semibold text-slate-600 uppercase text-[10px] tracking-wider whitespace-nowrap">' + h + '</th>';
        }).join('') +
      // The proposal tick box, plus every heading.
      '</tr></thead><tbody id="matBody">' + (rows ||
        '<tr><td colspan="' + (head.length + 1) + '" class="px-3 py-8 text-center text-slate-400">No material rows yet.</td></tr>') +
      '</tbody><tfoot class="bg-slate-50 border-t-2 border-slate-300"><tr>' +
        // Everything up to Total Cost, which carries the figure, then the
        // row-controls column.
        '<td colspan="' + (head.length - 1) + '" class="px-2 py-2.5 text-right font-bold text-slate-700 uppercase text-[10px] tracking-wider">Material Cost</td>' +
        '<td class="px-2 py-2.5 text-right font-mono font-bold text-slate-900" id="matCost">' + U.currency2(c.materialCost) + '</td><td></td>' +
      '</tr></tfoot></table></div>' +
      '<button onclick="Takeoff.addItem()" class="mt-3 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add material row</button>' +
      '<div class="mt-3 text-[11px] text-slate-400 space-y-1">' +
        '<p>Start typing in <strong>Vendor Part No</strong> or <strong>Description</strong> to pull a part from the rate library. New parts are added to it automatically when you save.</p>' +
        '<p><i class="fas fa-file-contract mr-1"></i>Untick a row to keep it in the cost but leave it off the bid proposal.</p>' +
      '</div>';
  }

  function cell(it, field, w) {
    return '<td class="px-1 py-1"><input value="' + U.escAttr(it[field]) + '" ' +
      'onchange="Takeoff.setItem(\'' + it.id + '\',\'' + field + '\',this.value)" ' +
      'class="' + w + ' px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs outline-none focus:border-blue-400"></td>';
  }

  function comboCell(it, field, w, ptype) {
    return '<td class="px-1 py-1 relative"><input value="' + U.escAttr(it[field]) + '" ' +
      'autocomplete="off" data-item="' + it.id + '" data-field="' + field + '" data-ptype="' + U.escAttr(ptype) + '" ' +
      'oninput="Takeoff.combo(this)" onfocus="Takeoff.combo(this)" onblur="Takeoff.comboBlur(this)" ' +
      'onkeydown="Takeoff.comboKey(event,this)" ' +
      'onchange="Takeoff.setItem(\'' + it.id + '\',\'' + field + '\',this.value)" ' +
      'class="' + w + ' px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs outline-none focus:border-blue-400"></td>';
  }

  /* ---- combobox -------------------------------------------------------- */

  var comboBox = null, comboIndex = -1, comboHits = [];

  function combo(input) {
    var q = input.value;
    var ptype = input.getAttribute('data-ptype');
    comboHits = root.Catalog.suggest(q, ptype, 8);
    if (!comboHits.length) { comboClose(); return; }
    comboIndex = -1;

    if (!comboBox) {
      comboBox = document.createElement('div');
      comboBox.className = 'fixed z-50 bg-white border border-slate-300 rounded-lg shadow-2xl overflow-hidden text-xs';
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
        'class="combo-row px-3 py-2 cursor-pointer border-b border-slate-100 last:border-0 hover:bg-blue-50">' +
        '<div class="flex items-center gap-2">' +
          '<span class="font-semibold text-slate-800 truncate flex-1">' + U.esc(c.feature || c.description) + '</span>' +
          (c.unitCost != null ? '<span class="font-mono text-slate-700 whitespace-nowrap">' + U.currency2(c.unitCost) + '</span>' : '') +
        '</div>' +
        '<div class="text-[10px] text-slate-500 truncate">' +
          U.esc(c.vendor) + (c.partNo ? ' &middot; ' + U.esc(c.partNo) : '') + ' &middot; ' + U.esc(c.um) +
          (h.onType ? ' <span class="text-blue-600 font-semibold">&middot; used here</span>' : '') +
          (c.source === 'learned' ? ' <span class="text-emerald-600">&middot; learned</span>' : '') +
        '</div>' +
        '<div class="text-[10px] text-slate-400 truncate">' + U.esc(c.description) + '</div></div>';
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
        el.classList.toggle('bg-blue-50', i === comboIndex);
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
      '<div><label class="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">' + lfLabel + '</label>' +
        '<input type="number" step="any" value="' + (p.totalLF == null ? '' : p.totalLF) + '" ' +
        'onchange="Takeoff.setTotalLF(this.value)" class="w-36 px-3 py-2 bg-white border-2 border-blue-300 rounded-lg text-sm text-right font-mono font-bold outline-none focus:border-blue-500"></div>' +
      '<div><label class="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Material</label>' +
        '<input value="' + U.escAttr(p.material) + '" onchange="Takeoff.setProductField(\'material\',this.value)" class="w-44 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400"></div>' +
      '<button onclick="Takeoff.resetAllOverrides()" class="px-3 py-2 text-xs text-slate-500 hover:text-blue-700 underline">Reset all to formula</button>' +
      '</div>' +
      hiddenRowsBar(p) +
      '<div class="overflow-x-auto border border-slate-200 rounded-lg"><table class="w-full text-xs grid-table">' +
      '<thead><tr>' +
        '<th class="px-2 py-2 w-8 text-center font-semibold text-slate-600" title="Show this line on the bid proposal">' +
          '<i class="fas fa-file-contract text-[10px]"></i></th>' +
        ['Description', 'Qty', 'U/M', 'Unit Price', 'Total'].map(function (h, i) {
          return '<th class="px-3 py-2 ' + (i >= 1 ? 'text-right' : 'text-left') +
            ' font-semibold text-slate-600 uppercase text-[10px] tracking-wider">' + h + '</th>';
        }).join('') +
        '<th class="px-2 py-2 w-16"></th></tr></thead><tbody>' +
      M.COST_ROWS.filter(function (def) { return !M.isRowHidden(p, def.id); })
        .map(function (def) { return costRow(p, def, c); }).join('') +
      (p.extras || []).map(function (e, i) {
        return '<tr class="bg-amber-50/40">' +
          '<td class="px-2 py-1.5 text-center">' + proposalCheckbox(
            'Takeoff.setExtra(' + i + ',\'showInProposal\',this.checked)',
            e.showInProposal !== false, false) + '</td>' +
          '<td class="px-3 py-1.5"><input value="' + U.escAttr(e.label) + '" onchange="Takeoff.setExtra(' + i + ',\'label\',this.value)" class="w-full px-1.5 py-1 bg-white border border-amber-200 rounded text-xs outline-none"></td>' +
          '<td colspan="3" class="px-3 py-1.5 text-right"><input type="number" step="any" value="' + (e.amount == null ? '' : e.amount) + '" onchange="Takeoff.setExtra(' + i + ',\'amount\',this.value)" class="w-28 px-1.5 py-1 bg-white border border-amber-200 rounded text-xs text-right font-mono outline-none"></td>' +
          '<td class="px-3 py-1.5 text-right font-mono text-slate-800">' + U.currency2(e.amount) + '</td>' +
          '<td class="px-2 text-center"><button onclick="Takeoff.removeExtra(' + i + ')" class="text-slate-300 hover:text-red-600 text-[10px]" title="Delete this charge"><i class="fas fa-times"></i></button></td></tr>';
      }).join('') +
      '<tr class="border-t-2 border-slate-300 bg-slate-50"><td></td><td class="px-3 py-2.5 font-bold text-slate-700">Material + Engg + Fab + Install Cost</td>' +
        '<td colspan="3" class="px-3 py-2.5 text-right text-[10px] text-slate-500">Material ' + U.currency2(c.materialCost) + '</td>' +
        '<td class="px-3 py-2.5 text-right font-mono font-bold text-slate-900">' + U.currency2(c.subtotal) + '</td><td></td></tr>' +
      pctRow('Overall Mark ups + Margine', 'markupPct', p.markupPct, c.markup) +
      pctRow('Overhead &amp; Profit', 'overheadPct', p.overheadPct, c.overhead) +
      '<tr class="border-t-2 border-slate-800 bg-slate-100"><td></td><td class="px-3 py-3 font-bold text-slate-900 uppercase tracking-wider">Total Cost</td>' +
        '<td colspan="3"></td><td class="px-3 py-3 text-right font-mono text-base font-bold text-slate-900">' + U.currency2(c.total) + '</td><td></td></tr>' +
      '</tbody></table></div>' +
      '<button onclick="Takeoff.addExtra()" class="mt-3 px-4 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add other charge</button>' +
      '<div class="mt-3 text-[11px] text-slate-400 space-y-1">' +
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
    return '<div class="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg">' +
      '<span class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">' +
        hidden.length + ' row' + (hidden.length > 1 ? 's' : '') + ' removed</span>' +
      hidden.map(function (d) {
        return '<button onclick="Takeoff.restoreRow(\'' + d.id + '\')" ' +
          'class="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] text-slate-700 hover:border-blue-400 hover:text-blue-700" ' +
          'title="Put this row back with its values">' +
          '<i class="fas fa-rotate-left mr-1 text-[9px]"></i>' + U.esc(M.rowLabel(p, d.id)) + '</button>';
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
      return '<div class="flex items-stretch rounded border border-transparent hover:border-slate-200 focus-within:border-blue-400 overflow-hidden">' +
        '<span class="px-1.5 py-1 bg-slate-100 text-slate-500 text-xs font-semibold whitespace-nowrap select-none border-r border-slate-200" ' +
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
        'class="flex-1 min-w-0 px-1.5 py-1 border rounded text-xs outline-none focus:border-blue-400 ' +
        (labelChanged ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-transparent border-transparent hover:border-slate-200') + '">' +
      (labelChanged
        ? '<button onclick="Takeoff.resetRowLabel(\'' + def.id + '\')" title="Restore the default description" ' +
          'class="text-amber-600 hover:text-amber-800 text-[11px] shrink-0"><i class="fas fa-undo"></i></button>'
        : '') +
    '</div>';
  }

  function costRow(p, def, c) {
    var qtyPath = def.qtyPath, ratePath = def.ratePath;
    var qty = M.pathGet(p, qtyPath);
    var rate = M.pathGet(p, ratePath);
    var um = def.umPath ? M.pathGet(p, def.umPath) : def.um;
    var total = c[def.totalKey];
    var derived = def.derived;
    var overridden = derived && !!p.overrides[qtyPath];
    var formulaVal = derived ? M.derivedValue(p, qtyPath, takeoff()) : null;

    var label = M.rowLabel(p, def.id);
    var labelChanged = label !== M.defaultRowLabel(p, def.id);
    var confirming = pendingDelete === def.id;

    return '<tr class="' + (confirming ? 'bg-amber-50' : 'hover:bg-slate-50/50') + '">' +
      '<td class="px-2 py-1.5 text-center">' + proposalCheckbox(
        'Takeoff.setRowOnProposal(\'' + def.id + '\',this.checked)',
        M.isRowOnProposal(p, def.id), false) + '</td>' +
      '<td class="px-3 py-1.5">' + labelCell(p, def, label, labelChanged) + '</td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="any" value="' + (qty == null ? '' : qty) + '" ' +
        'onchange="Takeoff.setCost(\'' + qtyPath + '\',this.value)" ' +
        'class="w-24 px-1.5 py-1 border rounded text-xs text-right font-mono outline-none focus:border-blue-400 ' +
        (overridden ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-slate-50 border-slate-200') + '"' +
        (derived && formulaVal != null ? ' title="Formula value: ' + U.qty(formulaVal) + '"' : '') + '></td>' +
      '<td class="px-3 py-1.5 text-right text-slate-500">' + U.esc(um) + '</td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="any" value="' + (rate == null ? '' : rate) + '" ' +
        'onchange="Takeoff.setCost(\'' + ratePath + '\',this.value)" ' +
        'class="w-24 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400"></td>' +
      '<td class="px-3 py-1.5 text-right font-mono text-slate-800">' + U.currency2(total) + '</td>' +
      '<td class="px-2 py-1.5 text-center whitespace-nowrap">' +
        (overridden
          ? '<button onclick="Takeoff.clearOverride(\'' + qtyPath + '\')" title="Restore the formula value (' + U.qty(formulaVal) + ')" class="text-amber-600 hover:text-amber-800 text-[11px] mr-1"><i class="fas fa-undo"></i></button>'
          : '') +
        // Step one of two: an inline confirm, so a stray click on a small icon
        // cannot pull a line out of the estimate.
        (confirming
          ? '<span class="inline-flex items-center gap-1">' +
              '<button onclick="Takeoff.confirmRemoveRow(\'' + def.id + '\')" class="px-1.5 py-0.5 bg-red-600 hover:bg-red-500 text-white rounded text-[10px] font-semibold">Remove?</button>' +
              '<button onclick="Takeoff.cancelRemoveRow()" class="px-1 text-slate-400 hover:text-slate-700 text-[10px]">Cancel</button>' +
            '</span>'
          : '<button onclick="Takeoff.askRemoveRow(\'' + def.id + '\')" title="Remove this line from the cost" class="text-slate-300 hover:text-red-600 text-[11px]"><i class="fas fa-times"></i></button>') +
      '</td></tr>';
  }

  function pctRow(label, field, value, total) {
    return '<tr><td></td><td class="px-3 py-1.5 text-slate-700">' + label + '</td>' +
      '<td class="px-3 py-1.5 text-right"><input type="number" step="0.1" value="' + (value == null ? '' : value) + '" ' +
        'onchange="Takeoff.setProductNum(\'' + field + '\',this.value)" class="w-20 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400"></td>' +
      '<td class="px-3 py-1.5 text-right text-slate-500">%</td><td></td>' +
      '<td class="px-3 py-1.5 text-right font-mono text-slate-800">' + U.currency2(total) + '</td><td></td></tr>';
  }

  /* ---- drawing grid ---------------------------------------------------- */

  function renderGrid(p) {
    var g = currentGroup();
    var subs = M.gridSubtotals(g);
    var groupTabs = p.groups.map(function (gr) {
      var on = gr.id === g.id;
      return '<button onclick="Takeoff.selectGroup(\'' + p.id + '\',\'' + gr.id + '\')" class="px-3 py-1.5 rounded-lg text-xs font-medium ' +
        (on ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200') + '">' + U.esc(gr.name) + '</button>';
    }).join('');

    var cols = g.grid.columns;
    return '<div class="flex flex-wrap items-center gap-2 mb-4">' + groupTabs + '</div>' +
      '<div class="overflow-x-auto border border-slate-200 rounded-lg"><table class="w-full text-xs grid-table">' +
      '<thead><tr>' +
        '<th class="px-2 py-2 text-left font-semibold text-slate-600 uppercase text-[10px] tracking-wider sticky left-0 bg-slate-50">Drawing Ref. No</th>' +
        // Column headings carry long labels like 'Top Rail_1-1/2" Pipe (LF)'.
        // They used to be nowrap in a 110px cell, so they ran over their
        // neighbours; now they wrap and the delete only appears on hover.
        cols.map(function (col) {
          return '<th class="group px-2 py-2 align-bottom text-right font-semibold text-slate-600 text-[10px] min-w-[150px]">' +
            '<div class="flex items-start gap-1">' +
              '<textarea rows="2" onchange="Takeoff.setColLabel(\'' + col.key + '\',this.value)" ' +
                'title="' + U.escAttr(col.label) + '" ' +
                'class="flex-1 min-w-0 px-1 py-0.5 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 ' +
                'text-right text-[10px] font-semibold outline-none resize-none leading-tight">' +
                U.esc(col.label) + '</textarea>' +
              '<button onclick="Takeoff.removeCol(\'' + col.key + '\')" title="Delete this column" ' +
                'class="opacity-0 group-hover:opacity-100 transition text-[10px] text-slate-300 hover:text-red-600 shrink-0">' +
                '<i class="fas fa-times"></i></button>' +
            '</div></th>';
        }).join('') +
        '<th class="px-2 py-2 w-8"><button onclick="Takeoff.addCol()" class="text-slate-400 hover:text-blue-600" title="Add column"><i class="fas fa-plus"></i></button></th>' +
      '</tr></thead><tbody>' +
      (g.grid.rows.length ? g.grid.rows.map(function (row, ri) {
        return '<tr class="border-t border-slate-100 hover:bg-slate-50/60">' +
          '<td class="px-2 py-1 sticky left-0 bg-white"><input value="' + U.escAttr(row.ref) + '" onchange="Takeoff.setRowRef(' + ri + ',this.value)" ' +
            'placeholder="2/A-101" class="w-28 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs outline-none focus:border-blue-400"></td>' +
          cols.map(function (col) {
            return '<td class="px-1 py-1"><input type="number" step="any" value="' + (row.values[col.key] == null ? '' : row.values[col.key]) + '" ' +
              'onchange="Takeoff.setCellValue(' + ri + ',\'' + col.key + '\',this.value)" ' +
              'class="w-full px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-xs text-right font-mono outline-none focus:border-blue-400"></td>';
          }).join('') +
          '<td class="px-1"><button onclick="Takeoff.removeRow(' + ri + ')" class="text-slate-300 hover:text-red-600 text-[10px]"><i class="fas fa-times"></i></button></td></tr>';
      }).join('') : '<tr><td colspan="' + (cols.length + 2) + '" class="px-3 py-8 text-center text-slate-400">No drawing references yet.</td></tr>') +
      '</tbody><tfoot class="bg-slate-50 border-t-2 border-slate-300"><tr>' +
        '<td class="px-2 py-2.5 font-bold text-slate-700 uppercase text-[10px] tracking-wider sticky left-0 bg-slate-50">Sub Total</td>' +
        cols.map(function (col) {
          return '<td class="px-2 py-2.5 text-right font-mono font-bold text-slate-900">' + U.qty(subs[col.key]) + '</td>';
        }).join('') + '<td></td></tr></tfoot></table></div>' +
      '<button onclick="Takeoff.addRow()" class="mt-3 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1.5"></i>Add drawing reference</button>' +
      '<p class="mt-3 text-[11px] text-slate-400">Column subtotals can drive material quantities: switch a Qty to <code class="bg-slate-100 px-1 rounded">fx</code> mode and reference one with <code class="bg-slate-100 px-1 rounded">TK("column name")</code>.</p>';
  }

  /* Cheap partial refresh so typing in a qty cell does not rebuild the table
     and steal focus. */
  function updateTotals() {
    var p = product(), g = currentGroup();
    if (!p || !g) return;
    g.items.forEach(function (it) {
      var el = U.$('tot-' + it.id);
      if (el) el.textContent = U.currency2(M.itemTotal(it, g));
    });
    var mc = U.$('matCost');
    if (mc) mc.textContent = U.currency2(M.computeProduct(p).materialCost);
  }

  /* ---- XLSX export ------------------------------------------------------ */

  /* One product as a sheet: its materials, the cost and labour rows beneath
     them, and the drawing grid each group was measured from. Built as an array
     of arrays so the layout matches the workbook the estimators already know.

     Column count is fixed by the header, and the labour rows below pad to it by
     hand, so COLS is the one number to change if a column ever moves. */
  var SHEET_COLS = ['Features', 'Vendor', 'Vendor Part No', 'Desription', 'Qty', 'U/M',
    'Material', 'Grade', 'Weight (lb)', 'Unit Cost', 'Total Cost'];

  /* A labour, equipment or finish line: a label, then the quantity and rate in
     the columns the material rows use for them. */
  function costLine(label, qty, um, rate, total) {
    var row = new Array(SHEET_COLS.length).fill('');
    row[0] = label;
    row[4] = qty;
    row[5] = um;
    row[SHEET_COLS.length - 2] = rate;
    row[SHEET_COLS.length - 1] = total;
    return row;
  }

  function productSheet(p) {
    var c = M.computeProduct(p);
    var aoa = [SHEET_COLS.slice(), ['SOW', p.sow], ['Material', p.material], []];

    p.groups.forEach(function (g) {
      if (p.groups.length > 1) aoa.push([g.name]);
      g.items.forEach(function (it) {
        aoa.push([it.feature, it.vendor, it.partNo, it.description,
          M.itemQty(it, g), it.um, it.material, it.grade, it.weightLb, it.unitCost,
          M.itemTotal(it, g)]);
      });
      aoa.push([]);
    });

    aoa.push(['Material Cost', c.materialCost], []);
    aoa.push([p.unit === 'EA' ? 'Total Qty' : 'Total linear feet', p.totalLF], []);
    // Via rowLabel so the exported sheet carries the "Finish - " prefix too,
    // rather than being the one place it goes missing.
    aoa.push(costLine(M.rowLabel(p, 'finish'), p.finish.qty, p.finish.um, p.finish.unitCost, c.finishTotal));
    aoa.push(costLine('Engineering cost', p.labour.engineering.hrs, 'Hrs', p.labour.engineering.rate, c.engTotal));
    aoa.push(costLine('Fabrication cost', p.labour.fabrication.hrs, 'Hrs', p.labour.fabrication.rate, c.fabTotal));
    aoa.push(costLine('Installtion cost', p.labour.installation.hrs, 'Hrs', p.labour.installation.rate, c.instTotal));
    aoa.push(costLine('Supervisor', p.labour.supervisor.hrs, 'Hrs', p.labour.supervisor.rate, c.supTotal));
    aoa.push(costLine('Forklift', p.equipment.forklift.days, 'Days', p.equipment.forklift.rate, c.forkTotal));
    aoa.push(costLine('Truck for Transport', p.equipment.truck.days, 'Days', p.equipment.truck.rate, c.truckTotal));
    (p.extras || []).forEach(function (e) {
      aoa.push(costLine(e.label, '', '', '', e.amount));
    });
    aoa.push(costLine('Material+Engg+Fab+Install Cost', '', '', '', c.subtotal));
    aoa.push([]);
    aoa.push(['Overall Mark ups + Margine (' + p.markupPct + '%)', c.markup]);
    aoa.push(['Overhead & Profit (' + p.overheadPct + '%)', c.overhead]);
    aoa.push(['Total Cost', c.total]);
    aoa.push([]);

    p.groups.forEach(function (g) {
      aoa.push([g.name]);
      aoa.push(['Drawing Ref. No'].concat(g.grid.columns.map(function (col) { return col.label; })));
      g.grid.rows.forEach(function (r) {
        aoa.push([r.ref].concat(g.grid.columns.map(function (col) { return r.values[col.key]; })));
      });
      var subs = M.gridSubtotals(g);
      aoa.push(['Sub Total'].concat(g.grid.columns.map(function (col) { return subs[col.key]; })));
      aoa.push([]);
    });

    return aoa;
  }

  /* The front sheet: the same Project Cost Summary the left rail shows, so the
     workbook opens on the number somebody is looking for rather than on the
     first product's materials. */
  function summarySheet(t, roll) {
    var bid = t.bidId ? db().bids.filter(function (b) { return b.id === t.bidId; })[0] : null;
    var r = t.rollup || {};
    var aoa = [
      ['Project', t.project.name || ''],
      ['Proposal No', (bid && bid.proposalNo) || t.project.proposalNo || ''],
      ['Job No', (bid && bid.awardNo) || ''],
      ['Location', t.project.location || ''],
      ['Exported', U.today()],
      [],
      ['Product', 'Qty / LF', 'Unit', 'Total Cost']
    ];
    roll.products.forEach(function (x) {
      aoa.push([x.product.type, x.product.totalLF, x.product.unit, x.calc.total]);
    });
    aoa.push([]);
    aoa.push(['Project Base Cost', '', '', roll.base]);
    aoa.push(['Miscellaneous (' + U.n(r.miscPct) + '%)', '', '', roll.misc]);
    aoa.push(['Delivery & Freight', '', '', roll.freight]);
    aoa.push(['Tax (' + U.n(r.taxPct) + '%)', '', '', roll.tax]);
    aoa.push(['Roundoff', '', '', roll.roundoff]);
    aoa.push(['Total Bid Cost', '', '', roll.total]);
    return aoa;
  }

  /* Excel refuses a sheet name over 31 characters or one that repeats, and it
     throws rather than renaming - so two products both called "Steel Guardrail
     (Interior Stairwell)" would fail the whole export. */
  function sheetNamer() {
    var used = {};
    return function (name) {
      var base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet';
      var out = base, n = 2;
      while (used[out.toLowerCase()]) {
        var suffix = ' (' + n++ + ')';
        out = base.slice(0, 31 - suffix.length) + suffix;
      }
      used[out.toLowerCase()] = true;
      return out;
    };
  }

  function exportProduct(pid) {
    var t = takeoff();
    var p = t.products.filter(function (x) { return x.id === pid; })[0];
    if (!p || !root.XLSX) { U.toast('Export unavailable.', 'err'); return; }
    var wb = root.XLSX.utils.book_new();
    root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.aoa_to_sheet(productSheet(p)),
      sheetNamer()(p.type));
    root.XLSX.writeFile(wb, filename(t) + ' - ' + p.type + '.xlsx');
  }

  /* The whole takeoff: a summary, then a sheet per product. */
  function exportWorkbook() {
    var t = takeoff();
    if (!t) return;
    if (!root.XLSX) { U.toast('XLSX library did not load.', 'err'); return; }
    if (!t.products.length) { U.toast('Nothing to export yet - add a product first.', 'warn'); return; }

    var X = root.XLSX;
    var wb = X.utils.book_new();
    var name = sheetNamer();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(summarySheet(t, M.computeTakeoff(t))),
      name('Summary'));
    t.products.forEach(function (p) {
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(productSheet(p)), name(p.type));
    });
    X.writeFile(wb, filename(t) + ' - Takeoff.xlsx');
    U.toast('Exported ' + t.products.length + ' product sheet' +
      (t.products.length === 1 ? '' : 's') + '.', 'ok');
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
    productSheet: productSheet,

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
      var g = currentGroup();
      var it = g.items.filter(function (x) { return x.id === itemId; })[0];
      it.qtyMode = it.qtyMode === 'formula' ? 'manual' : 'formula';
      save();
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
      p.extras.push({ id: root.Store.uid('x'), label: 'Other charge', amount: null });
      save();
    },
    setExtra: function (i, f, v) {
      var p = product();
      p.extras[i][f] = f === 'amount' ? (v === '' ? null : Number(v))
        : f === 'showInProposal' ? !!v : v;
      save();
    },
    removeExtra: function (i) { product().extras.splice(i, 1); save(); },

    addCol: function () {
      var label = prompt('Column heading (include the unit, e.g. \'Top Rail 1-1/2" Pipe (LF)\'):', '');
      if (label == null || !label.trim()) return;
      currentGroup().grid.columns.push({ key: root.Store.uid('col'), label: label.trim() });
      save();
    },
    removeCol: function (key) {
      var g = currentGroup();
      var col = g.grid.columns.filter(function (c) { return c.key === key; })[0];
      if (!confirm('Delete column "' + col.label + '" and its values?')) return;
      g.grid.columns = g.grid.columns.filter(function (c) { return c.key !== key; });
      g.grid.rows.forEach(function (r) { delete r.values[key]; });
      save();
    },
    setColLabel: function (key, v) {
      var col = currentGroup().grid.columns.filter(function (c) { return c.key === key; })[0];
      col.label = v;
      save();
    },
    addRow: function () {
      currentGroup().grid.rows.push({ ref: '', values: {} });
      save();
    },
    removeRow: function (i) { currentGroup().grid.rows.splice(i, 1); save(); },
    setRowRef: function (i, v) { currentGroup().grid.rows[i].ref = v; root.Store.save(); },
    setCellValue: function (i, key, v) {
      currentGroup().grid.rows[i].values[key] = v === '' ? null : Number(v);
      save();
    },
  };

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('[id^="menu-"]')) {
      document.querySelectorAll('[id^="menu-"]').forEach(function (m) { m.classList.add('hidden'); });
    }
  });
  window.addEventListener('scroll', comboClose, true);
})(window);
