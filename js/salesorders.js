/* salesorders.js - Production Manager > Sales Orders.
 *
 * An awarded bid becomes a sales order when somebody takes it into production
 * - "Add to Production Manager" on the awarded project. The order is issued
 * the next number, SO-00001, and carries what the shop needs from there on:
 * who the customer is, where it ships and bills, the PO, the deposit, the
 * priority, the dates, and a line per product.
 *
 *   salesorder = {
 *     id, soNo, revision, bidId, proposalNo, project, createdAt, status,
 *     poNumber, generalContractor, projectDetails,
 *     shippingAddress, billingAddress, billingSame,
 *     projectCost, depositRequired, depositReceived, priority,
 *     desiredShipDate, targetDate, targetAuto,
 *     lines: [ { id, itemNo, revision, productType, qty, um, cost, joNo } ],
 *     notes, log: [...]   (js/reclog.js)
 *   }
 *
 * THE NUMBER is allocated here, the next after the highest in use - the way
 * project numbers are (js/bids.js nextProjectNo) and for the same reason: no
 * stored counter, so deleting an order never frees its number. Two browsers
 * allocating at the same moment is caught by the database's unique index, and
 * the second simply takes the next one - see Store.onDuplicate below.
 *
 * THE TARGETED DATE is a week before the desired ship date unless somebody
 * types another - the spreadsheet's "one week before". Typing one marks it
 * manual; "Back to auto" puts the rule back.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var STATUSES = [
    { key: 'Open', tone: 'info' },
    { key: 'In Production', tone: 'brand' },
    { key: 'Shipped', tone: 'ok' },
    { key: 'Closed', tone: 'neutral' }
  ];
  var PRIORITIES = ['Low', 'Medium', 'High'];
  var PRIORITY_TONE = { Low: 'neutral', Medium: 'warn', High: 'danger' };
  var STATUS_TONE = {};
  STATUSES.forEach(function (s) { STATUS_TONE[s.key] = s.tone; });

  /* What the history log records, and what it calls each field. */
  var FIELDS = [
    { key: 'project', label: 'Project' },
    { key: 'poNumber', label: 'PO Number' },
    { key: 'generalContractor', label: 'General Contractor' },
    { key: 'projectDetails', label: 'Project Details' },
    { key: 'shippingAddress', label: 'Shipping Address' },
    { key: 'billingAddress', label: 'Billing Address' },
    { key: 'projectCost', label: 'Project Cost', fmt: function (v) { return U.currency(v); } },
    { key: 'depositRequired', label: 'Deposit Required', fmt: function (v) { return U.currency(v); } },
    { key: 'depositReceived', label: 'Deposit Received', fmt: function (v) { return U.currency(v); } },
    { key: 'priority', label: 'Priority' },
    { key: 'desiredShipDate', label: 'Desired Ship Date', fmt: function (v) { return U.date(v); } },
    { key: 'targetDate', label: 'Targeted Date', fmt: function (v) { return U.date(v); } },
    { key: 'status', label: 'Status' },
    { key: 'revision', label: 'Revision' },
    { key: 'notes', label: 'Notes' }
  ];

  var state = { openId: null };

  function db() { return root.Store.db; }
  function orders() { return db().salesorders || (db().salesorders = []); }
  function byId(id) { return orders().filter(function (s) { return s.id === id; })[0] || null; }
  function forBid(bidId) {
    return orders().filter(function (s) { return String(s.bidId) === String(bidId); })[0] || null;
  }
  function bidById(id) { return db().bids.filter(function (b) { return b.id === id; })[0] || null; }
  function can() { return root.Auth.can('so.edit'); }

  /* ---- numbers and dates -------------------------------------------------- */

  function nextSoNo(exceptId) {
    var max = orders().reduce(function (m, s) {
      if (s.id === exceptId) return m;
      var hit = /^SO-(\d+)$/.exec(String(s.soNo || '').trim());
      return Math.max(m, hit ? Number(hit[1]) : 0);
    }, 0);
    return 'SO-' + String(max + 1).padStart(5, '0');
  }

  function targetFrom(shipISO) { return shipISO ? U.addDays(shipISO, -7) : ''; }

  function daysTo(iso) {
    if (!iso) return null;
    var a = U.parseDate(U.today()), b = U.parseDate(iso);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  /* Whole weeks to the desired ship date - the spreadsheet's "Weeks Left". */
  function weeksLeft(so) {
    var d = daysTo(so.desiredShipDate);
    return d == null ? null : Math.floor(d / 7);
  }

  function shipChip(so) {
    if (!so.desiredShipDate || so.status === 'Shipped' || so.status === 'Closed') return '';
    var d = daysTo(so.desiredShipDate);
    if (d < 0) return root.UI.badge('Overdue ' + (-d) + 'd', 'danger');
    var w = Math.floor(d / 7);
    if (d <= 14) return root.UI.badge(w <= 0 ? d + ' days left' : w + ' wk left', 'warn');
    return root.UI.badge(w + ' wks left', 'ok');
  }

  function depositOutstanding(so) {
    return Math.max(0, U.n(so.depositRequired) - U.n(so.depositReceived));
  }

  function linesTotal(so) {
    return (so.lines || []).reduce(function (t, l) { return t + U.n(l.cost); }, 0);
  }

  /* ---- from an awarded bid ------------------------------------------------ */

  /* A line per product. From the proposal when there is one - its scope items
     are what the client was quoted and they add up to the price - otherwise
     from the takeoff, otherwise just the products named on the bid. Quantity
     and unit come from the takeoff either way, because the proposal does not
     carry them. */
  function seedLines(bid) {
    var d = db();
    var t = bid.takeoffId ? d.takeoffs[bid.takeoffId] : null;
    var p = bid.proposalId ? d.proposals[bid.proposalId] : null;
    var roll = t && root.TakeoffModel ? root.TakeoffModel.computeTakeoff(t) : null;

    function measure(type) {
      var hit = roll && roll.products.filter(function (x) { return x.product.type === type; })[0];
      if (!hit) return { qty: null, um: '' };
      var pr = hit.product;
      var ea = pr.unit === 'EA';
      return { qty: ea ? (pr.totalQty || pr.totalLF || null) : (pr.totalLF || null), um: ea ? 'EA' : 'LF',
               cost: hit.calc.total };
    }

    var lines = [];
    if (p && (p.scopeItems || []).some(function (s) { return s.sourceType; })) {
      p.scopeItems.filter(function (s) { return s.sourceType; }).forEach(function (s) {
        var m = measure(s.sourceType);
        lines.push({ productType: s.sourceType, qty: m.qty, um: m.um, cost: U.n(s.cost) });
      });
    } else if (roll && roll.products.length) {
      roll.products.forEach(function (x) {
        var m = measure(x.product.type);
        lines.push({ productType: x.product.type, qty: m.qty, um: m.um, cost: Math.round(U.n(m.cost) * 100) / 100 });
      });
    } else {
      (bid.products || []).forEach(function (name) {
        lines.push({ productType: name, qty: null, um: '', cost: null });
      });
    }
    return lines.map(function (l, i) {
      return Object.assign({ id: root.Store.uid('sol'), itemNo: String(i + 1).padStart(3, '0'),
        revision: 0, joNo: '' }, l);
    });
  }

  var pending = null;     // the bid the dialog is about

  function promptFromBid(bidId) {
    var bid = bidById(bidId);
    if (!bid) return;
    if (!can()) { U.toast('Your role cannot create sales orders.', 'warn'); return; }
    var existing = forBid(bid.id);
    if (existing) { open(existing.id); return; }
    if (bid.status !== 'Awarded') { U.toast('Only an awarded bid can go into production.', 'warn'); return; }
    pending = bid.id;

    var cost = U.n(bid.price);
    var lines = seedLines(bid);
    U.$('soFrom').textContent = (bid.proposalNo ? bid.proposalNo + ' · ' : '') + (bid.project || '');
    U.$('soNumber').textContent = nextSoNo();
    U.wireDateField('soShip');
    U.$('soShip').value = '';
    U.$('soPo').value = '';
    U.$('soGc').value = '';
    U.$('soDeposit').value = cost ? String(Math.round(cost / 2)) : '';
    U.$('soDepositNote').textContent = cost ? '50% of ' + U.currency(cost) + ', per the proposal\'s payment terms' : '';
    U.$('soWarn').classList.add('hidden');
    U.$('soLines').innerHTML = lines.length
      ? lines.map(function (l) {
          return '<li class="flex items-center justify-between gap-3">' +
            '<span class="truncate"><span class="font-mono text-faint mr-2">' + l.itemNo + '</span>' + U.esc(l.productType) + '</span>' +
            '<span class="font-mono text-muted shrink-0">' +
              (l.qty != null ? U.qty(l.qty) + ' ' + U.esc(l.um) + ' · ' : '') + U.currency(l.cost) + '</span></li>';
        }).join('')
      : '<li class="text-faint">No products on this bid yet - lines can be added on the order.</li>';
    U.$('soModal').classList.remove('hidden');
    setTimeout(function () { U.$('soShip').focus(); }, 0);
  }

  function confirmFromBid() {
    var bid = bidById(pending);
    if (!bid) return;
    var shipRaw = String(U.$('soShip').value || '').trim();
    var ship = shipRaw ? U.inputToDate(shipRaw) : '';
    var warn = U.$('soWarn');
    if (shipRaw && !ship) { warn.textContent = 'Not a date. Use MM-DD-YYYY.'; warn.classList.remove('hidden'); return; }
    var deposit = String(U.$('soDeposit').value || '').trim();
    if (deposit && isNaN(Number(deposit))) { warn.textContent = 'The deposit has to be a number.'; warn.classList.remove('hidden'); return; }

    var so = createFromBid(bid, {
      desiredShipDate: ship || '',
      poNumber: String(U.$('soPo').value || '').trim(),
      generalContractor: String(U.$('soGc').value || '').trim(),
      depositRequired: deposit === '' ? null : Number(deposit)
    });
    U.$('soModal').classList.add('hidden');
    root.Store.save();
    if (root.Bids) root.Bids.refresh();
    U.toast(so.soNo + ' created. Fill in the addresses and PO on the order.', 'ok');
    open(so.id);
  }

  function createFromBid(bid, o) {
    o = o || {};
    var now = new Date().toISOString();
    var ship = o.desiredShipDate || '';
    var so = {
      id: root.Store.uid('so'),
      soNo: nextSoNo(),
      revision: 0,
      bidId: bid.id,
      proposalNo: bid.proposalNo || '',
      project: bid.project || '',
      createdAt: now,
      status: 'Open',
      poNumber: o.poNumber || '',
      generalContractor: o.generalContractor || '',
      projectDetails: bid.project || '',
      shippingAddress: bid.location || '',
      billingAddress: '',
      billingSame: true,
      projectCost: bid.price == null ? null : Number(bid.price),
      depositRequired: o.depositRequired == null ? null : o.depositRequired,
      depositReceived: null,
      priority: 'Medium',
      desiredShipDate: ship,
      targetDate: targetFrom(ship),
      targetAuto: true,
      lines: seedLines(bid),
      notes: '',
      log: []
    };
    root.RecLog.created(so, 'Created from ' + (bid.proposalNo || bid.project || 'the awarded bid') + '.');
    orders().push(so);
    bid.soId = so.id;
    root.History.record(bid, root.History.stageOf(bid), 'production', {
      fromStatus: bid.status, toStatus: bid.status,
      comment: 'Moved to Production Manager as ' + so.soNo + '.'
    });
    return so;
  }

  /* ---- writing ------------------------------------------------------------ */

  function save() {
    root.Store.save();
    render();
  }

  function edit(so, fn) {
    root.RecLog.track(so, FIELDS, fn);
    save();
  }

  /* The inline-edit saver - UI.registerSaver('salesorder', ...). */
  function saveField(id, field, raw, type, host) {
    var so = byId(id);
    if (!so) return;
    function refuse(msg) {
      if (host && host.dataset.original !== undefined) host.innerHTML = host.dataset.original;
      U.toast(msg, 'err');
    }
    var value = String(raw == null ? '' : raw).trim();
    if (type === 'date') {
      var iso = value ? U.inputToDate(value) : '';
      if (iso === null) { refuse('That date must be MM-DD-YYYY and a real date.'); return; }
      value = iso;
    } else if (type === 'number') {
      value = value === '' ? null : Number(value);
      if (value !== null && isNaN(value)) { refuse('That has to be a number.'); return; }
    }
    if (field === 'project' && !value) { refuse('A sales order needs a project name.'); return; }

    edit(so, function () {
      so[field] = value;
      if (field === 'desiredShipDate' && so.targetAuto) so.targetDate = targetFrom(value);
      if (field === 'targetDate') so.targetAuto = false;
      if (field === 'shippingAddress' && so.billingSame) so.billingAddress = '';
    });
  }

  function setLine(soId, lineId, field, raw) {
    var so = byId(soId);
    var line = so && (so.lines || []).filter(function (l) { return l.id === lineId; })[0];
    if (!line) { U.toast('That line has just been removed by someone else.', 'warn'); return; }
    var numeric = field === 'qty' || field === 'cost' || field === 'revision';
    var v = String(raw == null ? '' : raw).trim();
    if (numeric) {
      v = v === '' ? null : Number(v);
      if (v !== null && isNaN(v)) { U.toast('That has to be a number.', 'err'); render(); return; }
    }
    edit(so, function () { line[field] = v; });
  }

  function addLine(soId) {
    var so = byId(soId);
    if (!so) return;
    var next = (so.lines || []).reduce(function (m, l) { return Math.max(m, Number(l.itemNo) || 0); }, 0) + 1;
    so.lines = so.lines || [];
    so.lines.push({ id: root.Store.uid('sol'), itemNo: String(next).padStart(3, '0'), revision: 0,
      productType: '', qty: null, um: '', cost: null, joNo: '' });
    root.RecLog.event(so, 'Line ' + String(next).padStart(3, '0') + ' added.');
    save();
  }

  function removeLine(soId, lineId) {
    var so = byId(soId);
    var line = so && (so.lines || []).filter(function (l) { return l.id === lineId; })[0];
    if (!line) return;
    if (line.joNo) { U.toast('That line has a job order. Remove the job order first.', 'warn'); return; }
    if (!confirm('Remove line ' + line.itemNo + (line.productType ? ' (' + line.productType + ')' : '') + '?')) return;
    so.lines = so.lines.filter(function (l) { return l.id !== lineId; });
    root.RecLog.event(so, 'Line ' + line.itemNo + ' removed' + (line.productType ? ' (' + line.productType + ')' : '') + '.');
    save();
  }

  function setStatus(id, status) {
    var so = byId(id);
    if (!so || so.status === status) return;
    edit(so, function () { so.status = status; });
    U.toast(so.soNo + ' is now ' + status + '.', 'ok');
  }

  function revise(id) {
    var so = byId(id);
    if (!so) return;
    var why = prompt('Revise ' + so.soNo + ' to Rev ' + (U.n(so.revision) + 1) + '. What changed?');
    if (why === null) return;
    edit(so, function () { so.revision = U.n(so.revision) + 1; });
    root.RecLog.event(so, 'Revised to Rev ' + so.revision + (String(why).trim() ? ': ' + String(why).trim() : '.'));
    save();
  }

  function remove(id) {
    var so = byId(id);
    if (!so) return;
    if ((so.lines || []).some(function (l) { return l.joNo; })) {
      U.toast('This order has job orders. Remove them first.', 'warn');
      return;
    }
    if (!confirm('Delete ' + so.soNo + ' (' + (so.project || 'no project') + ')?\n\n' +
      'The awarded bid stays as it is and can be added to Production Manager again.')) return;
    var bid = bidById(so.bidId);
    if (bid && bid.soId === so.id) {
      delete bid.soId;
      root.History.record(bid, root.History.stageOf(bid), 'production', {
        fromStatus: bid.status, toStatus: bid.status, comment: so.soNo + ' was deleted.'
      });
    }
    db().salesorders = orders().filter(function (s) { return s.id !== id; });
    state.openId = null;
    save();
    if (root.Bids) root.Bids.refresh();
    U.toast(so.soNo + ' deleted.', 'ok');
  }

  /* ---- navigation --------------------------------------------------------- */

  function open(id) {
    state.openId = id;
    db().ui.prodOpen = { section: 'salesorders', id: id };
    root.Store.save();
    if (root.App.currentTab !== 'salesorders') root.App.switchTab('salesorders');
    else render();
    if (root.Presence) {
      var so = byId(id);
      if (so) root.Presence.here('so:' + so.id, 'salesorder');
    }
    // A record opens at its top, not wherever the list was scrolled to.
    if (root.scrollY) root.scrollTo(0, 0);
  }

  function back() {
    state.openId = null;
    db().ui.prodOpen = null;
    root.Store.save();
    render();
    if (root.Presence) root.Presence.here(null, 'salesorders');
  }

  function openBid(bidId) {
    var bid = bidById(Number(bidId));
    if (!bid) { U.toast('That bid is no longer on file.', 'warn'); return; }
    root.Project.openFrom(bid.id, 'awarded');
  }

  /* ---- the list ------------------------------------------------------------ */

  var COLUMNS = [
    { key: 'createdAt', label: 'Created', type: 'date', width: 'w-28',
      value: function (s) { return String(s.createdAt || '').slice(0, 10); } },
    { key: 'soNo', label: 'Sales Order', locked: true, width: 'w-32',
      render: function (s) { return '<span class="font-mono">' + U.esc(s.soNo) + '</span>' +
        (U.n(s.revision) ? ' <span class="text-3xs text-faint">Rev ' + U.n(s.revision) + '</span>' : ''); } },
    { key: 'proposalNo', label: 'Proposal No', width: 'w-32',
      render: function (s) { return '<span class="font-mono text-muted">' + U.esc(s.proposalNo || '—') + '</span>'; } },
    { key: 'project', label: 'Project Name', locked: true,
      render: function (s) { return '<span class="font-semibold text-ink-strong">' + U.esc(s.project || '—') + '</span>'; } },
    { key: 'poNumber', label: 'PO Number' },
    { key: 'generalContractor', label: 'General Contractor' },
    { key: 'desiredShipDate', label: 'Ship Date', type: 'date' },
    { key: 'weeksLeft', label: 'Weeks Left', type: 'number', align: 'right',
      value: function (s) { return s.status === 'Shipped' || s.status === 'Closed' ? null : weeksLeft(s); },
      render: function (s) { return shipChip(s) || '<span class="text-faint">&mdash;</span>'; } },
    { key: 'priority', label: 'Priority', align: 'center',
      value: function (s) { return PRIORITIES.indexOf(s.priority); },
      render: function (s) { return root.UI.badge(s.priority || '—', PRIORITY_TONE[s.priority] || 'neutral'); } },
    { key: 'projectCost', label: 'Value', type: 'money', align: 'right' },
    { key: 'deposit', label: 'Deposit', align: 'right', type: 'money',
      value: function (s) { return depositOutstanding(s); },
      render: function (s) {
        if (!U.n(s.depositRequired)) return '<span class="text-faint">&mdash;</span>';
        var out = depositOutstanding(s);
        return out ? '<span class="text-warn-ink">' + U.currency(out) + ' due</span>'
          : '<span class="text-ok-ink"><i class="fas fa-check mr-1"></i>Received</span>';
      } },
    { key: 'status', label: 'Status', align: 'center',
      render: function (s) { return root.UI.badge(s.status || 'Open', STATUS_TONE[s.status] || 'info'); } }
  ];

  function defineGrid() {
    root.DataGrid.define('so', {
      host: 'soGridHost',
      noun: 'sales order',
      columns: COLUMNS,
      rows: orders,
      search: function (s) {
        return [s.soNo, s.proposalNo, s.project, s.poNumber, s.generalContractor,
          (s.lines || []).map(function (l) { return l.productType + ' ' + l.joNo; }).join(' ')].join(' ');
      },
      chips: STATUSES.map(function (st) {
        return { value: st.key, label: st.key, test: function (s) { return (s.status || 'Open') === st.key; } };
      }),
      open: 'SalesOrders.open',
      openKey: 'soNo',
      menu: 'SalesOrders.rowMenu',
      footer: function (rows) {
        return U.currency(rows.reduce(function (t, s) { return t + U.n(s.projectCost); }, 0)) + ' in view';
      },
      empty: {
        icon: 'fa-file-invoice-dollar',
        title: 'No sales orders yet',
        blurb: 'An awarded bid becomes a sales order with "Add to Production Manager" on its project page, or from the Awarded Bids row menu.',
        action: root.UI.btn({ label: 'Go to Awarded Bids', icon: 'fa-trophy', onclick: 'App.switchTab(\'awarded\')' })
      }
    });
  }

  function rowMenu(ev, id) {
    var so = byId(id);
    if (!so) return;
    var G = root.BidGrid;
    var out = [G.menuItem({ icon: 'fa-folder-open', label: 'Open ' + so.soNo, onclick: 'SalesOrders.open(\'' + so.id + '\')' })];
    if (so.bidId != null) {
      out.push(G.menuItem({ icon: 'fa-trophy', label: 'Open the awarded bid', onclick: 'SalesOrders.openBid(' + so.bidId + ')' }));
    }
    if (can()) {
      out.push(G.menuSeparator());
      STATUSES.forEach(function (st) {
        if (st.key !== so.status) {
          out.push(G.menuItem({ icon: 'fa-arrow-right', label: 'Mark ' + st.key,
            onclick: 'SalesOrders.setStatus(\'' + so.id + '\',\'' + st.key + '\')' }));
        }
      });
      out.push(G.menuSeparator());
      out.push(G.menuItem({ icon: 'fa-trash', label: 'Delete order', tone: 'danger', onclick: 'SalesOrders.remove(\'' + so.id + '\')' }));
    }
    G.openMenu(ev, out.join(''));
  }

  function renderList(host) {
    var waiting = db().bids.filter(function (b) { return b.status === 'Awarded' && !forBid(b.id); });
    host.innerHTML =
      '<div class="flex items-start justify-between gap-4 mb-4">' +
        '<div><h2 class="text-xl font-bold text-ink-strong">Sales Orders</h2>' +
        '<p class="text-sm text-muted">Every awarded job in production - from the order to the last shipment.</p></div>' +
        (waiting.length && can()
          ? '<button onclick="SalesOrders.showWaiting(event)" class="px-3 py-2 rounded-lg text-sm font-semibold bg-ok-soft text-ok-ink hover:bg-ok hover:text-white transition flex items-center gap-2">' +
            '<i class="fas fa-trophy text-xs"></i>' + waiting.length + ' awarded, not in production yet</button>'
          : '') +
      '</div>' +
      '<div id="soGridHost"></div>';
    root.DataGrid.render('so');
  }

  function showWaiting(ev) {
    var G = root.BidGrid;
    var waiting = db().bids.filter(function (b) { return b.status === 'Awarded' && !forBid(b.id); });
    G.openMenu(ev, '<div class="px-3 py-2 text-3xs font-bold text-muted uppercase tracking-wider">Add to Production Manager</div>' +
      waiting.map(function (b) {
        return G.menuItem({ icon: 'fa-plus', label: (b.proposalNo ? b.proposalNo + ' · ' : '') + (b.project || 'Untitled'),
          onclick: 'SalesOrders.promptFromBid(' + b.id + ')' });
      }).join(''));
  }

  /* ---- the record ---------------------------------------------------------- */

  function field(so, label, key, o) {
    o = o || {};
    var value = so[key];
    var display = o.display != null ? o.display
      : value == null || value === '' ? ''
      : o.type === 'date' ? U.esc(U.date(value))
      : o.money ? U.esc(U.currency(value))
      : U.esc(String(value));
    if (!can() || o.readOnly) return root.UI.field(label, display || '<span class="text-faint">&mdash;</span>');
    return root.UI.editableField(label, display, {
      kind: 'salesorder', id: so.id, field: key, type: o.type || 'text',
      value: o.type === 'date' ? (value || '') : value, options: o.options
    });
  }

  function statusMenu(so) {
    if (!can()) return root.UI.badge(so.status || 'Open', STATUS_TONE[so.status] || 'info');
    return '<button onclick="SalesOrders.statusMenu(event,\'' + so.id + '\')" class="inline-flex items-center gap-1">' +
      root.UI.badge(so.status || 'Open', STATUS_TONE[so.status] || 'info') +
      '<i class="fas fa-chevron-down text-3xs text-faint"></i></button>';
  }

  function header(so) {
    var bid = bidById(so.bidId);
    return '<div class="flex flex-wrap items-start justify-between gap-4 mb-5">' +
      '<div class="min-w-0">' +
        '<button onclick="SalesOrders.back()" class="text-xs text-muted hover:text-brand mb-2 inline-flex items-center gap-1.5">' +
          '<i class="fas fa-arrow-left"></i>Sales Orders</button>' +
        '<div class="flex flex-wrap items-center gap-2">' +
          '<h2 class="text-2xl font-bold text-ink-strong font-mono">' + U.esc(so.soNo) + '</h2>' +
          '<span class="px-2 py-0.5 rounded bg-neutral-soft text-xs font-semibold text-muted">Rev ' + U.n(so.revision) + '</span>' +
          statusMenu(so) +
          root.UI.badge((so.priority || 'Medium') + ' priority', PRIORITY_TONE[so.priority] || 'warn') +
          shipChip(so) +
          (root.Presence ? root.Presence.headerChip('so:' + so.id) : '') +
        '</div>' +
        '<div class="text-sm text-muted mt-1 truncate">' + U.esc(so.project || 'No project name') +
          (bid ? ' &middot; <button onclick="SalesOrders.openBid(' + bid.id + ')" class="text-brand hover:underline">' +
            U.esc(bid.proposalNo || 'the awarded bid') + '</button>' : '') +
          ' &middot; created ' + U.esc(U.date(String(so.createdAt || '').slice(0, 10))) + '</div>' +
      '</div>' +
      (can()
        ? '<div class="flex items-center gap-2">' +
            root.UI.btn({ label: 'Revise', icon: 'fa-code-branch', variant: 'soft', tone: 'neutral', onclick: 'SalesOrders.revise(\'' + so.id + '\')' }) +
            root.UI.iconBtn({ icon: 'fa-trash', title: 'Delete this order', tone: 'danger', variant: 'ghost', onclick: 'SalesOrders.remove(\'' + so.id + '\')' }) +
          '</div>'
        : '') +
    '</div>';
  }

  function depositBar(so) {
    var req = U.n(so.depositRequired), got = U.n(so.depositReceived);
    if (!req) return '';
    var pct = Math.max(0, Math.min(100, Math.round(got / req * 100)));
    return '<div class="mt-2"><div class="h-1.5 rounded-full bg-neutral-soft overflow-hidden">' +
      '<div class="h-full ' + (pct >= 100 ? 'bg-ok' : 'bg-warn') + '" style="width:' + pct + '%"></div></div>' +
      '<div class="text-2xs text-muted mt-1">' + (pct >= 100 ? 'Deposit received in full'
        : U.currency(req - got) + ' still to come (' + pct + '% received)') + '</div></div>';
  }

  function cards(so) {
    var ui = root.UI;
    var grid = function (html) { return '<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4">' + html + '</div>'; };

    var project = ui.card({ title: 'Project Details', icon: 'fa-circle-info', body:
      '<div class="space-y-4">' +
        field(so, 'Project Name', 'project') +
        field(so, 'Project Details', 'projectDetails', { type: 'textarea' }) +
        ui.field('Proposal No', '<span class="font-mono">' + U.esc(so.proposalNo || '—') + '</span>') +
      '</div>' });

    var shipping = ui.card({ title: 'Shipping Address', icon: 'fa-truck', body:
      field(so, 'Ship to', 'shippingAddress', { type: 'textarea' }) });

    var billing = ui.card({ title: 'Billing Address', icon: 'fa-file-invoice', body:
      '<label class="flex items-center gap-2 text-xs text-muted mb-3' + (can() ? ' cursor-pointer' : '') + '">' +
        '<input type="checkbox" ' + (so.billingSame ? 'checked' : '') + (can() ? '' : ' disabled') +
        ' onchange="SalesOrders.setBillingSame(\'' + so.id + '\',this.checked)"> Same as shipping</label>' +
      (so.billingSame
        ? ui.field('Bill to', so.shippingAddress ? '<span class="whitespace-pre-line">' + U.esc(so.shippingAddress) + '</span>'
            : '<span class="text-faint">&mdash;</span>')
        : field(so, 'Bill to', 'billingAddress', { type: 'textarea' })) });

    var commercial = ui.card({ title: 'Commercial', icon: 'fa-handshake', body: grid(
      field(so, 'General Contractor', 'generalContractor') +
      field(so, 'Purchase Order', 'poNumber') +
      ui.field('Job Orders', jobOrderSummary(so)) +
      field(so, 'Project Cost', 'projectCost', { type: 'number', money: true }) +
      '<div>' + field(so, 'Deposit Required', 'depositRequired', { type: 'number', money: true }) + '</div>' +
      '<div>' + field(so, 'Deposit Received', 'depositReceived', { type: 'number', money: true }) + depositBar(so) + '</div>' +
      field(so, 'Priority', 'priority', { type: 'select', options: PRIORITIES })) });

    var dates = ui.card({ title: 'Dates', icon: 'fa-calendar-check', body: grid(
      field(so, 'Desired Ship Date', 'desiredShipDate', { type: 'date' }) +
      '<div>' + field(so, 'Targeted Date', 'targetDate', { type: 'date' }) +
        '<div class="text-2xs mt-1 ' + (so.targetAuto ? 'text-faint' : 'text-warn-ink') + '">' +
          (so.targetAuto ? 'Automatic: one week before the ship date'
            : 'Set by hand' + (can() ? ' &middot; <button onclick="SalesOrders.targetAuto(\'' + so.id + '\')" class="text-brand hover:underline">back to automatic</button>' : '')) +
        '</div></div>' +
      ui.field('Weeks Left', shipChip(so) || '<span class="text-faint">&mdash;</span>')) });

    return '<div class="space-y-5">' +
      '<div class="grid grid-cols-1 lg:grid-cols-3 gap-5">' + project + shipping + billing + '</div>' +
      '<div class="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-5">' + commercial + dates + '</div>' +
      linesCard(so) +
      root.RecLog.card(so) +
    '</div>';
  }

  function jobOrderSummary(so) {
    var n = (so.lines || []).filter(function (l) { return l.joNo; }).length;
    return n ? n + ' of ' + (so.lines || []).length + ' lines'
      : '<span class="text-faint">None yet</span>';
  }

  var UNITS = ['LF', 'EA', 'SF', 'LS', 'LB', 'FT'];

  function linesCard(so) {
    var lines = so.lines || [];
    var edit = can();
    var input = function (line, f, value, cls, attrs) {
      return '<input value="' + U.escAttr(value == null ? '' : value) + '" ' + (attrs || '') +
        ' onchange="SalesOrders.setLine(\'' + so.id + '\',\'' + line.id + '\',\'' + f + '\',this.value)" ' +
        'class="w-full px-2 py-1 bg-raised border border-line rounded text-sm outline-none focus:border-brand ' + (cls || '') + '">';
    };
    var types = (root.Rates && root.Rates.TYPES ? root.Rates.TYPES : []).concat(db().productTypes || []);
    var total = linesTotal(so);
    var diff = U.n(so.projectCost) - total;

    var rows = lines.length ? lines.map(function (l) {
      return '<tr class="border-t border-line">' +
        '<td class="px-3 py-2 font-mono text-sm text-muted">' + (edit ? input(l, 'itemNo', l.itemNo, 'font-mono w-20') : U.esc(l.itemNo)) + '</td>' +
        '<td class="px-3 py-2 w-20">' + (edit ? input(l, 'revision', l.revision, 'text-right font-mono', 'type="number" min="0"') : U.n(l.revision)) + '</td>' +
        '<td class="px-3 py-2">' + (edit ? input(l, 'productType', l.productType, '', 'list="soProductTypes"') : U.esc(l.productType || '—')) + '</td>' +
        '<td class="px-3 py-2 w-28">' + (edit ? input(l, 'qty', l.qty, 'text-right font-mono', 'type="number" step="any"') : U.qty(l.qty)) + '</td>' +
        '<td class="px-3 py-2 w-24">' + (edit ? input(l, 'um', l.um, 'uppercase', 'list="soUnits"') : U.esc(l.um || '')) + '</td>' +
        '<td class="px-3 py-2 w-36">' + (edit ? input(l, 'cost', l.cost, 'text-right font-mono', 'type="number" step="any"') : U.currency(l.cost)) + '</td>' +
        '<td class="px-3 py-2 w-36">' + (l.joNo
          ? '<span class="font-mono text-sm">' + U.esc(l.joNo) + '</span>'
          : '<span class="text-2xs text-faint" title="Job orders are created here once the Job Orders phase is in">Job order: soon</span>') + '</td>' +
        '<td class="px-2 py-2 w-10 text-center">' + (edit
          ? '<button onclick="SalesOrders.removeLine(\'' + so.id + '\',\'' + l.id + '\')" title="Remove this line" class="text-faint hover:text-danger text-xs"><i class="fas fa-times"></i></button>'
          : '') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="8" class="px-3 py-8 text-center text-sm text-faint">No line items yet.</td></tr>';

    return root.UI.card({ title: 'Line Items', icon: 'fa-list-ol',
      action: edit ? root.UI.btn({ label: 'Add line', icon: 'fa-plus', size: 'sm', onclick: 'SalesOrders.addLine(\'' + so.id + '\')' }) : '',
      body:
        '<datalist id="soProductTypes">' + types.filter(function (t, i) { return types.indexOf(t) === i; })
          .map(function (t) { return '<option value="' + U.escAttr(t) + '">'; }).join('') + '</datalist>' +
        '<datalist id="soUnits">' + UNITS.map(function (u) { return '<option value="' + u + '">'; }).join('') + '</datalist>' +
        '<div id="soLinesScroll" data-keep-scroll class="overflow-x-auto -mx-5 -my-4">' +
        '<table class="w-full text-sm"><thead class="bg-raised"><tr class="text-left">' +
          ['Item No', 'Rev', 'Product Type', 'Qty', 'U/M', 'Cost', 'JO', ''].map(function (h, i) {
            return '<th class="px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wider' +
              (i === 3 || i === 5 ? ' text-right' : '') + '">' + h + '</th>';
          }).join('') +
        '</tr></thead><tbody>' + rows + '</tbody>' +
        '<tfoot><tr class="border-t-2 border-line-strong bg-raised">' +
          '<td colspan="5" class="px-3 py-2 text-xs font-bold text-muted uppercase tracking-wider">Lines total</td>' +
          '<td class="px-3 py-2 text-right font-mono font-bold text-ink-strong">' + U.currency(total) + '</td>' +
          '<td colspan="2" class="px-3 py-2 text-2xs ' + (Math.abs(diff) < 1 ? 'text-ok-ink' : 'text-muted') + '">' +
            (U.n(so.projectCost) && !total && lines.length ? 'The lines are not priced yet'
              : U.n(so.projectCost)
              ? (Math.abs(diff) < 1 ? '<i class="fas fa-check mr-1"></i>Matches the project cost'
                : U.currency(Math.abs(diff)) + (diff > 0 ? ' below' : ' above') + ' the project cost (tax, freight and rounding sit outside the lines)')
              : '') +
          '</td></tr></tfoot></table></div>' });
  }

  function renderRecord(host, so) {
    U.preserveView(function () {
      host.innerHTML = header(so) + cards(so);
    });
  }

  function render() {
    var host = U.$('section-salesorders');
    if (!host || host.classList.contains('hidden')) return;
    var so = state.openId ? byId(state.openId) : null;
    if (state.openId && !so) {
      // Deleted by somebody else while it was open.
      state.openId = null;
      U.toast('That sales order has been deleted.', 'warn');
    }
    if (so) renderRecord(host, so);
    else renderList(host);
    if (root.App && root.App.screenIsCurrent) root.App.screenIsCurrent();
  }

  /* After a reload, the order that was open is open again. */
  function restore() {
    var o = db().ui.prodOpen;
    if (o && o.section === 'salesorders' && byId(o.id)) state.openId = o.id;
  }

  root.SalesOrders = {
    STATUSES: STATUSES,
    PRIORITIES: PRIORITIES,
    render: render,
    restore: restore,
    open: open,
    back: back,
    openBid: openBid,
    rowMenu: rowMenu,
    showWaiting: showWaiting,
    promptFromBid: promptFromBid,
    confirmFromBid: confirmFromBid,
    closeModal: function () { U.$('soModal').classList.add('hidden'); },
    createFromBid: createFromBid,
    nextSoNo: nextSoNo,
    weeksLeft: weeksLeft,
    targetFrom: targetFrom,
    depositOutstanding: depositOutstanding,
    forBid: forBid,
    byId: byId,
    openId: function () { return state.openId; },
    saveField: saveField,
    setLine: setLine,
    addLine: addLine,
    removeLine: removeLine,
    setStatus: setStatus,
    revise: revise,
    remove: remove,
    setBillingSame: function (id, on) {
      var so = byId(id);
      if (!so) return;
      edit(so, function () {
        so.billingSame = !!on;
        if (!on && !so.billingAddress) so.billingAddress = so.shippingAddress || '';
      });
    },
    targetAuto: function (id) {
      var so = byId(id);
      if (!so) return;
      edit(so, function () { so.targetAuto = true; so.targetDate = targetFrom(so.desiredShipDate); });
    },
    statusMenu: function (ev, id) {
      var so = byId(id);
      if (!so) return;
      var G = root.BidGrid;
      G.openMenu(ev, STATUSES.map(function (st) {
        return G.menuItem({ icon: st.key === so.status ? 'fa-check' : 'fa-circle', label: st.key,
          onclick: 'SalesOrders.setStatus(\'' + so.id + '\',\'' + st.key + '\')' });
      }).join(''));
    }
  };

  /* Wiring. ui.js, store.js and datagrid.js load before this file. */
  (function () {
    if (root.UI && root.UI.registerSaver) root.UI.registerSaver('salesorder', saveField);
    if (root.DataGrid) defineGrid();
    /* A sales order number somebody else took a moment earlier: take the next
       one and send again. Nobody needs to be asked - the number has not been
       printed on anything yet. */
    if (root.Store && root.Store.onDuplicate) {
      root.Store.onDuplicate('salesorder', function (dbx, body) {
        var so = (dbx.salesorders || []).filter(function (s) { return s.id === body.id; })[0];
        if (!so) return false;
        var was = so.soNo;
        so.soNo = nextSoNo(so.id);
        if (so.soNo === was) return false;
        root.RecLog.event(so, 'Renumbered from ' + was + ' - that number was taken at the same moment.');
        U.toast(was + ' was taken a moment ago; this order is ' + so.soNo + '.', 'info');
        return true;
      });
    }
  })();
})(window);
