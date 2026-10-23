/* datagrid.js - the table every Production and Inventory list is drawn with.
 *
 * The bid tables have their own, js/bidgrid.js, and it is not generic: its
 * columns, its views, its calendar and its row actions are all bids. Rather
 * than pull that apart under the busiest screens in the app, the new lists get
 * this - smaller, and generic from the start. It looks the same on purpose:
 * the same header type, the same sticky head, the same row heights, the same
 * row menu (BidGrid's popover helpers, which are generic already).
 *
 * A grid is DEFINED once, with everything about it, and then just RENDERED:
 *
 *   DataGrid.define('so', {
 *     host: 'soGridHost',            the element to draw into
 *     noun: 'sales order',           "12 of 40 sales orders"
 *     columns: [ { key, label, type, align, width, value(r), render(r), hidden, locked } ],
 *     rows: function () {...},       the list, already narrowed by the page
 *     search: function (r) {...},    the text a search matches against
 *     chips: [ { value, label, test(r) } ],   quick filters above the table
 *     open: 'SalesOrders.open',      a global function called with the row id
 *     openKey: 'soNo',               the column that is the link
 *     menu: 'SalesOrders.rowMenu',   a global function (event, id) -> opens a menu
 *     empty: { icon, title, blurb, action }
 *   });
 *   DataGrid.render('so');
 *
 * What a person changes - sort, search, chip, hidden columns, density - is
 * theirs, kept in db.ui.grids['dg:' + id] like the bid tables' layouts, so it
 * follows them to whichever machine they sit at.
 *
 * Column types: text (default), number, money, date (ISO), none (no sort).
 */
(function (root) {
  'use strict';

  var U = root.U;
  var SPECS = {};

  function ui() {
    var db = root.Store.db;
    if (!db.ui.grids) db.ui.grids = {};
    return db.ui.grids;
  }

  function cfg(id) {
    var g = ui();
    var k = 'dg:' + id;
    if (!g[k] || typeof g[k] !== 'object') g[k] = {};
    var c = g[k];
    if (!Array.isArray(c.hidden)) {
      c.hidden = (SPECS[id].columns || []).filter(function (col) { return col.hidden; })
        .map(function (col) { return col.key; });
    }
    if (!c.density) c.density = 'comfortable';
    if (c.search == null) c.search = '';
    return c;
  }

  // The layout is one person's, not a record - Store.save sends it through
  // the prefs route and nothing is broadcast.
  function persist() { root.Store.save(); }

  function columns(id) {
    var c = cfg(id);
    return SPECS[id].columns.filter(function (col) {
      return col.locked || c.hidden.indexOf(col.key) < 0;
    });
  }

  function valueOf(col, r) {
    if (col.value) return col.value(r);
    return r[col.key];
  }

  function compare(a, b, type) {
    var ea = a == null || a === '', eb = b == null || b === '';
    if (ea && eb) return 0;
    if (ea) return 1;              // blanks last, whichever way round
    if (eb) return -1;
    if (type === 'number' || type === 'money') return Number(a) - Number(b);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /* The rows on screen, after chip, search and sort. Exported, because an
     export ("the list you are looking at") wants exactly this. */
  function visible(id) {
    var spec = SPECS[id];
    var c = cfg(id);
    var list = (spec.rows() || []).slice();

    if (c.chip && spec.chips) {
      var chip = spec.chips.filter(function (x) { return x.value === c.chip; })[0];
      if (chip) list = list.filter(chip.test);
    }
    var q = String(c.search || '').trim().toLowerCase();
    if (q && spec.search) {
      var words = q.split(/\s+/);
      list = list.filter(function (r) {
        var hay = String(spec.search(r) || '').toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    if (c.sort && c.sort.key) {
      var col = spec.columns.filter(function (x) { return x.key === c.sort.key; })[0];
      if (col) {
        var dir = c.sort.dir === 'desc' ? -1 : 1;
        list.sort(function (a, b) {
          return dir * compare(valueOf(col, a), valueOf(col, b), col.type);
        });
      }
    }
    return list;
  }

  function cellText(col, r) {
    var v = valueOf(col, r);
    if (v == null || v === '') return '<span class="text-faint">&mdash;</span>';
    if (col.type === 'money') return U.currency(v);
    if (col.type === 'date') return U.esc(U.date(v));
    if (col.type === 'number') return U.esc(U.qty(v));
    return U.esc(String(v));
  }

  var DENSITY = {
    comfortable: { cell: 'px-3 py-3', row: 'h-[52px]' },
    compact: { cell: 'px-3 py-1.5', row: 'h-[36px]' }
  };

  function headCell(id, col, c) {
    var sorted = c.sort && c.sort.key === col.key ? c.sort.dir : null;
    var align = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
    var label = U.esc(col.label);
    return '<th class="px-3 py-2.5 whitespace-nowrap ' + align + ' ' + (col.width || '') + '">' +
      (col.type === 'none'
        ? '<span class="font-semibold text-muted uppercase text-xs tracking-wider">' + label + '</span>'
        : '<button onclick="DataGrid.sort(\'' + id + '\',\'' + col.key + '\')" ' +
          'class="font-semibold text-muted uppercase text-xs tracking-wider hover:text-brand-ink inline-flex items-center gap-1" ' +
          'title="Sort by ' + U.escAttr(col.label) + '">' + label +
          '<i class="fas ' + (sorted === 'asc' ? 'fa-sort-up text-brand'
            : sorted === 'desc' ? 'fa-sort-down text-brand' : 'fa-sort text-faint') + ' text-3xs"></i></button>') +
      '</th>';
  }

  function toolbar(id, spec, c, counts) {
    var chips = (spec.chips || []).map(function (x) {
      var on = c.chip === x.value;
      return '<button onclick="DataGrid.chip(\'' + id + '\',\'' + x.value + '\')" ' +
        'class="px-3 py-1.5 rounded-full text-xs font-semibold border transition ' +
        (on ? 'bg-brand text-white border-brand' : 'bg-surface text-ink border-line hover:border-brand') + '">' +
        U.esc(x.label) + ' <span class="' + (on ? 'text-white/80' : 'text-faint') + ' font-mono">' +
        counts[x.value] + '</span></button>';
    }).join('');
    var allOn = !c.chip;
    return '<div class="flex flex-wrap items-center gap-2 mb-3">' +
      '<div class="relative flex-1 min-w-[14rem]">' +
        '<i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-faint text-xs"></i>' +
        '<input id="dg-search-' + id + '" value="' + U.escAttr(c.search) + '" ' +
          'oninput="DataGrid.search(\'' + id + '\',this.value)" placeholder="Search ' +
          U.escAttr(spec.noun ? spec.noun + 's' : '') + '..." ' +
          'class="w-full pl-8 pr-3 py-2 bg-surface border border-line rounded-lg text-sm outline-none focus:border-brand">' +
      '</div>' +
      (spec.chips && spec.chips.length
        ? '<button onclick="DataGrid.chip(\'' + id + '\',\'\')" ' +
          'class="px-3 py-1.5 rounded-full text-xs font-semibold border transition ' +
          (allOn ? 'bg-brand text-white border-brand' : 'bg-surface text-ink border-line hover:border-brand') + '">All ' +
          '<span class="' + (allOn ? 'text-white/80' : 'text-faint') + ' font-mono">' + counts[''] + '</span></button>' + chips
        : '') +
      '<button onclick="DataGrid.openColumns(event,\'' + id + '\')" ' +
        'class="px-3 py-2 bg-surface border border-line rounded-lg text-xs font-semibold text-ink hover:border-brand">' +
        '<i class="fas fa-table-columns mr-1.5 text-faint"></i>Columns</button>' +
    '</div>';
  }

  function render(id) {
    var spec = SPECS[id];
    if (!spec) return;
    var host = U.$(spec.host);
    if (!host) return;
    var c = cfg(id);
    var all = spec.rows() || [];
    var rows = visible(id);
    var cols = columns(id);
    var d = DENSITY[c.density] || DENSITY.comfortable;

    var counts = { '': all.length };
    (spec.chips || []).forEach(function (x) { counts[x.value] = all.filter(x.test).length; });

    var body;
    if (!all.length && spec.empty) {
      host.innerHTML = root.UI.emptyCard(spec.empty);
      return;
    }
    if (!rows.length) {
      body = '<tr><td colspan="' + (cols.length + (spec.menu ? 1 : 0)) + '" class="px-3 py-12 text-center">' +
        '<i class="fas fa-filter text-2xl text-faint mb-2 block"></i>' +
        '<span class="text-muted text-sm">Nothing matches the search or filter.</span>' +
        '<button onclick="DataGrid.clear(\'' + id + '\')" class="block mx-auto mt-2 text-brand hover:text-brand-ink text-xs font-medium">Clear</button>' +
        '</td></tr>';
    } else {
      body = rows.map(function (r) {
        return '<tr class="border-t border-line hover:bg-raised/60 ' + d.row + '">' +
          (spec.menu
            ? '<td class="' + d.cell + ' w-10 text-center">' +
              '<button onclick="' + spec.menu + '(event,\'' + U.escAttr(String(r.id)) + '\')" ' +
              'class="w-7 h-7 rounded hover:bg-line text-faint hover:text-ink" title="Actions">' +
              '<i class="fas fa-ellipsis-v"></i></button></td>'
            : '') +
          cols.map(function (col) {
            var align = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
            var inner = col.render ? col.render(r) : cellText(col, r);
            var link = spec.open && col.key === spec.openKey;
            return '<td class="' + d.cell + ' ' + align + ' whitespace-nowrap ' +
              (col.type === 'money' || col.type === 'number' ? 'font-mono ' : '') + '">' +
              (link
                ? '<button onclick="' + spec.open + '(\'' + U.escAttr(String(r.id)) + '\')" ' +
                  'class="font-semibold text-brand hover:text-brand-ink hover:underline text-left">' + inner + '</button>'
                : inner) +
              '</td>';
          }).join('') +
        '</tr>';
      }).join('');
    }

    U.preserveView(function () {
      host.innerHTML = toolbar(id, spec, c, counts) +
        '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden">' +
        '<div id="dg-scroll-' + id + '" data-keep-scroll class="overflow-auto max-h-[calc(100vh-19rem)] min-h-[10rem]">' +
        '<table class="w-full text-sm grid-table"><thead class="sticky-header"><tr>' +
          (spec.menu ? '<th class="px-3 py-2.5 w-10"></th>' : '') +
          cols.map(function (col) { return headCell(id, col, c); }).join('') +
        '</tr></thead><tbody>' + body + '</tbody></table></div>' +
        '<div class="px-4 py-2 bg-raised border-t border-line text-xs text-muted flex items-center justify-between gap-3">' +
          '<span>' + rows.length + ' of ' + all.length + ' ' + (spec.noun || 'row') + (all.length === 1 ? '' : 's') +
            (spec.footer ? ' &middot; ' + spec.footer(rows) : '') + '</span>' +
          '<span class="flex items-center gap-1">' +
            ['comfortable', 'compact'].map(function (k) {
              return '<button onclick="DataGrid.density(\'' + id + '\',\'' + k + '\')" ' +
                'class="px-2 py-1 rounded ' + (c.density === k ? 'bg-surface border border-line text-ink font-semibold' : 'text-muted hover:text-ink') + '">' +
                (k === 'comfortable' ? 'Comfortable' : 'Compact') + '</button>';
            }).join('') +
          '</span>' +
        '</div></div>';
    });
  }

  function rerender(id) {
    var spec = SPECS[id];
    if (spec && spec.rerender) spec.rerender(); else render(id);
  }

  root.DataGrid = {
    define: function (id, spec) { SPECS[id] = spec; },
    render: render,
    visible: visible,
    columns: columns,
    cellText: cellText,

    sort: function (id, key) {
      var c = cfg(id);
      if (c.sort && c.sort.key === key) {
        c.sort = c.sort.dir === 'asc' ? { key: key, dir: 'desc' } : null;
      } else {
        c.sort = { key: key, dir: 'asc' };
      }
      persist();
      rerender(id);
    },
    search: function (id, v) {
      cfg(id).search = v;
      rerender(id);
      // Saved, but not on every keystroke.
      clearTimeout(root.DataGrid._t);
      root.DataGrid._t = setTimeout(persist, 600);
    },
    chip: function (id, v) {
      cfg(id).chip = v || null;
      persist();
      rerender(id);
    },
    clear: function (id) {
      var c = cfg(id);
      c.chip = null;
      c.search = '';
      persist();
      rerender(id);
    },
    density: function (id, d) {
      cfg(id).density = d;
      persist();
      rerender(id);
    },
    openColumns: function (ev, id) {
      var c = cfg(id);
      var html = '<div class="px-3 py-2 text-3xs font-bold text-muted uppercase tracking-wider">Columns</div>' +
        SPECS[id].columns.filter(function (col) { return !col.locked; }).map(function (col) {
          var on = c.hidden.indexOf(col.key) < 0;
          return '<label class="flex items-center gap-2 px-3 py-1.5 text-xs text-ink hover:bg-raised cursor-pointer">' +
            '<input type="checkbox" ' + (on ? 'checked' : '') +
            ' onchange="DataGrid.toggleColumn(\'' + id + '\',\'' + col.key + '\')"> ' + U.esc(col.label) + '</label>';
        }).join('');
      root.BidGrid.openMenu(ev, html);
    },
    toggleColumn: function (id, key) {
      var c = cfg(id);
      var i = c.hidden.indexOf(key);
      if (i >= 0) c.hidden.splice(i, 1); else c.hidden.push(key);
      persist();
      rerender(id);
    }
  };
})(window);
