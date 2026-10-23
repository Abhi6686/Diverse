/* production.js - Production Manager > Overview.
 *
 * The first page of the module: how much is in production, what is about to
 * ship, what money is still owed, and what needs somebody's attention today.
 * Everything here is read off the records - nothing is stored for this page.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }
  function orders() { return db().salesorders || []; }
  function live(so) { return so.status !== 'Shipped' && so.status !== 'Closed'; }

  function daysTo(iso) {
    if (!iso) return null;
    var a = U.parseDate(U.today()), b = U.parseDate(iso);
    return a && b ? Math.round((b - a) / 86400000) : null;
  }

  /* Tile classes written out in full, so the stylesheet compiler sees them. */
  var TONES = {
    brand: 'bg-brand-soft text-brand-ink',
    ok: 'bg-ok-soft text-ok-ink',
    warn: 'bg-warn-soft text-warn-ink',
    danger: 'bg-danger-soft text-danger-ink',
    info: 'bg-info-soft text-info-ink'
  };

  function tile(o) {
    var tag = o.onclick ? 'button' : 'div';
    return '<' + tag + (o.onclick ? ' onclick="' + o.onclick + '"' : '') +
      ' class="text-left bg-surface border border-line rounded-xl p-4 shadow-card ' +
      (o.onclick ? 'hover:border-brand transition' : '') + '">' +
      '<div class="flex items-center gap-2 mb-2">' +
        '<span class="w-7 h-7 rounded-lg flex items-center justify-center ' + (TONES[o.tone] || TONES.brand) + '">' +
          '<i class="fas ' + o.icon + ' text-xs"></i></span>' +
        '<span class="text-3xs font-bold text-muted uppercase tracking-wider">' + U.esc(o.label) + '</span>' +
      '</div>' +
      '<div class="text-2xl font-bold text-ink-strong font-mono">' + o.value + '</div>' +
      '<div class="text-2xs text-muted mt-1">' + (o.note || '&nbsp;') + '</div>' +
    '</' + tag + '>';
  }

  function attention() {
    var groups = [];
    var shipping = orders().filter(function (so) {
      var d = daysTo(so.desiredShipDate);
      return live(so) && d != null && d <= 7;
    }).sort(function (a, b) { return String(a.desiredShipDate).localeCompare(String(b.desiredShipDate)); });
    groups.push({ icon: 'fa-truck-fast', label: 'Shipping within 7 days, or late', tint: 'text-danger',
      rows: shipping.map(function (so) {
        var d = daysTo(so.desiredShipDate);
        return { id: so.id, title: so.soNo + ' · ' + (so.project || ''), meta: d < 0 ? 'Late by ' + (-d) + ' day(s)'
          : d === 0 ? 'Ships today' : 'Ships in ' + d + ' day(s)', urgent: d < 0 };
      }) });

    var deposits = orders().filter(function (so) {
      return live(so) && root.SalesOrders.depositOutstanding(so) > 0;
    });
    groups.push({ icon: 'fa-sack-dollar', label: 'Deposit not received', tint: 'text-warn',
      rows: deposits.map(function (so) {
        return { id: so.id, title: so.soNo + ' · ' + (so.project || ''),
          meta: U.currency(root.SalesOrders.depositOutstanding(so)) + ' due', urgent: false };
      }) });

    var noShip = orders().filter(function (so) { return live(so) && !so.desiredShipDate; });
    groups.push({ icon: 'fa-calendar-xmark', label: 'No ship date yet', tint: 'text-muted',
      rows: noShip.map(function (so) {
        return { id: so.id, title: so.soNo + ' · ' + (so.project || ''), meta: 'Set a desired ship date', urgent: false };
      }) });

    var body = groups.filter(function (g) { return g.rows.length; }).map(function (g) {
      return '<div class="mb-4 last:mb-0">' +
        '<div class="text-3xs font-bold text-muted uppercase tracking-wider mb-1.5 flex items-center gap-2">' +
          '<i class="fas ' + g.icon + ' ' + g.tint + '"></i>' + U.esc(g.label) +
          '<span class="ml-auto font-mono">' + g.rows.length + '</span></div>' +
        g.rows.slice(0, 8).map(function (r) {
          return '<button onclick="SalesOrders.open(\'' + r.id + '\')" ' +
            'class="w-full text-left flex items-center justify-between gap-3 px-2 py-1.5 rounded hover:bg-raised">' +
            '<span class="text-sm text-ink truncate">' + U.esc(r.title) + '</span>' +
            '<span class="text-2xs shrink-0 ' + (r.urgent ? 'text-danger font-semibold' : 'text-muted') + '">' +
              U.esc(r.meta) + '</span></button>';
        }).join('') +
      '</div>';
    }).join('');
    return root.UI.card({ title: 'Needs attention', icon: 'fa-triangle-exclamation',
      body: body || '<div class="py-6 text-center text-sm text-faint"><i class="fas fa-check text-ok mr-1"></i>Nothing urgent.</div>' });
  }

  function waitingCard() {
    var waiting = db().bids.filter(function (b) {
      return b.status === 'Awarded' && !root.SalesOrders.forBid(b.id);
    });
    var can = root.Auth.can('so.edit');
    return root.UI.card({ title: 'Awarded, not in production yet', icon: 'fa-trophy',
      body: waiting.length ? waiting.slice(0, 10).map(function (b) {
        return '<div class="flex items-center justify-between gap-3 py-1.5 border-b border-line last:border-0">' +
          '<div class="min-w-0"><div class="text-sm text-ink truncate">' + U.esc(b.project || 'Untitled') + '</div>' +
          '<div class="text-2xs text-muted font-mono">' + U.esc(b.proposalNo || '') + ' · ' + U.currency(b.price) + '</div></div>' +
          (can ? root.UI.btn({ label: 'Add', icon: 'fa-plus', size: 'xs', tone: 'ok',
            onclick: 'SalesOrders.promptFromBid(' + b.id + ')' }) : '') +
        '</div>';
      }).join('') + (waiting.length > 10 ? '<div class="text-2xs text-muted pt-2">and ' + (waiting.length - 10) + ' more on Awarded Bids</div>' : '')
        : '<div class="py-6 text-center text-sm text-faint">Every awarded job is in production.</div>' });
  }

  function render() {
    var host = U.$('section-production');
    if (!host || host.classList.contains('hidden')) return;
    var all = orders();
    var open = all.filter(live);
    var value = open.reduce(function (t, so) { return t + U.n(so.projectCost); }, 0);
    var owed = open.reduce(function (t, so) { return t + root.SalesOrders.depositOutstanding(so); }, 0);
    var soon = open.filter(function (so) { var d = daysTo(so.desiredShipDate); return d != null && d >= 0 && d <= 14; });
    var late = open.filter(function (so) { var d = daysTo(so.desiredShipDate); return d != null && d < 0; });
    var waiting = db().bids.filter(function (b) { return b.status === 'Awarded' && !root.SalesOrders.forBid(b.id); });

    U.preserveView(function () {
      host.innerHTML =
        '<div class="mb-5"><h2 class="text-xl font-bold text-ink-strong">Production Manager</h2>' +
        '<p class="text-sm text-muted">Awarded work, from the sales order to the shipment.</p></div>' +
        '<div class="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4 mb-6">' +
          tile({ label: 'Open orders', icon: 'fa-file-invoice-dollar', tone: 'brand', value: open.length,
            note: all.length - open.length + ' shipped or closed', onclick: 'App.switchTab(\'salesorders\')' }) +
          tile({ label: 'In production', icon: 'fa-industry', tone: 'info', value: U.currency(value),
            note: 'value of open orders' }) +
          tile({ label: 'Deposits due', icon: 'fa-sack-dollar', tone: owed ? 'warn' : 'ok', value: U.currency(owed),
            note: owed ? 'still to be received' : 'all received' }) +
          tile({ label: 'Ship in 14 days', icon: 'fa-truck', tone: soon.length ? 'warn' : 'ok', value: soon.length,
            note: soon.length ? 'orders due out soon' : 'nothing due' }) +
          tile({ label: 'Late', icon: 'fa-clock', tone: late.length ? 'danger' : 'ok', value: late.length,
            note: late.length ? 'past their ship date' : 'all on schedule' }) +
          tile({ label: 'Awarded, waiting', icon: 'fa-trophy', tone: waiting.length ? 'ok' : 'info', value: waiting.length,
            note: 'not in production yet', onclick: waiting.length ? 'App.switchTab(\'awarded\')' : '' }) +
        '</div>' +
        '<div class="grid grid-cols-1 xl:grid-cols-2 gap-5">' + attention() + waitingCard() + '</div>';
    });
  }

  root.Production = { render: render };
})(window);
