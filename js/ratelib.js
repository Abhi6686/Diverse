/* ratelib.js - Rate Library tab: the parts catalog and the labour/equipment
   rate defaults that feed every takeoff. */
(function (root) {
  'use strict';

  var U = root.U;
  var view = { q: '', vendor: '', type: '', source: '', sel: {}, sort: 'useCount' };

  function db() { return root.Store.db; }
  function save() { root.Store.save(); render(); }

  function filtered() {
    var list = root.Catalog.all().slice();
    if (view.q) {
      var q = view.q.toLowerCase();
      list = list.filter(function (c) {
        return U.low(c.description).indexOf(q) >= 0 || U.low(c.partNo).indexOf(q) >= 0 ||
          U.low(c.vendor).indexOf(q) >= 0 || U.low(c.feature).indexOf(q) >= 0;
      });
    }
    if (view.vendor) list = list.filter(function (c) { return c.vendor === view.vendor; });
    if (view.type) list = list.filter(function (c) { return c.sowTags.indexOf(view.type) >= 0; });
    /* 'nostock' is not a source, but it belongs on the same control: they are
       all "show me the subset I have to do something about", and a fourth
       dropdown for one option would be a worse trade than the slight stretch of
       the word. */
    if (view.source === 'nostock') {
      list = list.filter(function (c) { return !(U.n(c.packQty) > 0); });
    } else if (view.source) {
      list = list.filter(function (c) { return c.source === view.source; });
    }

    list.sort(function (a, b) {
      if (view.sort === 'useCount') return (b.useCount || 0) - (a.useCount || 0);
      if (view.sort === 'cost') return (b.unitCost || 0) - (a.unitCost || 0);
      if (view.sort === 'recent') return String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''));
      return U.low(a.description).localeCompare(U.low(b.description));
    });
    return list;
  }

  function render() {
    var host = U.$('section-ratelib');
    if (!host || host.classList.contains('hidden')) return;
    var all = root.Catalog.all();
    var vendors = [];
    all.forEach(function (c) { if (c.vendor && vendors.indexOf(c.vendor) < 0) vendors.push(c.vendor); });
    vendors.sort();
    var list = filtered();
    var dups = root.Catalog.duplicates();
    var selCount = Object.keys(view.sel).filter(function (k) { return view.sel[k]; }).length;

    host.innerHTML =
      renderRatesPanel() +
      (dups.length ? '<div class="bg-warn-soft border border-warn/30 rounded-xl p-4 mb-6">' +
        '<div class="flex items-center justify-between flex-wrap gap-2">' +
        '<div class="text-sm text-warn-ink"><i class="fas fa-clone mr-1.5"></i><strong>' + dups.length +
          '</strong> possible duplicate pair' + (dups.length > 1 ? 's' : '') + ' in the library.</div>' +
        '<button onclick="RateLib.showDupes()" class="px-3 py-1.5 bg-warn hover:bg-warn-hover text-white rounded-lg text-xs font-semibold">Review</button></div>' +
        '<div id="dupList" class="hidden mt-3 space-y-2">' + dups.map(function (d, i) {
          return '<div class="flex items-center gap-3 bg-surface rounded-lg p-2 text-xs">' +
            '<div class="flex-1 min-w-0"><div class="truncate"><strong>A:</strong> ' + U.esc(d.a.description) + ' <span class="text-faint">' + U.currency2(d.a.unitCost) + '</span></div>' +
            '<div class="truncate"><strong>B:</strong> ' + U.esc(d.b.description) + ' <span class="text-faint">' + U.currency2(d.b.unitCost) + '</span></div></div>' +
            '<button onclick="RateLib.merge(\'' + d.a.id + '\',\'' + d.b.id + '\')" class="px-2 py-1 bg-chrome text-white rounded text-3xs whitespace-nowrap">Keep A</button>' +
            '<button onclick="RateLib.merge(\'' + d.b.id + '\',\'' + d.a.id + '\')" class="px-2 py-1 bg-chrome text-white rounded text-3xs whitespace-nowrap">Keep B</button></div>';
        }).join('') + '</div></div>' : '') +

      '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden">' +
      '<div class="p-4 border-b border-line flex flex-wrap gap-3 items-center">' +
        '<div class="relative flex-1 min-w-[220px]">' +
          '<i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-faint"></i>' +
          '<input value="' + U.escAttr(view.q) + '" oninput="RateLib.set(\'q\',this.value)" placeholder="Search parts, part numbers, vendors..." ' +
            'class="search-input w-full pl-10 pr-4 py-2 bg-raised border border-line rounded-lg text-sm focus:border-brand outline-none"></div>' +
        sel('vendor', 'All Vendors', vendors) +
        sel('type', 'All Product Types', root.Rates.TYPES) +
        sel('source', 'Seed & Learned', ['seed', 'learned', 'nostock'],
          { seed: 'Seeded only', learned: 'Learned only', nostock: 'Missing a stock size' }) +
        '<select onchange="RateLib.set(\'sort\',this.value)" class="px-3 py-2 bg-raised border border-line rounded-lg text-sm outline-none">' +
          [['useCount', 'Most used'], ['recent', 'Recently used'], ['cost', 'Highest cost'], ['name', 'A-Z']].map(function (o) {
            return '<option value="' + o[0] + '"' + (view.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select>' +
      '</div>' +

      '<div class="px-4 py-2 border-b border-line bg-raised flex flex-wrap items-center gap-2 text-xs">' +
        '<span class="text-muted">' + list.length + ' of ' + all.length + ' parts</span>' +
        '<span class="flex-1"></span>' +
        (selCount ? '<button onclick="RateLib.deleteSelected()" class="px-3 py-1.5 bg-danger-soft text-danger-ink rounded-lg font-semibold hover:bg-danger-soft/60"><i class="fas fa-trash mr-1"></i>Delete ' + selCount + '</button>' : '') +
        '<button onclick="RateLib.add()" class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg font-semibold"><i class="fas fa-plus mr-1"></i>New part</button>' +
        '<button onclick="Catalog.exportCSV()" class="px-3 py-1.5 bg-neutral-soft hover:bg-line text-ink rounded-lg font-semibold"><i class="fas fa-file-csv mr-1"></i>Export CSV</button>' +
        '<button onclick="RateLib.pickCSV()" class="px-3 py-1.5 bg-neutral-soft hover:bg-line text-ink rounded-lg font-semibold"><i class="fas fa-upload mr-1"></i>Import CSV</button>' +
      '</div>' +

      '<div class="overflow-x-auto max-h-[560px] overflow-y-auto"><table class="w-full text-xs grid-table">' +
      '<thead class="sticky-header"><tr>' +
        '<th class="px-2 py-2 w-8"></th>' +
        [['Vendor', 'left'], ['Part No', 'left'], ['Description', 'left'], ['Feature', 'left'],
         ['Material', 'left'], ['Grade', 'left'], ['U/M', 'center'],
         ['Length/PKT Qty', 'right'], ['Stock U/M', 'center'], ['Unit Cost', 'right'],
         ['Used On', 'left'], ['Used', 'center'], ['Source', 'center'], ['', 'center']]
          .map(function (h) {
            return '<th class="px-2 py-2 col-' + h[1] +
              ' font-semibold text-muted uppercase text-3xs tracking-wider whitespace-nowrap">' + h[0] + '</th>';
          }).join('') + '</tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        var hist = (c.priceHistory || []).slice(-5).reverse();
        return '<tr>' +
          '<td class="px-2 py-1 col-center"><input type="checkbox" ' + (view.sel[c.id] ? 'checked' : '') +
            ' onchange="RateLib.toggleSel(\'' + c.id + '\')"></td>' +
          inp(c, 'vendor', 'w-24') + inp(c, 'partNo', 'w-24') +
          inp(c, 'description', 'min-w-[260px] w-full') + inp(c, 'feature', 'w-28') +
          inp(c, 'material', 'w-24') + inp(c, 'grade', 'w-20') + inp(c, 'um', 'w-12', 'col-center') +
          /* What the vendor sells it in. Blank on everything seeded from the
             workbook, which never recorded it - the takeoff learns it the first
             time somebody types it on a material row, so this column fills
             itself in as jobs are estimated. */
          '<td class="px-1 py-1 col-right"><input type="number" step="any" min="0" ' +
            'value="' + (c.packQty == null ? '' : c.packQty) + '" ' +
            'onchange="RateLib.upd(\'' + c.id + '\',\'packQty\',this.value)" ' +
            'title="How much comes in one purchased item - 21 LF to a stick of pipe, 100 EA to a packet" ' +
            'class="w-16 px-1.5 py-1 rounded text-right font-mono outline-none focus:border-brand ' +
            (U.n(c.packQty) > 0 ? 'bg-raised border border-line'
              : 'bg-warn-soft/30 border border-dashed border-warn/50') + '"></td>' +
          inp(c, 'packUm', 'w-12', 'col-center') +
          '<td class="px-1 py-1 col-right"><input type="number" step="any" value="' + (c.unitCost == null ? '' : c.unitCost) + '" ' +
            'onchange="RateLib.upd(\'' + c.id + '\',\'unitCost\',this.value)" ' +
            'class="w-24 px-1.5 py-1 bg-raised border border-line rounded text-right font-mono outline-none focus:border-brand">' +
            (hist.length > 1 ? '<button onclick="RateLib.history(\'' + c.id + '\')" class="ml-1 text-3xs text-brand hover:text-brand-ink" title="Price history">' + hist.length + '</button>' : '') +
          '</td>' +
          '<td class="px-2 py-1"><div class="flex flex-wrap gap-0.5 max-w-[150px]">' + c.sowTags.map(function (t) {
            return '<span class="px-1.5 py-0.5 bg-neutral-soft text-muted rounded text-3xs">' + U.esc(t) + '</span>';
          }).join('') + '</div></td>' +
          '<td class="px-2 py-1 col-center font-mono text-muted">' + (c.useCount || 0) + '</td>' +
          '<td class="px-2 py-1 col-center"><span class="px-1.5 py-0.5 rounded text-3xs font-semibold ' +
            (c.source === 'seed' ? 'bg-neutral-soft text-muted' : 'bg-ok-soft text-ok-ink') + '">' +
            (c.source === 'seed' ? 'seed' : 'learned') + '</span></td>' +
          '<td class="px-2 py-1 col-center"><button onclick="RateLib.del(\'' + c.id + '\')" class="text-faint hover:text-danger"><i class="fas fa-times"></i></button></td>' +
          '</tr>' +
          '<tr id="hist-' + c.id + '" class="hidden bg-brand-soft/40"><td></td><td colspan="14" class="px-3 py-2">' +
            '<div class="text-3xs text-muted"><strong>Price history:</strong> ' +
            hist.map(function (h) {
              return U.currency2(h.cost) + ' <span class="text-faint">(' +
                (h.at ? U.date(h.at) : 'seed') + (h.project ? ', ' + U.esc(h.project) : '') + ')</span>';
            }).join(' &larr; ') + '</div></td></tr>';
      }).join('') : '<tr><td colspan="15" class="px-3 py-10 text-center text-faint">No parts match those filters.</td></tr>') +
      '</tbody></table></div></div>';
  }

  function sel(field, label, options, labels) {
    return '<select onchange="RateLib.set(\'' + field + '\',this.value)" class="px-3 py-2 bg-raised border border-line rounded-lg text-sm outline-none">' +
      '<option value="">' + label + '</option>' +
      options.map(function (o) {
        return '<option value="' + U.escAttr(o) + '"' + (view[field] === o ? ' selected' : '') + '>' +
          U.esc(labels ? labels[o] : o) + '</option>';
      }).join('') + '</select>';
  }

  function inp(c, field, w, cls) {
    return '<td class="px-1 py-1 ' + (cls || '') + '"><input value="' + U.escAttr(c[field]) + '" ' +
      'onchange="RateLib.upd(\'' + c.id + '\',\'' + field + '\',this.value)" ' +
      'class="' + w + ' px-1.5 py-1 bg-raised border border-line rounded outline-none focus:border-brand"></td>';
  }

  /* ---- rates panel ----------------------------------------------------- */

  /* The shop-wide defaults. The identical grid, scoped to one project, is on
     the TakeOff tab - both render through js/ratespanel.js. */
  function renderRatesPanel() {
    var r = root.Rates.ensure(db());
    var g = r.global;

    var overrides = Object.keys(r.byType).map(function (t) {
      var o = r.byType[t];
      return '<div class="flex items-center gap-2 text-xs text-muted py-1">' +
        '<span class="font-semibold text-ink w-44">' + U.esc(t) + '</span>' +
        '<span class="text-muted">' + Object.keys(o).map(function (k) {
          return k + ' = ' + o[k];
        }).join(', ') + '</span></div>';
    }).join('');

    return root.RatesPanel.render({
      title: 'Labour, Equipment &amp; Markup Defaults',
      subtitle: 'Used by every project that has not set its own.',
      get: function (key) { return g[key]; },
      isOverridden: function () { return false; },   // these are the baseline
      setter: function (key) { return 'RateLib.setRate(\'' + key + '\',this.value)'; },
      headerRight: '<button onclick="RateLib.resetRates()" class="text-xs text-faint hover:text-brand-ink underline">Restore workbook defaults</button>',
      footer:
        (overrides ? '<div class="mt-4 pt-4 border-t border-line">' +
          '<p class="text-3xs font-semibold text-muted uppercase tracking-wider mb-1">Per-product overrides (from the workbook)</p>' +
          overrides + '</div>' : '') +
        '<p class="mt-3 text-2xs text-faint">Changing a rate here sets the default for <em>new</em> products. ' +
        'A single project can override any of these on its own <strong>Rates</strong> page in TakeOff.</p>'
    });
  }

  root.RateLib = {
    render: render,
    set: function (f, v) { view[f] = v; render(); },
    toggleSel: function (id) { view.sel[id] = !view.sel[id]; render(); },
    upd: function (id, f, v) { root.Catalog.update(id, defineOne(f, v)); render(); },
    del: function (id) {
      var c = root.Catalog.find(id);
      if (!confirm('Delete "' + (c.description || c.partNo) + '" from the rate library?')) return;
      root.Catalog.remove(id);
      render();
    },
    deleteSelected: function () {
      var ids = Object.keys(view.sel).filter(function (k) { return view.sel[k]; });
      if (!confirm('Delete ' + ids.length + ' part(s) from the rate library?')) return;
      root.Catalog.remove(ids);
      view.sel = {};
      render();
    },
    add: function () {
      root.Catalog.create({ description: 'New part', vendor: '', um: 'EA' });
      view.q = '';
      render();
    },
    merge: function (keep, drop) { root.Catalog.merge(keep, drop); render(); },
    showDupes: function () { U.$('dupList').classList.toggle('hidden'); },
    history: function (id) { U.$('hist-' + id).classList.toggle('hidden'); },
    pickCSV: function () { U.$('catalogCsvInput').click(); },
    importCSV: function (file) {
      var r = new FileReader();
      r.onload = function (e) {
        var res = root.Catalog.importCSV(e.target.result);
        U.toast('Imported: ' + res.added + ' added, ' + res.updated + ' updated.', 'ok');
        render();
      };
      r.readAsText(file);
    },
    setRate: function (key, v) {
      root.Rates.ensure(db()).global[key] = v === '' ? 0 : Number(v);
      save();
    },
    resetRates: function () {
      if (!confirm('Restore all labour, equipment and markup defaults to the workbook values?')) return;
      db().rates = null;
      root.Rates.ensure(db());
      save();
      U.toast('Defaults restored.', 'ok');
    }
  };

  function defineOne(f, v) { var o = {}; o[f] = v; return o; }
})(window);
