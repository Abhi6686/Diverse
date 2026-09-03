/* bidgrid.js - the Bids table.
 *
 * One column-definition array is the single source of truth for the heading,
 * its alignment, how the cell renders, how the column sorts and how it filters.
 * The header, the body, the filter popovers and the column selector all read
 * from it, so adding a column is one entry rather than four edits that drift.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  /* A bid nobody is going to work on any more, whichever way it went. */
  function decided(b) { return root.Bids.bucketOf(b) !== 'open'; }

  /* Hours cells all look the same; zero prints as a dash so a column of real
     figures is not buried in noughts. */
  function hrs(v, cls) {
    var n = U.n(v);
    return '<span class="font-mono text-xs ' + (cls || 'text-slate-600') + '">' +
      (n ? U.qty(n) : '<span class="text-slate-300">&mdash;</span>') + '</span>';
  }

  /* ---- column definitions ---------------------------------------------- */

  /* type drives both sorting and the filter UI:
       text   - contains box
       enum   - checkbox list of the distinct values, with counts
       multi  - same, but the field is an array (products)
       number - numeric compare, contains box
       date   - ISO compare, contains box
       none   - neither sortable nor filterable (Actions) */
  var COLUMNS = [
    /* Counts the rows on screen, 1..N. Not stored on the bid and not sortable:
       it IS the order the table is in, so it cannot fall out of sequence the
       way a saved ordinal did every time a bid was deleted. The number that
       identifies a project and follows it around is Proposal No. below. */
    { key: 'sr', label: 'Sr. No.', align: 'center', type: 'none', width: 'w-14',
      render: function (b, i) {
        return '<span class="font-mono text-xs text-slate-400">' + (i + 1) + '</span>';
      } },

    /* The project's identity. Unique across the register - saveBid refuses a
       duplicate - and it flows outward from the bid to its takeoff and its
       proposal document, so one project is one number everywhere it appears. */
    { key: 'proposalNo', label: 'Proposal No.', align: 'center', type: 'text', width: 'w-32',
      value: function (b) { return U.low(b.proposalNo); },
      text: function (b) { return b.proposalNo || ''; },
      render: function (b) {
        return b.proposalNo
          ? '<span class="font-mono text-xs font-semibold text-slate-700">' + U.esc(b.proposalNo) + '</span>'
          : '<span class="text-slate-300">&mdash;</span>';
      } },

    /* Issued by the app when the bid is awarded - see Bids.applyAward. */
    { key: 'awardNo', label: 'Job No.', align: 'center', type: 'text', width: 'w-32',
      value: function (b) { return U.low(b.awardNo); },
      text: function (b) { return b.awardNo || ''; },
      render: function (b) {
        return b.awardNo
          ? '<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono text-[11px] font-semibold whitespace-nowrap">' +
            U.esc(b.awardNo) + '</span>'
          : '<span class="text-slate-300">&mdash;</span>';
      } },

    { key: 'project', label: 'Project', align: 'left', type: 'text', locked: true,
      value: function (b) { return U.low(b.project); },
      text: function (b) { return b.project || ''; },
      render: function (b) {
        var short = b.comments ? b.comments.slice(0, 60) + (b.comments.length > 60 ? '...' : '') : '';
        return '<div class="font-semibold text-slate-800 text-sm flex items-center gap-1.5">' +
          U.esc(b.project) +
          (root.Takeoff.hasTakeoff(b) ? '<i class="fas fa-calculator text-[9px] text-emerald-500" title="Has a takeoff"></i>' : '') +
          (b.proposalId ? '<i class="fas fa-file-contract text-[9px] text-blue-500" title="Has a proposal"></i>' : '') +
          '</div>' +
          (short ? '<div class="text-[10px] text-slate-400 mt-0.5">' + U.esc(short) + '</div>' : '');
      } },

    { key: 'portal', label: 'Portal', align: 'center', type: 'enum',
      value: function (b) { return b.portal || ''; },
      render: function (b) {
        return '<span class="px-2 py-0.5 bg-slate-100 rounded text-xs font-medium text-slate-600">' +
          U.esc(b.portal) + '</span>';
      } },

    { key: 'region', label: 'Region', align: 'left', type: 'enum',
      value: function (b) { return b.region || ''; },
      render: function (b) {
        return U.esc(b.region || '-') +
          (b.inRegion === false ? '<span class="block text-[9px] text-amber-600">out of region</span>' : '');
      } },

    { key: 'products', label: 'Product', align: 'left', type: 'multi',
      value: function (b) { return (b.products || []).join(', '); },
      values: function (b) { return (b.products || []).filter(Boolean); },
      render: function (b) { return root.Bids.productCell(b, 3); } },

    { key: 'material', label: 'Material', align: 'center', type: 'enum',
      value: function (b) { return b.material || ''; },
      render: function (b) {
        var cls = b.material === 'Carbon steel' ? 'bg-orange-50 text-orange-700' :
          b.material === 'Aluminum' ? 'bg-blue-50 text-blue-700' :
          b.material === 'Stainless steel' ? 'bg-slate-100 text-slate-700' :
          b.material === 'Glass' ? 'bg-cyan-50 text-cyan-700' : 'bg-gray-50 text-gray-600';
        return '<span class="px-2 py-0.5 rounded text-[10px] font-medium ' + cls + '">' +
          U.esc(b.material || '-') + '</span>';
      } },

    /* Two columns headed "Engineer" and two pairs headed Estm/Asgn Hrs: one set
       for the intake stage and one for the team, and each view shows exactly
       one of them (see VIEW_COLUMNS). The headers match on purpose - on any
       given tab it reads as one column - so `panelLabel` disambiguates them in
       the column selector and the filter popover, where both are listed. */
    { key: 'engineer', label: 'Engineer', panelLabel: 'Engineer (intake)',
      align: 'center', type: 'enum',
      value: function (b) { return b.engineer || ''; },
      render: function (b) { return root.Bids.engineerCell(b); } },

    { key: 'team', label: 'Engineer', panelLabel: 'Engineer (team)',
      align: 'center', type: 'multi',
      value: function (b) { return root.Assign.engineerList(b).join(', '); },
      values: function (b) { return root.Assign.engineerList(b); },
      render: function (b) { return root.Bids.teamCell(b); } },

    { key: 'lf', label: 'LF', align: 'right', type: 'number',
      value: function (b) { return b.lf == null ? null : U.n(b.lf); },
      render: function (b) { return '<span class="font-mono text-xs text-slate-700">' + U.qty(b.lf) + '</span>'; } },

    { key: 'price', label: 'Bid Price', align: 'right', type: 'number',
      value: function (b) { return b.price == null ? null : U.n(b.price); },
      render: function (b) {
        return '<span class="font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">' +
          U.currency(b.price) +
          (b.priceLocked ? ' <i class="fas fa-lock text-[9px] text-amber-500" title="Locked - a takeoff will not overwrite this"></i>' : '') +
          '</span>';
      } },

    /* The intake pair: the first-pass figures typed on the bid form while the
       bid is still on All Bids.

       There is deliberately no Total Hrs column beside them, nor beside the
       team pair below. Estm and Asgn measure the same work from two sides, so
       adding them counts the job twice - see Assign.totals. */
    { key: 'estHrs', label: 'Estm Hrs', panelLabel: 'Estm Hrs (intake)',
      align: 'right', type: 'number',
      value: function (b) { return U.n(b.estHrs); },
      render: function (b) { return hrs(b.estHrs); } },

    { key: 'assignedHrs', label: 'Asgn Hrs', panelLabel: 'Asgn Hrs (intake)',
      align: 'right', type: 'number',
      value: function (b) { return U.n(b.assignedHrs); },
      render: function (b) { return hrs(b.assignedHrs); } },

    /* The team pair: summed from the bid's assignments, never typed directly,
       so the column and the Team & Hours card cannot disagree. */
    { key: 'activeEstHrs', label: 'Estm Hrs', panelLabel: 'Estm Hrs (team)',
      align: 'right', type: 'number',
      value: function (b) { return root.Assign.totals(b).est; },
      render: function (b) { return hrs(root.Assign.totals(b).est); } },

    { key: 'activeAsgnHrs', label: 'Asgn Hrs', panelLabel: 'Asgn Hrs (team)',
      align: 'right', type: 'number',
      value: function (b) { return root.Assign.totals(b).asgn; },
      render: function (b) { return hrs(root.Assign.totals(b).asgn); } },

    { key: 'dueDate', label: 'Due Date', align: 'center', type: 'date',
      // Sort on the ISO string: it is lexicographically ordered, unlike the
      // MM-DD-YYYY the cell displays.
      value: function (b) { return b.dueDate || ''; },
      text: function (b) { return U.date(b.dueDate); },
      render: function (b) { return '<span class="text-xs text-slate-500 whitespace-nowrap">' + U.date(b.dueDate) + '</span>'; } },

    { key: 'status', label: 'Status', align: 'center', type: 'enum',
      value: function (b) { return b.status || ''; },
      render: function (b) { return root.Bids.statusBadge(b.status); } },

    /* Only meaningful once a bid is decided, so off by default and turned on
       for the Awarded view below. "Decided" comes from the status table rather
       than a second list of status names that would drift from it. */
    { key: 'result', label: 'Result', align: 'center', type: 'enum', offByDefault: true,
      value: function (b) { return decided(b) ? b.status : ''; },
      render: function (b) {
        if (!decided(b)) return '<span class="text-slate-300">&mdash;</span>';
        return root.Bids.statusBadge(b.status);
      } },

    { key: 'actions', label: 'Actions', align: 'center', type: 'none',
      render: function (b) { return root.Bids.actionCell(b); } }
  ];

  /* The heading is what the column says on the tab you are on; the panel name
     is what it is called where every column is listed at once and two of them
     would otherwise both read "Estm Hrs". */
  function panelName(c) { return c.panelLabel || c.label; }

  function col(key) {
    for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i].key === key) return COLUMNS[i];
    return null;
  }

  function textOf(c, b) {
    if (c.text) return c.text(b);
    var v = c.value ? c.value(b) : '';
    return v == null ? '' : String(v);
  }

  /* ---- persisted layout ------------------------------------------------ */

  /* Columns each view starts with. All three share one COLUMNS array; they
     differ only in what is worth showing - Result is noise on Active Bids, and
     a decided bid's LF rarely matters.

     Each view leads with the number its bids actually have. All Bids is the
     intake register, where a job number means nothing yet; Active Bids works
     off the project and proposal numbers; an awarded job is known by its Job
     No. */
  var VIEW_COLUMNS = {
    // Intake: the first-pass engineer and hours, no numbers a bid does not have
    // yet.
    all: { on: ['sr', 'proposalNo', 'engineer', 'estHrs', 'assignedHrs'],
           off: ['awardNo', 'team', 'activeEstHrs', 'activeAsgnHrs'] },

    // Working: the team and what it has booked. The intake pair is deliberately
    // absent - showing both would put two "Estm Hrs" columns side by side.
    active: { on: ['sr', 'proposalNo', 'team', 'activeEstHrs', 'activeAsgnHrs'],
              off: ['awardNo', 'engineer', 'estHrs', 'assignedHrs'] },

    // On a won job, what it cost in effort is the point, so the hours stay on.
    awarded: { on: ['sr', 'result', 'awardNo', 'proposalNo', 'team', 'activeEstHrs', 'activeAsgnHrs'],
               off: ['lf', 'engineer', 'estHrs', 'assignedHrs'],
               // The job register is read by job number, so it leads - behind
               // the row counter, which always comes first.
               first: ['sr', 'awardNo'] }
  };

  function defaults(view) {
    var tweak = VIEW_COLUMNS[view] || {};
    var on = tweak.on || [], off = tweak.off || [], first = tweak.first || [];

    /* COLUMNS declaration order, with this view's leading columns pulled to the
       front. Applied to both lists so the header and the column selector agree. */
    function ordered(keys) {
      var lead = first.filter(function (k) { return keys.indexOf(k) >= 0; });
      return lead.concat(keys.filter(function (k) { return lead.indexOf(k) < 0; }));
    }

    return {
      order: ordered(COLUMNS.map(function (c) { return c.key; })),
      visible: ordered(COLUMNS.filter(function (c) {
        if (c.locked) return true;
        if (on.indexOf(c.key) >= 0) return true;
        if (off.indexOf(c.key) >= 0) return false;
        return !c.offByDefault;
      }).map(function (c) { return c.key; })),
      sort: null,               // { key, dir: 'asc'|'desc' }
      filters: {}               // key -> { contains } or { values: [...] }
    };
  }

  /* Each view keeps its own layout: hiding a column on Awarded Bids should not
     take it away from Active Bids. */
  function cfg() {
    var d = db();
    var view = root.Bids.currentView();
    if (!d.ui.grids) d.ui.grids = {};
    if (!d.ui.grids[view]) d.ui.grids[view] = defaults(view);
    var g = d.ui.grids[view];
    // Heal a layout saved before a column existed, or one naming a column that
    // has since been removed.
    var known = {};
    COLUMNS.forEach(function (c) { known[c.key] = true; });
    g.order = (g.order || []).filter(function (k) { return known[k]; });
    COLUMNS.forEach(function (c) { if (g.order.indexOf(c.key) < 0) g.order.push(c.key); });
    g.visible = (g.visible || []).filter(function (k) { return known[k]; });
    if (!g.visible.length) g.visible = COLUMNS.map(function (c) { return c.key; });
    COLUMNS.forEach(function (c) { if (c.locked && g.visible.indexOf(c.key) < 0) g.visible.push(c.key); });
    if (!g.filters) g.filters = {};
    return g;
  }

  function activeColumns() {
    var g = cfg();
    return g.order.filter(function (k) { return g.visible.indexOf(k) >= 0; }).map(col);
  }

  /* ---- filtering and sorting ------------------------------------------- */

  function passesFilters(b) {
    var g = cfg();
    var keys = Object.keys(g.filters);
    for (var i = 0; i < keys.length; i++) {
      var f = g.filters[keys[i]];
      var c = col(keys[i]);
      if (!c || !f) continue;
      if (f.contains) {
        if (U.low(textOf(c, b)).indexOf(f.contains.toLowerCase()) < 0) return false;
      }
      if (f.values && f.values.length) {
        if (c.type === 'multi') {
          var vals = c.values(b);
          var hit = vals.some(function (v) { return f.values.indexOf(v) >= 0; });
          // An unassigned row matches the explicit "(none)" choice.
          if (!hit && !(vals.length === 0 && f.values.indexOf('') >= 0)) return false;
        } else if (f.values.indexOf(String(c.value(b))) < 0) {
          return false;
        }
      }
    }
    return true;
  }

  function applySort(list) {
    var g = cfg();
    if (!g.sort) return list;
    var c = col(g.sort.key);
    if (!c || c.type === 'none') return list;
    var dir = g.sort.dir === 'desc' ? -1 : 1;
    // Copy: sorting the caller's array in place would reorder db.bids itself.
    return list.slice().sort(function (a, b) {
      var av = c.value(a), bv = c.value(b);
      // Empty values always sink, whichever way the column is sorted, so a
      // descending sort does not fill the top of the table with blanks.
      var ae = av == null || av === '';
      var be = bv == null || bv === '';
      if (ae && be) return 0;
      if (ae) return 1;
      if (be) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  function distinct(key) {
    var c = col(key);
    var counts = {};
    root.Bids.baseList().forEach(function (b) {
      if (c.type === 'multi') {
        var vals = c.values(b);
        if (!vals.length) counts[''] = (counts[''] || 0) + 1;
        vals.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
      } else {
        var v = String(c.value(b) == null ? '' : c.value(b));
        counts[v] = (counts[v] || 0) + 1;
      }
    });
    return Object.keys(counts).sort(function (a, b) {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    }).map(function (v) { return { value: v, count: counts[v] }; });
  }

  function filterCount() {
    var g = cfg();
    return Object.keys(g.filters).filter(function (k) {
      var f = g.filters[k];
      return f && (f.contains || (f.values && f.values.length));
    }).length;
  }

  /* ---- rendering ------------------------------------------------------- */

  function render(list) {
    var host = U.$('bidsGridHost');
    if (!host) return;
    var g = cfg();
    var cols = activeColumns();
    var rows = applySort(list.filter(passesFilters));

    host.innerHTML =
      chipBar() +
      '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">' +
      '<div class="overflow-x-auto max-h-[600px] overflow-y-auto">' +
      '<table class="w-full text-sm grid-table"><thead class="sticky-header"><tr>' +
        cols.map(function (c) { return headerCell(c, g); }).join('') +
      '</tr></thead><tbody>' +
      // The row index goes to render() so a positional column - Sr. No. - can
      // count the rows as they are actually laid out, after sorting and
      // filtering, rather than reading a number off the record.
      (rows.length ? rows.map(function (b, i) {
        // The whole row opens the project page; the Actions cell stops the
        // click so its buttons still do their own thing.
        //
        // A Lost bid stays on Active Bids, so it is muted: still readable, but
        // it must not scan as live work in a list of live work.
        return '<tr onclick="Project.open(' + b.id + ')" class="cursor-pointer' +
          (decided(b) ? ' row-decided' : '') + '" ' +
          'title="Open ' + U.escAttr(b.project || 'this project') + '">' +
          cols.map(function (c) {
          return '<td class="px-3 py-3 col-' + c.align + '">' + c.render(b, i) + '</td>';
        }).join('') + '</tr>';
      }).join('')
        : '<tr><td colspan="' + cols.length + '" class="px-3 py-12 text-center">' +
          '<i class="fas fa-inbox text-3xl text-slate-300 mb-2 block"></i>' +
          '<span class="text-slate-500 text-sm">No bids match the current filters</span>' +
          (filterCount() ? '<button onclick="BidGrid.clearFilters()" class="block mx-auto mt-2 text-blue-600 hover:text-blue-800 text-xs font-medium">Clear all filters</button>' : '') +
          '</td></tr>') +
      '</tbody></table></div>' +
      '<div class="px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500">' +
        rows.length + ' of ' + list.length + ' bids' +
      '</div></div>';
  }

  function headerCell(c, g) {
    var sorted = g.sort && g.sort.key === c.key ? g.sort.dir : null;
    var f = g.filters[c.key];
    var filtered = !!(f && (f.contains || (f.values && f.values.length)));
    var sortable = c.type !== 'none';

    return '<th class="px-3 py-2.5 col-' + c.align + ' ' + (c.width || '') + '">' +
      '<div class="flex items-center gap-1 ' +
        (c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : '') + '">' +
        (sortable
          ? '<button onclick="BidGrid.toggleSort(\'' + c.key + '\')" ' +
            'class="font-semibold text-slate-600 uppercase text-xs tracking-wider hover:text-blue-700 flex items-center gap-1" ' +
            'title="Sort by ' + U.escAttr(c.label) + '">' + U.esc(c.label) +
            '<i class="fas ' + (sorted === 'asc' ? 'fa-sort-up text-blue-600'
              : sorted === 'desc' ? 'fa-sort-down text-blue-600' : 'fa-sort text-slate-300') + ' text-[10px]"></i></button>'
          : '<span class="font-semibold text-slate-600 uppercase text-xs tracking-wider">' + U.esc(c.label) + '</span>') +
        (c.type !== 'none'
          ? '<button onclick="BidGrid.openFilter(event,\'' + c.key + '\')" title="Filter ' + U.escAttr(panelName(c)) + '" ' +
            'class="text-[10px] ' + (filtered ? 'text-blue-600' : 'text-slate-300 hover:text-slate-600') + '">' +
            '<i class="fas fa-filter"></i></button>'
          : '') +
      '</div></th>';
  }

  /* Active filters as removable chips, so a narrowed table never looks empty
     for no visible reason. */
  function chipBar() {
    var g = cfg();
    var chips = [];
    Object.keys(g.filters).forEach(function (k) {
      var f = g.filters[k], c = col(k);
      if (!c || !f) return;
      if (f.contains) chips.push([k, panelName(c) + ' contains "' + f.contains + '"']);
      if (f.values && f.values.length) {
        chips.push([k, panelName(c) + ': ' + f.values.map(function (v) { return v === '' ? '(none)' : v; })
          .slice(0, 3).join(', ') + (f.values.length > 3 ? ' +' + (f.values.length - 3) : '')]);
      }
    });
    if (!chips.length) return '';
    return '<div class="flex flex-wrap items-center gap-2 mb-3">' +
      chips.map(function (ch) {
        return '<span class="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs">' +
          U.esc(ch[1]) +
          '<button onclick="BidGrid.clearFilter(\'' + ch[0] + '\')" class="hover:text-red-600 leading-none">&times;</button></span>';
      }).join('') +
      '<button onclick="BidGrid.clearFilters()" class="text-xs text-slate-500 hover:text-red-600 underline">Clear all</button>' +
      '</div>';
  }

  /* ---- filter popover -------------------------------------------------- */

  var popover = null;

  function closePopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  function openFilter(ev, key) {
    ev.stopPropagation();
    closePopover();
    var c = col(key);
    var g = cfg();
    var f = g.filters[key] || {};

    popover = document.createElement('div');
    popover.className = 'fixed z-50 bg-white border border-slate-300 rounded-lg shadow-2xl p-3 text-xs w-64';
    popover.onclick = function (e) { e.stopPropagation(); };

    var body;
    if (c.type === 'enum' || c.type === 'multi') {
      var opts = distinct(key);
      body = '<input placeholder="Search values..." oninput="BidGrid.filterOptionSearch(this)" ' +
        'class="w-full px-2 py-1 mb-2 bg-slate-50 border border-slate-200 rounded outline-none focus:border-blue-400">' +
        '<div class="max-h-56 overflow-y-auto space-y-0.5" id="filterOptions">' +
        opts.map(function (o) {
          var checked = f.values && f.values.indexOf(o.value) >= 0;
          return '<label class="flex items-center gap-2 px-1 py-0.5 hover:bg-slate-50 rounded cursor-pointer" ' +
            'data-label="' + U.escAttr((o.value || 'none').toLowerCase()) + '">' +
            '<input type="checkbox" value="' + U.escAttr(o.value) + '" ' + (checked ? 'checked' : '') + '>' +
            '<span class="flex-1 truncate">' + (o.value === ''
              ? '<em class="text-slate-400">(none)</em>' : U.esc(o.value)) + '</span>' +
            '<span class="text-slate-400">' + o.count + '</span></label>';
        }).join('') + '</div>';
    } else {
      body = '<input value="' + U.escAttr(f.contains || '') + '" placeholder="Contains..." ' +
        'onkeydown="if(event.key===\'Enter\')BidGrid.applyFilter(\'' + key + '\')" ' +
        'id="filterContains" class="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none focus:border-blue-400">';
    }

    popover.innerHTML =
      '<div class="font-semibold text-slate-700 mb-2">Filter: ' + U.esc(panelName(c)) + '</div>' +
      body +
      '<div class="flex gap-2 mt-3 pt-2 border-t border-slate-100">' +
        '<button onclick="BidGrid.applyFilter(\'' + key + '\')" class="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold">Apply</button>' +
        '<button onclick="BidGrid.clearFilter(\'' + key + '\')" class="px-2 py-1 text-slate-500 hover:text-red-600">Clear</button>' +
      '</div>';

    document.body.appendChild(popover);
    var r = ev.currentTarget.getBoundingClientRect();
    popover.style.left = Math.max(8, Math.min(r.left - 60, window.innerWidth - 280)) + 'px';
    popover.style.top = (r.bottom + 4) + 'px';
    var first = popover.querySelector('input');
    if (first) first.focus();
  }

  /* ---- column selector ------------------------------------------------- */

  function renderColumnPanel() {
    var g = cfg();
    return '<div class="p-3 w-72">' +
      '<div class="flex items-center justify-between mb-2">' +
        '<span class="font-semibold text-slate-700 text-xs uppercase tracking-wider">Columns</span>' +
        '<button onclick="BidGrid.resetColumns()" class="text-[11px] text-blue-600 hover:text-blue-800">Reset</button></div>' +
      '<div class="space-y-0.5 max-h-72 overflow-y-auto">' +
      g.order.map(function (k, i) {
        var c = col(k);
        var on = g.visible.indexOf(k) >= 0;
        return '<div class="flex items-center gap-2 px-1 py-1 hover:bg-slate-50 rounded text-xs">' +
          '<input type="checkbox" ' + (on ? 'checked ' : '') + (c.locked ? 'disabled ' : '') +
            'onchange="BidGrid.toggleColumn(\'' + k + '\')" class="cursor-pointer">' +
          '<span class="flex-1 ' + (c.locked ? 'text-slate-400' : 'text-slate-700') + '">' +
            U.esc(panelName(c)) + (c.locked ? ' <span class="text-[10px]">(always shown)</span>' : '') + '</span>' +
          '<button onclick="BidGrid.moveColumn(\'' + k + '\',-1)" ' + (i === 0 ? 'disabled' : '') +
            ' class="text-slate-300 hover:text-slate-700 disabled:opacity-30"><i class="fas fa-chevron-up text-[9px]"></i></button>' +
          '<button onclick="BidGrid.moveColumn(\'' + k + '\',1)" ' + (i === g.order.length - 1 ? 'disabled' : '') +
            ' class="text-slate-300 hover:text-slate-700 disabled:opacity-30"><i class="fas fa-chevron-down text-[9px]"></i></button>' +
        '</div>';
      }).join('') + '</div></div>';
  }

  /* The column panel repaints itself after each change. It can legitimately be
     absent - the panel may have been dismissed, or these can be driven directly
     - so never assume it is on screen. */
  function refreshColumnPanel() {
    if (popover) popover.innerHTML = renderColumnPanel();
  }

  /* ---- public API ------------------------------------------------------ */

  root.BidGrid = {
    COLUMNS: COLUMNS,
    render: render,
    cfg: cfg,
    activeColumns: activeColumns,
    filterCount: filterCount,

    toggleSort: function (key) {
      var g = cfg();
      if (!g.sort || g.sort.key !== key) g.sort = { key: key, dir: 'asc' };
      else if (g.sort.dir === 'asc') g.sort.dir = 'desc';
      else g.sort = null;                 // third click clears the sort
      root.Store.save();
      root.Bids.filterTable();
    },

    openFilter: openFilter,
    filterOptionSearch: function (input) {
      var q = input.value.toLowerCase();
      var host = popover.querySelector('#filterOptions');
      Array.prototype.forEach.call(host.children, function (el) {
        el.style.display = el.getAttribute('data-label').indexOf(q) >= 0 ? '' : 'none';
      });
    },
    applyFilter: function (key) {
      var g = cfg();
      var c = col(key);
      if (c.type === 'enum' || c.type === 'multi') {
        var picked = [];
        Array.prototype.forEach.call(popover.querySelectorAll('#filterOptions input:checked'),
          function (cb) { picked.push(cb.value); });
        if (picked.length) g.filters[key] = { values: picked };
        else delete g.filters[key];
      } else {
        var v = popover.querySelector('#filterContains').value.trim();
        if (v) g.filters[key] = { contains: v };
        else delete g.filters[key];
      }
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },
    clearFilter: function (key) {
      delete cfg().filters[key];
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },
    clearFilters: function () {
      cfg().filters = {};
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },

    openColumns: function (ev) {
      ev.stopPropagation();
      closePopover();
      popover = document.createElement('div');
      popover.className = 'fixed z-50 bg-white border border-slate-300 rounded-lg shadow-2xl';
      popover.onclick = function (e) { e.stopPropagation(); };
      popover.innerHTML = renderColumnPanel();
      document.body.appendChild(popover);
      var r = ev.currentTarget.getBoundingClientRect();
      popover.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
      popover.style.top = (r.bottom + 4) + 'px';
    },
    toggleColumn: function (key) {
      var g = cfg();
      var c = col(key);
      if (c.locked) return;
      var i = g.visible.indexOf(key);
      if (i >= 0) g.visible.splice(i, 1); else g.visible.push(key);
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    moveColumn: function (key, dir) {
      var g = cfg();
      var i = g.order.indexOf(key);
      var j = i + dir;
      if (i < 0 || j < 0 || j >= g.order.length) return;
      var tmp = g.order[i]; g.order[i] = g.order[j]; g.order[j] = tmp;
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    resetColumns: function () {
      var view = root.Bids.currentView();
      db().ui.grids[view] = defaults(view);
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    closePopover: closePopover
  };

  document.addEventListener('click', closePopover);
  window.addEventListener('scroll', closePopover, true);
})(window);
