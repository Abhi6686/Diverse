/* store.js - single source of truth.
 *
 * The whole app lives in one plain object held in memory. Everything reads and
 * writes it synchronously; this module is the only thing that knows how it gets
 * to disk.
 *
 * Backing store, in order of preference:
 *   1. IndexedDB  - no practical size limit, holds document blobs
 *   2. localStorage - ~5 MB, no documents (Firefox/Safari on file:// land here)
 *   3. memory only - private-browsing edge cases; warns loudly
 *
 * Boot is async (Store.open()); everything after it is synchronous, exactly as
 * before, so no other module had to change.
 */
(function (root) {
  'use strict';

  var LS_KEY = 'dvbid.v1';
  var LS_BACKUP_KEY = 'dvbid.v1.backup';
  /* Column layouts and the last tab you were on. Personal, not shared, so it
     stays in this browser even when the records come from the server. */
  var UI_KEY = 'dvbid.ui';
  var IDB_NAME = 'diverse-bid';
  var IDB_VERSION = 1;
  var STATE_KEY = 'db';
  var SCHEMA_VERSION = 16;
  /* Column layouts version separately from the records. They have to: since
     accounts arrived they live in the server's user_prefs table and reach the
     app on their own route, so a migration gated on the record schema never
     sees them. See migrateUI. */
  var UI_VERSION = 13;
  var SAVE_DEBOUNCE_MS = 400;

  /* Bid-level product categories for the Add/Edit Bid form. Deliberately
     coarser than the takeoff sheet types in rates.js - this answers "what kind
     of job is this", the takeoff answers "which sheet am I estimating". */
  var DEFAULT_PRODUCT_TYPES = ['Railing', 'Metal Platform', 'Bollard', 'Metal Stairs'];

  /* What a product is made from. These were six <option> tags hardcoded in the
     Add/Edit Bid form until a product could carry more than one of them; now
     they are a managed list like regions and task types, editable from
     Settings > Materials. */
  var DEFAULT_MATERIALS = [
    'Carbon steel', 'Aluminum', 'Stainless steel', 'Glass', 'Wood', 'Galvanized Steel'
  ];

  /* What an engineer's time on an active bid gets booked against. Managed from
     Settings > Task Types; these are only the starting list. */
  var DEFAULT_TASK_TYPES = [
    'Estimating', 'Take-off', 'Shop drawings', 'Submittal review',
    'Site measure', 'Proposal prep', 'Revisions', 'Coordination'
  ];

  /* Where a bid came in from. Six <option> tags in the Add/Edit Bid form until
     the office started using a portal that was not one of them; a managed list
     now, like materials and task types, editable from Settings > Portals. */
  var DEFAULT_PORTALS = [
    'PlanHub', 'ConstructConnect', 'BuildingConnected', 'PennBid', 'SmartBid', 'Other'
  ];

  var DB = null;
  var idb = null;                 // IDBDatabase once open
  var backend = 'memory';
  var saveTimer = null;
  var listeners = [];
  var statusListeners = [];
  var channel = null;
  var tabId = Math.random().toString(36).slice(2);
  var lastStatus = { state: 'idle', at: null };
  var externalChangeHandler = null;
  var serverUser = null;
  var online = true;          // false once the server stops answering
  var conflictHandler = null;
  /* Set by the two operations that replace the whole database rather than edit
     part of it - Load and Reset - and read by the next write, so the server can
     hold them to project.load. Cleared as soon as it is used. */
  var nextReason = null;

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  /* The seeded bids already name their engineers, so the register is derived
     from them rather than starting empty and making every one of those initials
     look like a stranger.

     Done here, at creation, rather than in migrate(): migrate() runs on every
     load, so re-deriving there would undo a deliberate removal from the
     register - see Bids.removeEngineer, which keeps the initials on the bids on
     purpose. */
  function seedEngineers(bids) {
    var seen = {}, out = [];
    bids.forEach(function (b) {
      var v = String(b.engineer || '').trim();
      if (!v || seen[v.toLowerCase()]) return;
      seen[v.toLowerCase()] = true;
      out.push({ id: uid('eng'), initials: v, name: '', active: true, userId: null });
    });
    return out;
  }

  /* THE SHAPE OF A STORED RECORD LIVES HERE, not in the module that owns the
     screen for it.

     Both of the things below are needed by migrate() and by the seed path, and
     neither of those may depend on a module loaded after this one -
     js/products.js and js/assignments.js both are. Those modules call back into
     these, so there is still one definition of each. tests/verify-lancaster.js
     loads store.js without either of them and used to crash here. */

  /* The statuses that mean a bid has been decided - the non-open buckets of the
     STATUSES table in js/bids.js. Kept here as plain strings because migrate()
     must not depend on a module loaded after this one. */
  var DECIDED_STATUSES = ['Awarded', 'Lost', 'No Scope'];

  /* Working-day arithmetic. Assign re-exports the same rules for the card. */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function shiftISO(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function isWeekendISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return false;
    var n = new Date(+m[1], +m[2] - 1, +m[3]).getDay();
    return n === 0 || n === 6;
  }

  /* `count` working days from the start, weekends skipped. */
  function workingRunISO(startISO, count) {
    var out = [], day = startISO || todayISO(), guard = 0;
    while (isWeekendISO(day) && guard++ < 7) day = shiftISO(day, 1);
    while (out.length < count) {
      out.push(day);
      day = shiftISO(day, 1);
      guard = 0;
      while (isWeekendISO(day) && guard++ < 7) day = shiftISO(day, 1);
    }
    return out;
  }

  /* A bid's products and its single material become one row per product, each
     carrying that material. */
  function productLinesFromFlat(bid) {
    var materials = String(bid.material == null ? '' : bid.material)
      .split(',').map(function (m) { return m.trim(); }).filter(Boolean);
    return (bid.products || []).filter(Boolean).map(function (p) {
      return { id: uid('pl'), product: p, materials: materials.slice() };
    });
  }

  /* The seeded bids are a starting register written before several of the
     fields a bid now carries existed, so they need the same treatment migrate()
     gives historical records.

     It has to happen HERE as well as in migrate(), and that is the whole point:
     a brand new database is stamped with the current schemaVersion, so it never
     runs a single migration step. Anything added to a bid needs a line in both
     places or it is missing on precisely the databases nobody thought to test -
     the new ones. */
  function prepareSeedBids(bids) {
    bids.forEach(function (b) {
      // When the enquiry arrived. Inferred, and flagged as inferred, so the
      // Created column can say "about" rather than presenting a guess as fact.
      if (b.createdAt === undefined) {
        b.createdAt = b.dueDate || null;
        b.createdAtInferred = true;
      }
      // One row per product, each carrying its own materials - see js/products.js.
      if (!Array.isArray(b.productLines)) b.productLines = productLinesFromFlat(b);
    });
    return bids;
  }

  function freshDB() {
    var bids = prepareSeedBids(JSON.parse(JSON.stringify(root.SEED_BIDS || [])));
    return {
      schemaVersion: SCHEMA_VERSION,
      regions: (root.SEED_REGIONS || []).slice(),
      productTypes: DEFAULT_PRODUCT_TYPES.slice(),
      taskTypes: DEFAULT_TASK_TYPES.slice(),
      materials: DEFAULT_MATERIALS.slice(),
      portals: DEFAULT_PORTALS.slice(),
      /* The statuses this shop has ADDED. The seven the lifecycle is built on
         live in the STATUSES table in js/bids.js and are not data: Awarded and
         Lost are issued by the award decision, and each one's bucket decides
         what counts as open. These are the extra stages an office wants beside
         them - "On Hold", "Waiting on drawings" - and they are all open work. */
      statuses: [],
      engineers: seedEngineers(bids),
      references: JSON.parse(JSON.stringify(root.REFERENCE_SEED || [])),
      bids: bids,
      takeoffs: {},
      proposals: {},
      catalog: [],
      rates: null,      // filled by rates.js on first boot
      company: Object.assign({}, root.COMPANY_DEFAULT || {}),
      ui: { version: UI_VERSION,
            collapsed: {}, lastTakeoffId: null, lastProposalId: null,
            grids: {}, module: 'bids', section: 'active',
            projectBidId: null, settingsSection: 'ratelib',
            // 'auto' | 'light' | 'dark' - see App.cycleTheme. Listed here so
            // adoptUI() carries it back off the server with everything else.
            theme: 'auto' }
    };
  }

  /* A drawing-takeoff column heading used to carry its unit as prose -
     'Top Rail_1-1/2" Pipe (LF)'. The unit is a field of its own now, because a
     material row divides by it and cannot read English.

     It lives here, in the lowest-level module, rather than in
     js/takeoff.model.js where it is mostly used: the schema-16 migration needs
     it, and migrate() runs on a database loaded by store.js, which the browser
     parses before takeoff.model.js exists. TakeoffModel.splitColumnUnit is this
     function - see the delegation there - so there is still one definition.

     Only a recognised unit is taken. '(LF)' is a unit; '(typ.)' and
     '(see detail 3)' are notes on the drawing, and stripping those out of a
     heading would lose what it said. */
  var COLUMN_UNITS = ['EA', 'LF', 'FT', 'IN', 'SF', 'SY', 'LB', 'PKT', 'BOX',
                      'ROLL', 'SHT', 'SET', 'PR', 'STK', 'GAL', 'HRS'];

  function splitColumnUnit(label) {
    var s = String(label == null ? '' : label).trim();
    var m = /^([\s\S]*?)\s*\(\s*([A-Za-z\/]{1,4})\s*\)\s*$/.exec(s);
    if (m && COLUMN_UNITS.indexOf(m[2].toUpperCase()) >= 0) {
      return { label: m[1].trim(), um: m[2].toUpperCase() };
    }
    return { label: s, um: '' };
  }

  /* The single Hrs column became Est Hrs + Assigned Hrs, and one saved layout
     became one per view (All / Active / Awarded).

     A plain rename would not do: BidGrid.cfg() heals an unknown layout by
     *appending* missing keys, so without this the two new columns would land to
     the right of Actions for everyone who has ever touched the column selector.
     They belong where Hrs was. */
  function migrateGridLayouts(db) {
    var old = db.ui && db.ui.bidsGrid;
    if (db.ui) delete db.ui.bidsGrid;
    if (!old || !Array.isArray(old.order)) return;

    function splice(list) {
      if (!Array.isArray(list)) return list;
      var i = list.indexOf('totalHrs');
      if (i < 0) return list;
      var out = list.slice();
      out.splice(i, 1, 'estHrs', 'assignedHrs');
      return out;
    }

    var order = splice(old.order);
    // Total Hrs stays selectable but is no longer shown by default; the two
    // columns that replaced it are.
    var visible = splice(old.visible).filter(function (k) { return k !== 'totalHrs'; });
    if (order.indexOf('totalHrs') < 0) order.push('totalHrs');

    db.ui.grids = db.ui.grids || {};
    ['all', 'active', 'awarded'].forEach(function (view) {
      if (db.ui.grids[view]) return;
      db.ui.grids[view] = {
        order: order.slice(),
        visible: visible.slice(),
        // Sort and filters were set for one table; carrying them onto three
        // would silently narrow views the estimator has never opened.
        sort: view === 'active' ? old.sort || null : null,
        filters: view === 'active' ? old.filters || {} : {}
      };
    });
  }

  /* The display ordinal `#` (sr) became a typed Project No., and an awarded bid
     now carries a Job No. as well.

     Same trap as migrateGridLayouts: BidGrid.cfg() heals an unknown layout by
     *appending*, so without this both columns would land to the right of
     Actions for everyone who has ever touched the column selector. They belong
     where the ordinal was. */
  function migrateBidNoColumns(db) {
    var grids = (db.ui && db.ui.grids) || {};
    Object.keys(grids).forEach(function (view) {
      var g = grids[view];
      if (!g) return;

      function place(list, showAward) {
        if (!Array.isArray(list)) return list;
        var out = list.filter(function (k) { return k !== 'projectNo' && k !== 'awardNo'; });
        var i = out.indexOf('sr');
        var repl = showAward ? ['projectNo', 'awardNo'] : ['projectNo'];
        if (i >= 0) out.splice.apply(out, [i, 1].concat(repl));
        else out.unshift.apply(out, repl);
        return out;
      }

      // Order carries both so the column selector can offer either one; only
      // the views that want it start with Job No. switched on.
      g.order = place(g.order, true);
      g.visible = place(g.visible, view !== 'active');
      // Project No. is an Active-Bids concern; an awarded job is known by its
      // Job No. instead.
      if (view === 'awarded') {
        g.visible = g.visible.filter(function (k) { return k !== 'projectNo'; });
      }
    });
  }

  /* Proposal No. moved onto the bid, and All Bids stopped showing Job No.
     Same appending trap as the two migrations above. */
  function migrateProposalNoColumn(db) {
    var grids = (db.ui && db.ui.grids) || {};
    Object.keys(grids).forEach(function (view) {
      var g = grids[view];
      if (!g) return;

      function place(list, show) {
        if (!Array.isArray(list)) return list;
        var out = list.filter(function (k) { return k !== 'proposalNo'; });
        if (!show) return out;
        var i = out.indexOf('projectNo');
        if (i < 0) i = out.indexOf('awardNo');
        out.splice(i < 0 ? 0 : i + 1, 0, 'proposalNo');
        return out;
      }

      g.order = place(g.order, true);
      g.visible = place(g.visible, view !== 'all');
      // A job number means nothing on a bid that has not been worked yet, so
      // the intake register does not carry the column.
      if (view === 'all') {
        g.visible = (g.visible || []).filter(function (k) { return k !== 'awardNo'; });
      }
    });
  }

  /* Project No. became Sr. No. - a counter over the rows rather than a value on
     the record. Every saved layout has to swap one for the other, in place, or
     BidGrid.cfg() would append the new column past Actions. Sr. No. is on every
     view: it is just the row number. */
  function migrateSrColumn(db) {
    var grids = (db.ui && db.ui.grids) || {};
    Object.keys(grids).forEach(function (view) {
      var g = grids[view];
      if (!g) return;

      function swap(list) {
        if (!Array.isArray(list)) return list;
        var out = list.filter(function (k) { return k !== 'sr'; });
        var i = out.indexOf('projectNo');
        if (i >= 0) out.splice(i, 1, 'sr');
        else out.unshift('sr');            // never had one - it leads
        return out;
      }

      g.order = swap(g.order);
      g.visible = swap(g.visible);
      // A sort or filter on a column that no longer holds a value would silently
      // narrow the table to nothing.
      if (g.sort && g.sort.key === 'projectNo') g.sort = null;
      if (g.filters) delete g.filters.projectNo;
    });
  }

  /* The active stage got its own hours, summed from bid.assignments, so the
     table now has two Engineer columns and two Estm/Asgn pairs - one per stage.
     Same appending trap as the migrations above: each new key has to land
     beside the intake column it mirrors, not past Actions. */
  function migrateHoursColumns(db) {
    var AFTER = {                       // new key -> the column it sits behind
      team: 'engineer',
      activeEstHrs: 'estHrs',
      activeAsgnHrs: 'assignedHrs',
      activeTotalHrs: 'totalHrs'
    };
    // Which stage's columns each view shows. Intake on All Bids, the team
    // everywhere a bid has actually been worked.
    var SHOW_TEAM = { all: false, active: true, awarded: true };

    var grids = (db.ui && db.ui.grids) || {};
    Object.keys(grids).forEach(function (view) {
      var g = grids[view];
      if (!g) return;
      var team = !!SHOW_TEAM[view];

      function place(list, apply) {
        if (!Array.isArray(list)) return list;
        var out = list.filter(function (k) { return !AFTER[k]; });
        if (!apply) return out;
        Object.keys(AFTER).forEach(function (key) {
          var i = out.indexOf(AFTER[key]);
          out.splice(i < 0 ? out.length : i + 1, 0, key);
        });
        return out;
      }

      g.order = place(g.order, true);
      // Total Hrs stays off by default on both stages, as it was.
      g.visible = place(g.visible, team).filter(function (k) { return k !== 'activeTotalHrs'; });
      if (team) {
        // The two stages are never shown side by side - two columns headed
        // "Estm Hrs" in one table would be unreadable.
        g.visible = g.visible.filter(function (k) {
          return ['engineer', 'estHrs', 'assignedHrs', 'totalHrs'].indexOf(k) < 0;
        });
      }
    });
  }

  /* `finish.label` became the part after a fixed "Finish - " prefix, so a
     stored "Finish: Painted" would otherwise render as
     "Finish - Finish: Painted". Idempotent: running it twice is a no-op. */
  var FINISH_LEAD = /^\s*finish\s*[-:–—]?\s*/i;

  function migrateFinishLabels(db) {
    Object.keys(db.takeoffs || {}).forEach(function (k) {
      (db.takeoffs[k].products || []).forEach(function (p) {
        // A rename stored in rowLabels is now held in finish.label itself,
        // since that is the only field the finish row's input writes to.
        if (p.rowLabels && p.rowLabels.finish) {
          if (p.finish) p.finish.label = p.rowLabels.finish;
          delete p.rowLabels.finish;
        }
        if (p.finish && typeof p.finish.label === 'string') {
          p.finish.label = p.finish.label.replace(FINISH_LEAD, '');
        }
      });
    });
  }

  /* ---- layout migrations ------------------------------------------------ */

  /* Column layouts, versioned on their own, because they no longer travel with
     the records: a signed-in user's layout comes from the server's user_prefs
     table and is attached after migrate() has finished with the database. A
     step gated on schemaVersion therefore never runs on it. Everything that
     touches ui from here on belongs in this function, which both paths call -
     migrate() for a local database or an imported .json, adoptUI() for a
     layout arriving from the server.

     The pre-12 layout steps below stay where they are, inside migrate(). They
     only ever ran against a db.ui, and re-running them on a layout that has
     already had them would undo their own work - migrateBidNoColumns would put
     back the Project No. column that migrateSrColumn removed.

     An unversioned layout is treated as 11 rather than zero: version stamping
     started at 12, so a layout without one was written by the build immediately
     before it, which had already applied the pre-12 steps inside migrate().

     This is a FIXED number, not UI_VERSION - 1. Deriving it from the current
     version means every future bump silently moves the floor up with it, and
     the step that was just added is the one step those old layouts never
     get - which is exactly the layout that needs it most. */
  var UI_VERSION_BEFORE_STAMPING = 11;

  function migrateUI(ui) {
    if (!ui || typeof ui !== 'object') return ui;
    var v = ui.version == null ? UI_VERSION_BEFORE_STAMPING : ui.version;

    if (v < 12) {
      // Estm Hrs + Asgn Hrs measure the same work two ways, so their sum was
      // never a meaningful figure and the two Total Hrs columns are gone. A
      // layout that still names them would otherwise ask BidGrid for a column
      // that no longer exists.
      dropColumns(ui, ['totalHrs', 'activeTotalHrs']);
    }

    if (v < 13) {
      /* Job No. is gone because a project now has one number for its whole life
         - the column would have repeated Proposal No. exactly. LF is gone
         because it is a takeoff figure and was a column of dashes on the
         register. Both have to come out of every saved layout, along with any
         sort or filter pointing at them: a sort on a column that no longer has
         a value silently reorders the table by nothing. */
      dropColumns(ui, ['awardNo', 'lf']);
    }

    ui.version = UI_VERSION;
    return ui;
  }

  /* Takes the named columns out of every saved view - the order, the visible
     list, and any sort or filter set on them. A sort left pointing at a column
     that no longer has a value would silently reorder the table by nothing; a
     filter would silently narrow it to nothing. */
  function dropColumns(ui, keys) {
    var grids = ui.grids || {};
    Object.keys(grids).forEach(function (view) {
      var g = grids[view];
      if (!g) return;
      function without(list) {
        return Array.isArray(list)
          ? list.filter(function (k) { return keys.indexOf(k) < 0; })
          : list;
      }
      g.order = without(g.order);
      g.visible = without(g.visible);
      if (g.sort && keys.indexOf(g.sort.key) >= 0) g.sort = null;
      if (g.filters) keys.forEach(function (k) { delete g.filters[k]; });
    });
  }

  /* Runs on every load so a .json saved by an older build still opens. */
  function migrate(db) {
    if (!db || typeof db !== 'object') return freshDB();
    var v = db.schemaVersion || 0;

    if (v < 1) {
      // Pre-versioned files: bids carried a separate `county` field and stored
      // "In Region"/"Not in Region" in `region`, which broke the search filter.
      (db.bids || []).forEach(function (b) {
        var reg = (b.region || '').trim();
        if (reg === 'In Region' || reg === 'Not in Region' || reg === '') {
          b.inRegion = reg === 'In Region';
          b.region = (b.county || '').trim();
        } else if (b.inRegion === undefined) {
          b.inRegion = true;
        }
        delete b.county;
      });
      db.schemaVersion = 1;
    }

    if (v < 2) {
      // Field renames driven by the estimating team's terminology:
      //   railing   -> productType   ("Railing Type" became "Product")
      //   scopeHrs  -> assignedHrs   ("Scope Prep Hrs" became "Assigned Hrs")
      // bidHrs stays on the record - it is off the form now, but zeroing it
      // would silently change the Total Hrs on every historical bid.
      (db.bids || []).forEach(function (b) {
        if (b.productType === undefined) b.productType = b.railing || '';
        delete b.railing;
        if (b.assignedHrs === undefined) b.assignedHrs = b.scopeHrs || 0;
        delete b.scopeHrs;
        if (b.engineer === undefined) b.engineer = '';
      });
      db.schemaVersion = 2;
    }

    if (v < 3) {
      // Product became a managed dropdown. Existing free-text values stay on
      // their bids untouched - they surface as a one-off option when you edit
      // that bid, rather than polluting the list for everyone.
      db.productTypes = DEFAULT_PRODUCT_TYPES.slice();
      db.schemaVersion = 3;
    }

    if (v < 4) {
      // A project can carry several products, so the single productType string
      // becomes a products array. `db.productTypes` remains the master list of
      // choices; `bid.products` is what a given bid has selected from it.
      (db.bids || []).forEach(function (b) {
        if (!Array.isArray(b.products)) {
          b.products = b.productType ? [b.productType] : [];
        }
        delete b.productType;
      });
      db.schemaVersion = 4;
    }

    if (v < 5) {
      // Cost & Labour rows became hideable, renamable and individually
      // excludable from the proposal. All three maps store only the
      // exceptions, so "everything visible, default labels, all ticked" is the
      // empty object and no existing takeoff needs data written to it.
      Object.keys(db.takeoffs || {}).forEach(function (k) {
        (db.takeoffs[k].products || []).forEach(function (p) {
          if (!p.hiddenRows) p.hiddenRows = {};
          if (!p.rowLabels) p.rowLabels = {};
          if (!p.proposalRows) p.proposalRows = {};
        });
        if (db.takeoffs[k].rollup && !db.takeoffs[k].rollup.roundMode) {
          // Existing takeoffs keep the roundoff the estimator typed; only new
          // ones default to rounding up to the next 10.
          db.takeoffs[k].rollup.roundMode = 'manual';
        }
      });
      // Seed the engineers register from whatever is already on the bids.
      db.engineers = db.engineers || [];
      var seen = {};
      db.engineers.forEach(function (e) { seen[e.initials.toLowerCase()] = true; });
      (db.bids || []).forEach(function (b) {
        var v2 = (b.engineer || '').trim();
        if (!v2 || seen[v2.toLowerCase()]) return;
        seen[v2.toLowerCase()] = true;
        db.engineers.push({ id: uid('eng'), initials: v2, name: '', active: true, userId: null });
      });
      db.schemaVersion = 5;
    }

    if (v < 6) {
      // The References tab was hardcoded markup. Rates change, so the tables
      // move into the database where they can be edited and kept.
      db.references = JSON.parse(JSON.stringify(root.REFERENCE_SEED || []));
      db.schemaVersion = 6;
    }

    if (v < 7) {
      migrateGridLayouts(db);
      migrateFinishLabels(db);
      db.schemaVersion = 7;
    }

    if (v < 8) {
      // `sr` was a display ordinal nobody referred to. Project No. is typed by
      // the estimator; Job No. is issued by the app when a bid is awarded.
      // sr stays on the record - it is still in the XLSX export, and dropping a
      // field from historical .json files buys nothing.
      (db.bids || []).forEach(function (b) {
        if (b.projectNo === undefined) b.projectNo = b.sr == null ? '' : String(b.sr);
        if (b.awardNo === undefined) b.awardNo = null;
        if (b.awardedAt === undefined) b.awardedAt = null;
      });
      migrateBidNoColumns(db);
      db.schemaVersion = 8;
    }

    if (v < 9) {
      // The three bid tabs became three stages of a lifecycle rather than three
      // filters over one status field, so a bid now records whether anybody has
      // picked it up as well as what state it is in.
      (db.bids || []).forEach(function (b) {
        if (b.status === 'Submitted') b.status = 'Submitted to review';
        if (b.proposalNo === undefined) b.proposalNo = '';
        // Everything that predates promotion was already in play; marking it
        // active is what keeps Active Bids from emptying out on upgrade. Only
        // bids entered from here on start as intake.
        if (b.active === undefined) b.active = true;
        if (b.activatedAt === undefined) b.activatedAt = null;
        if (b.decidedAt === undefined) b.decidedAt = b.status === 'Lost' ? (b.dueDate || null) : null;
      });
      migrateProposalNoColumn(db);
      db.schemaVersion = 9;
    }

    if (v < 10) {
      // The active stage got its own hours: a row per engineer per task, summed
      // into the bid's team totals.
      (db.bids || []).forEach(function (b) {
        // Deliberately empty rather than seeded from estHrs/assignedHrs. Those
        // are the first-pass figures put on a bid at intake; carrying a guess
        // made before anyone picked the job up into the record of who actually
        // worked it is exactly the conflation this split exists to end.
        if (!Array.isArray(b.assignments)) b.assignments = [];
      });
      if (!Array.isArray(db.taskTypes) || !db.taskTypes.length) {
        db.taskTypes = DEFAULT_TASK_TYPES.slice();
      }
      migrateHoursColumns(db);
      db.schemaVersion = 10;
    }

    if (v < 11) {
      /* The typed Project No. is gone. It was a number a bid carried without
         anything guaranteeing it meant one project - two bids could hold the
         same one, and nothing followed it to the takeoff or the proposal.

         Its two jobs are now split properly: the position in the table is a
         Sr. No. counted at render time, so it can never fall out of sequence;
         and the identity is Proposal No., which is unique and does follow the
         project through its documents.

         Any Project No. that is NOT the old row ordinal was typed on purpose,
         so it is moved into Proposal No. where a real number belongs - unless
         that would collide with one already there, in which case the existing
         value wins and the old one is dropped rather than silently renumbering
         someone's proposal. */
      var taken = {};
      (db.bids || []).forEach(function (b) {
        var pn = String(b.proposalNo || '').trim();
        if (pn) taken[pn.toLowerCase()] = true;
      });
      (db.bids || []).forEach(function (b) {
        var old = String(b.projectNo == null ? '' : b.projectNo).trim();
        var wasOrdinal = old === '' || old === String(b.sr);
        if (!wasOrdinal && !String(b.proposalNo || '').trim() && !taken[old.toLowerCase()]) {
          b.proposalNo = old;
          taken[old.toLowerCase()] = true;
        }
        delete b.projectNo;
      });
      migrateSrColumn(db);
      db.schemaVersion = 11;
    }

    if (v < 12) {
      /* ONE NUMBER FOR THE PROJECT'S LIFE.

         DIS-<yy>-<0001> used to be issued at award, as a job number, which was
         too late to be any use: the proposal that won the job had already gone
         out under whatever Proposal No. somebody typed. It is now issued when a
         bid is picked up, and it IS the Proposal No.

         So a bid that already carries one carries it in the wrong field. It is
         moved across, because that number is what the project is already known
         by - on paper, and to the people who sent it. awardNo keeps a copy: the
         server has a unique index on it and the XLSX export still lists it, and
         a bid that was awarded genuinely does have an award number - it just is
         not a *different* number any more.

         A bid whose Proposal No. was typed by hand keeps it. It is already on a
         document somewhere, and renumbering it here would make that document
         refer to nothing. */
      (db.bids || []).forEach(function (b) {
        var award = String(b.awardNo || '').trim();
        if (award && !String(b.proposalNo || '').trim()) b.proposalNo = award;

        if (b.revisedDueDate === undefined) b.revisedDueDate = '';

        /* When the enquiry arrived. Nothing recorded it before, so it is
           inferred from the earliest thing that did happen to the bid, and
           `createdAtInferred` marks it as a guess - the Created column says so
           rather than showing a made-up timestamp as if it were observed. */
        if (b.createdAt === undefined) {
          var known = [b.activatedAt, b.awardedAt, b.decidedAt]
            .filter(function (d) { return d; }).sort();
          b.createdAt = known[0] || b.dueDate || null;
          b.createdAtInferred = true;
        }
      });
      db.schemaVersion = 12;
    }

    if (v < 13) {
      /* Products and materials were two unrelated fields: a list of products,
         and one material beside it. On a project with three products in two
         materials nothing recorded which was which - the pairing existed in the
         estimator's head and nowhere else.

         They are rows now, one product per row carrying its own materials.
         Every existing bid is turned into rows by pairing each of its products
         with the single material it had, which is the only reading of the old
         data that is definitely true.

         products and material stay on the record and stay accurate: they are
         rewritten from the rows by Products.sync, which is also what keeps the
         grid columns and their filters working untouched. */
      (db.bids || []).forEach(function (b) {
        if (Array.isArray(b.productLines)) return;
        b.productLines = productLinesFromFlat(b);
      });
      db.schemaVersion = 13;
    }

    if (v < 14) {
      /* Assignment rows gained a day-by-day booking, and asgnHrs became its
         sum rather than a figure typed on its own.

         Every existing row already carries a total somebody typed, and that
         total is real work somebody recorded - so it is spread across three
         working days from the bid's start rather than discarded. The figure
         each row reports is therefore unchanged by this migration, which is
         what keeps the bids table, the project card and the export reading the
         same numbers they did yesterday.

         Three days is a guess about the shape of the work, not about its size,
         and the estimator can re-spread it. Zeroing the totals to avoid making
         that guess would have thrown away the size as well. */
      (db.bids || []).forEach(function (b) {
        (b.assignments || []).forEach(function (r) {
          if (Array.isArray(r.days)) return;
          // Through IST rather than sliced: createdAt is a moment, and its UTC
          // date is the previous day for anything entered before 05:30. See
          // U.stampISO.
          r.startDate = r.startDate || b.activatedAt ||
            (root.U ? root.U.stampISO(b.createdAt) : '') || todayISO();
          var run = workingRunISO(r.startDate, 3);
          var total = Number(r.asgnHrs) || 0;
          // Split three ways, with the remainder on the first day so the sum is
          // exact rather than out by a cent of an hour.
          var each = Math.round((total / run.length) * 100) / 100;
          r.days = run.map(function (d, i) {
            return { date: d, hrs: i === 0 ? Math.round((total - each * (run.length - 1)) * 100) / 100 : each };
          });
          r.asgnHrs = r.days.reduce(function (s, d) { return s + (Number(d.hrs) || 0); }, 0);
        });
      });
      db.schemaVersion = 14;
    }

    if (v < 15) {
      /* UNDOING THE BLANKET ACTIVE FLAG.

         Migration 9 marked every existing bid active when the three tabs became
         three stages, so that Active Bids would not empty out on upgrade. It
         was the safe guess at the time and it was wrong: it put the entire
         intake register on the working list, where ninety-odd enquiries nobody
         had picked up sat alongside the two jobs actually being worked. The
         giveaway is that almost none of them have an activatedAt - they never
         went through Bids.addToActive at all.

         A bid is picked up when somebody adds it to Active Bids, and that is
         what issues its proposal number (see Bids.addToActive and
         issueProjectNo). So carrying a number is the test for having been
         picked up, and it is the one used here.

         NOTHING IS DELETED. The bid keeps its team rows, hours, takeoff,
         proposal and history; it goes back to All Bids, which is where it has
         been all along, and Add to Active bid brings it back - with a number
         this time. activatedAt is cleared with the flag so that promotion
         behaves as the fresh one it would be, rather than stamping the number
         with a date from a promotion that never happened.

         No history entries. This corrects a flag that was never right; it is
         not a decision anybody made, and one entry per bid would bury the log
         under a migration. */
      (db.bids || []).forEach(function (b) {
        if (!b.active) return;
        if (String(b.proposalNo || '').trim()) return;
        // A bid with an outcome is never quietly taken off a list. The outcome
        // is the STATUS - the lifecycle's one source of truth, see the STATUSES
        // table in js/bids.js - and not the award date fields, which can be
        // left behind by an award that was later reversed. (Named here rather
        // than read from Bids.bucketOf because migrate() runs before js/bids.js
        // exists; see the note at the top of this file.)
        if (DECIDED_STATUSES.indexOf(b.status) >= 0) return;
        b.active = false;
        b.activatedAt = null;
      });
      db.schemaVersion = 15;
    }

    if (v < 16) {
      /* WHAT THE JOB NEEDS, AND WHAT THE VENDOR SELLS.
       *
       * A material row held one quantity, and it was the number of things to
       * buy. The measurement it came from - 76.9 feet of pipe - and the stock
       * length it was divided by - 21 feet to a stick - existed only on the
       * estimator's calculator. Nothing in the file recorded either, so nobody
       * could check the division, and re-measuring a drawing meant redoing it
       * by hand.
       *
       * The two halves are fields now. Every row gets them empty, and empty is
       * exactly the old behaviour: with no scope and no pack size, orderQty
       * returns the typed quantity verbatim and the row costs what it always
       * did. See TakeoffModel.orderQty, which says so at more length and is the
       * reason tests/verify-lancaster.js still reproduces the workbook without
       * a line changed.
       *
       * Deliberately NOT done here: linking existing rows to scopes by matching
       * their Feature text to a column heading. It would re-key the quantities
       * on bids that have already gone out, on the strength of two strings
       * looking alike. The Materials tab offers the link per row instead, so a
       * person decides. */
      Object.keys(db.takeoffs || {}).forEach(function (k) {
        (db.takeoffs[k].products || []).forEach(function (p) {
          (p.groups || []).forEach(function (g) {
            (g.items || []).forEach(function (it) {
              if (it.scopeKey === undefined) it.scopeKey = null;
              if (it.packQty === undefined) it.packQty = null;
              if (it.packUm === undefined) it.packUm = '';
              if (it.costBasis === undefined) it.costBasis = 'pack';
            });
            /* The unit used to be part of the heading - 'Top Rail 1-1/2" Pipe
               (LF)'. A material row has to divide by it, so it moves out of the
               prose and into a field. A heading that never carried one is left
               alone and defaults to EA, which is what an unlabelled count is. */
            ((g.grid && g.grid.columns) || []).forEach(function (col) {
              if (col.um !== undefined) return;
              var split = splitColumnUnit(col.label);
              col.label = split.label;
              col.um = split.um || 'EA';
            });
          });
        });
      });
      (db.catalog || []).forEach(function (c) {
        if (c.packQty === undefined) c.packQty = null;
        if (c.packUm === undefined) c.packUm = '';
      });
      db.schemaVersion = 16;
    }

    // Backfill containers a hand-edited or partial file might be missing.
    ['regions', 'bids', 'catalog', 'engineers'].forEach(function (k) {
      if (!Array.isArray(db[k])) db[k] = [];
    });
    ['takeoffs', 'proposals'].forEach(function (k) {
      if (!db[k] || typeof db[k] !== 'object') db[k] = {};
    });
    if (!Array.isArray(db.productTypes) || !db.productTypes.length) {
      db.productTypes = DEFAULT_PRODUCT_TYPES.slice();
    }
    if (!Array.isArray(db.materials) || !db.materials.length) {
      db.materials = DEFAULT_MATERIALS.slice();
    }
    if (!Array.isArray(db.portals) || !db.portals.length) {
      db.portals = DEFAULT_PORTALS.slice();
    }
    /* Not `|| !length`: an empty custom-status list is the normal state, and
       treating it as missing would put the seed back every time somebody
       deleted the last one they added. */
    if (!Array.isArray(db.statuses)) db.statuses = [];
    if (!Array.isArray(db.references) || !db.references.length) {
      db.references = JSON.parse(JSON.stringify(root.REFERENCE_SEED || []));
    }
    // A hand-edited or partial file can name the current schema and still be
    // missing these, so they are backfilled outside the version gate.
    db.bids.forEach(function (b) {
      if (b.proposalNo === undefined) b.proposalNo = '';
      if (b.awardNo === undefined) b.awardNo = null;
      if (b.awardedAt === undefined) b.awardedAt = null;
      // NOT active. A record that has never carried the flag has never been
      // picked up: All Bids is the register of everything received, and a bid
      // reaches the working list when somebody adds it there.
      //
      // This defaulted to true, mirroring migration 9's blanket flag - and
      // because it runs outside the version gate, on every load, it put the
      // whole seeded register on Active Bids and would have put it straight
      // back after migration 15 took it off. Records that really did predate
      // promotion still have the flag set by migration 9; this only decides
      // what a bid with no flag at all means.
      if (b.active === undefined) b.active = false;
      if (b.activatedAt === undefined) b.activatedAt = null;
      if (b.decidedAt === undefined) b.decidedAt = null;
      if (!Array.isArray(b.assignments)) b.assignments = [];
    });
    if (!Array.isArray(db.taskTypes) || !db.taskTypes.length) {
      db.taskTypes = DEFAULT_TASK_TYPES.slice();
    }
    if (!db.company) db.company = Object.assign({}, root.COMPANY_DEFAULT || {});
    if (!db.ui) db.ui = {};
    if (!db.ui.collapsed) db.ui.collapsed = {};
    if (!db.ui.grids) db.ui.grids = {};
    migrateUI(db.ui);
    return db;
  }

  /* ---- IndexedDB plumbing ---------------------------------------------- */

  function idbAvailable() {
    try { return !!root.indexedDB; } catch (e) { return false; }
  }

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = root.indexedDB.open(IDB_NAME, IDB_VERSION); }
      catch (e) { reject(e); return; }

      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('documents')) {
          var s = d.createObjectStore('documents', { keyPath: 'id' });
          s.createIndex('bidId', 'bidId', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked by another tab')); };
    });
  }

  function idbGet(storeName, key) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(storeName, 'readonly');
      var r = tx.objectStore(storeName).get(key);
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function idbPut(storeName, value, key) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      var r = key === undefined ? store.put(value) : store.put(value, key);
      r.onsuccess = function () { resolve(r.result); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function idbDelete(storeName, key) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(storeName, 'readwrite');
      var r = tx.objectStore(storeName).delete(key);
      r.onsuccess = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function idbAll(storeName, indexName, query) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(storeName, 'readonly');
      var src = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
      var r = src.getAll(query);
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror = function () { reject(r.error); };
    });
  }

  /* ---- status + notification ------------------------------------------ */

  function setStatus(state, detail) {
    lastStatus = { state: state, at: new Date(), detail: detail || null };
    statusListeners.forEach(function (fn) {
      try { fn(lastStatus); } catch (e) { console.error(e); }
    });
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(DB); } catch (e) { console.error(e); }
    });
  }

  /* ---- open ------------------------------------------------------------ */

  /* The shared database on the office server, when there is one. Everything
     below it - IndexedDB, localStorage, memory - stays as the fallback for a
     page opened straight off disk, and is what the test suite runs on.

     `ui` is not part of the shared dataset: it is one person's column layout
     and last-open tab. It travels on its own route, saved against their
     account, so it follows them to whichever machine they sit at without ever
     moving anybody else's table. */
  function openServer() {
    if (!root.Remote) return Promise.resolve(null);
    return root.Remote.probe().then(function (there) {
      if (!there) return null;
      return root.Remote.bootstrap().then(function (body) {
        /* A server that has never held any records gets the seed data, so the
           office does not start on a blank register. The server answers this
           itself - see db.isEmpty(). It is not "is the change log empty":
           creating the first administrator already wrote a row, and a team that
           has deliberately deleted every bid must not have them all put back. */
        var virgin = body.virgin !== undefined ? body.virgin : !body.seq;
        var db = virgin ? migrate(freshDB()) : migrate(fromServer(body.db));

        /* Their saved layout, or - the first time they sign in on a machine
           they had been using before accounts existed - whatever this browser
           had, carried up so nobody loses the table they had arranged. */
        db.ui = adoptUI(body.prefs) || readLocalUI() || freshDB().ui;
        backend = 'server';
        serverUser = body.user || null;

        if (virgin) {
          // Not quite empty: creating the first administrator already wrote
          // their engineer row. Those have to be adopted rather than seeded
          // over, or the seed would try to add a second engineer with the same
          // initials and the whole batch would be refused.
          var known = (body.db && body.db.engineers) || [];
          adoptServerEngineers(db, known);
          // Everything else is remembered as absent, so the first save sends
          // the seed up as one batch and the next browser finds it there.
          root.Remote.remember({ bids: [], takeoffs: {}, proposals: {}, catalog: [],
            engineers: known });
          save();
        } else {
          root.Remote.remember(db);
        }

        wireStream();
        return db;
      });
    }).catch(function (e) {
      /* Somebody has signed in, so there is definitely a server and definitely
         shared data behind it. Quietly opening a private local copy instead
         would let them work all afternoon on records nobody else will ever see.
         Fail loudly instead. */
      if (root.Auth && root.Auth.enforced) throw e;
      console.warn('Server unavailable (' + e.message + '); falling back to local storage.');
      return null;
    });
  }

  /* The server's snapshot, as the shape the rest of the app expects. Whatever
     the server holds wins outright - including a collection it holds as empty,
     which is why this cannot be an Object.assign over the seeds. */
  function fromServer(snap) {
    var db = {
      schemaVersion: SCHEMA_VERSION,
      bids: snap.bids || [],
      takeoffs: snap.takeoffs || {},
      proposals: snap.proposals || {},
      catalog: snap.catalog || [],
      engineers: snap.engineers || [],
      rates: snap.rates || null,
      ui: null
    };
    ['regions', 'productTypes', 'taskTypes', 'references', 'company'].forEach(function (k) {
      if (snap[k] !== undefined) db[k] = snap[k];
    });
    return db;
  }

  /* The engineers the server already has win over the seeded ones with the same
     initials. Those rows belong to real accounts - they carry the userId that
     ties a person to their name on a bid - so replacing them with a freshly
     invented seed row would both break that link and collide with the unique
     index on initials. */
  function adoptServerEngineers(db, serverList) {
    if (!serverList || !serverList.length) return;
    var taken = {};
    serverList.forEach(function (e) { taken[String(e.initials || '').toLowerCase()] = true; });
    db.engineers = db.engineers.filter(function (e) {
      return !taken[String(e.initials || '').toLowerCase()];
    }).concat(serverList);
  }

  /* A prefs row from the server, healed into a usable ui object. A row written
     by an older build can be missing branches the app now reads, and every
     caller expects them to be there rather than testing first. */
  function adoptUI(prefs) {
    if (!prefs || typeof prefs !== 'object') return null;
    var base = freshDB().ui;
    Object.keys(base).forEach(function (k) {
      if (prefs[k] === undefined || prefs[k] === null) prefs[k] = base[k];
    });
    // The layout chain, which migrate() cannot reach from here - this object
    // never went near the database.
    return migrateUI(prefs);
  }

  function readLocalUI() {
    try {
      var raw = root.localStorage.getItem(UI_KEY);
      return raw ? adoptUI(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  function writeLocalUI() {
    if (!DB || !DB.ui) return;
    try { root.localStorage.setItem(UI_KEY, JSON.stringify(DB.ui)); }
    catch (e) { /* private browsing; the layout is not worth failing a save for */ }
  }

  /* The layout goes up on its own timer, not with the records.
     Two reasons for the separation. A record save is a batch the server can
     refuse - a conflict, a duplicate number - and a column being hidden must
     not be lost to somebody else's edit landing first. And it must not travel
     through the change log, or hiding a column would broadcast a repaint to
     everyone in the office. */
  var prefsTimer = null;
  var prefsSent = null;

  function writePrefs() {
    if (!DB || !DB.ui) return;
    if (backend !== 'server' || !serverUser) { writeLocalUI(); return; }

    var json = JSON.stringify(DB.ui);
    if (json === prefsSent) return;
    prefsSent = json;
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(flushPrefs, 600);
  }

  function flushPrefs() {
    if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
    if (backend !== 'server' || !serverUser || !DB || !DB.ui) return Promise.resolve();
    return root.Remote.savePrefs(DB.ui).catch(function () {
      // Nothing is lost: the next change to the layout sends the whole thing
      // again, so a failed write heals itself rather than needing a queue.
      prefsSent = null;
    });
  }

  /* Someone else's edit arriving, or the catch-up after a reconnection. */
  function wireStream() {
    root.Remote.onChanges(function (list) {
      list.forEach(function (c) { root.Remote.applyChange(DB, c); });
      notify();
      if (externalChangeHandler) {
        externalChangeHandler({ remote: true, changes: list, by: list[0] && list[0].byName });
      }
    });
    root.Remote.onStatus(function (up, detail) {
      online = up;
      setStatus(up ? 'saved' : 'offline', detail);
    });
    /* This browser has been away long enough that the server will not send the
       gap. There is no correct way to patch up from here - what is on screen is
       older than anything the change log still offers - so the page is reloaded
       and boots from a fresh snapshot. Anything typed since is flushed first,
       because a reload would otherwise throw it away. */
    root.Remote.onReload(function () {
      setStatus('offline', 'Too far behind to catch up - reloading.');
      Promise.resolve(flush()).catch(function () { /* reload anyway */ })
        .then(function () { root.location.reload(); });
    });
    root.Remote.connect();
  }

  function open() {
    return openServer().then(function (fromServer) {
      if (fromServer) {
        DB = fromServer;
        setStatus('idle');
        return DB;
      }
      return openLocal();
    });
  }

  function openLocal() {
    return Promise.resolve()
      .then(function () {
        if (!idbAvailable()) throw new Error('IndexedDB not available');
        return openIDB();
      })
      .then(function (d) {
        idb = d;
        backend = 'indexeddb';
        return idbGet('state', STATE_KEY);
      })
      .then(function (stored) {
        if (stored) return migrate(stored);
        // Nothing in IndexedDB yet - carry over a localStorage dataset if the
        // browser has one from the previous build.
        var carried = readLocalStorage();
        if (carried) {
          console.info('Carried existing data over from localStorage into IndexedDB.');
          try {
            root.localStorage.setItem(LS_BACKUP_KEY, root.localStorage.getItem(LS_KEY));
            root.localStorage.removeItem(LS_KEY);
          } catch (e) { /* not fatal */ }
          return carried;
        }
        // Through migrate() as well: the seed data is written by hand and
        // predates several fields, so first run must be normalised the same way
        // a restored file is rather than being trusted because it is new.
        return migrate(freshDB());
      })
      .catch(function (err) {
        // IndexedDB is refused on file:// in Firefox and Safari. Fall back
        // rather than leaving the estimator with a blank page.
        console.warn('IndexedDB unavailable (' + err.message + '); using localStorage.');
        idb = null;
        try {
          root.localStorage.getItem(LS_KEY);
          backend = 'localstorage';
        } catch (e) {
          backend = 'memory';
          console.error('No persistent storage at all - changes will be lost on reload.');
        }
        return readLocalStorage() || migrate(freshDB());
      })
      .then(function (db) {
        DB = db;
        openChannel();
        setStatus('idle');
        return DB;
      });
  }

  function readLocalStorage() {
    var raw = null;
    try { raw = root.localStorage.getItem(LS_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { return migrate(JSON.parse(raw)); }
    catch (e) {
      console.error('Saved localStorage data was corrupt, ignoring it:', e);
      return null;
    }
  }

  function openChannel() {
    if (typeof root.BroadcastChannel !== 'function') return;
    try { channel = new root.BroadcastChannel('dvbid'); }
    catch (e) { return; }
    channel.onmessage = function (ev) {
      if (!ev.data || ev.data.tabId === tabId || ev.data.type !== 'write') return;
      // Another tab wrote. Our in-memory copy is now stale; whoever owns the UI
      // decides whether to reload silently or prompt.
      if (externalChangeHandler) externalChangeHandler(ev.data);
    };
  }

  /* ---- write ----------------------------------------------------------- */

  /* Somebody else changed this record between us reading it and saving. The
     server's copy is the truth - it is already what everyone else can see - so
     it is applied here and the person is told what happened, rather than their
     save quietly reverting a colleague's work.

     A duplicate is the same shape of problem: the number they typed is now on
     another bid. Both surface through the same handler. */
  function resolveConflict(body) {
    if (body.error === 'duplicate') {
      setStatus('error', body);
      if (conflictHandler) conflictHandler(body);
      return;
    }
    if (body.kind && body.id != null) {
      root.Remote.applyChange(DB, {
        kind: body.kind, id: body.id, op: 'put', json: body.current
      });
      root.Remote.setRev(body.kind, body.id, body.rev);
      notify();
    }
    setStatus('conflict', body);
    if (conflictHandler) conflictHandler(body);
  }

  function writeNow() {
    saveTimer = null;
    setStatus('saving');

    var done = function () {
      setStatus('saved');
      if (channel) {
        try { channel.postMessage({ type: 'write', tabId: tabId, at: Date.now() }); }
        catch (e) { /* channel closed */ }
      }
    };
    var failed = function (e) {
      console.error('Save failed:', e);
      setStatus('error', e);
      Store.onQuotaError(e);
    };

    if (backend === 'server') {
      // Only what actually moved goes up. Sending the whole database on every
      // keystroke would make the last person to type the winner, quietly
      // discarding whatever anyone else had done in the meantime.
      writePrefs();
      var batch = root.Remote.diff(DB);
      if (!batch.length) { setStatus('saved'); return Promise.resolve(); }

      var reason = nextReason;
      nextReason = null;
      return root.Remote.push(batch, reason).then(function () {
        online = true;
        done();
      }).catch(function (e) {
        if (e.status === 409 && e.body) return resolveConflict(e.body);
        online = false;
        setStatus('offline', e);
        console.error('Save failed:', e);
      });
    }

    if (backend === 'indexeddb') {
      // Structured clone: no JSON.stringify, so no size ceiling and Dates and
      // typed data survive intact.
      return idbPut('state', JSON.parse(JSON.stringify(DB)), STATE_KEY)
        .then(done).catch(failed);
    }
    if (backend === 'localstorage') {
      try {
        root.localStorage.setItem(LS_KEY, JSON.stringify(DB));
        done();
      } catch (e) { failed(e); }
      return Promise.resolve();
    }
    setStatus('nostore');
    return Promise.resolve();
  }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    setStatus('dirty');
    saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
    notify();
  }

  /* Everything pending, records and layout both. Called on pagehide, and before
     signing out - a debounce that is still counting down when the tab closes
     has thrown the edit away. */
  function flush() {
    var layout = flushPrefs();
    if (!saveTimer) return layout;
    clearTimeout(saveTimer);
    return Promise.all([writeNow(), layout]);
  }

  /* ---- documents ------------------------------------------------------- */

  var Docs = {
    available: function () { return backend === 'indexeddb'; },

    put: function (rec) {
      if (!Docs.available()) {
        return Promise.reject(new Error(
          'Document storage needs IndexedDB. Run the app with "node serve.js" ' +
          'and open http://localhost:9000 instead of opening the file directly.'));
      }
      return idbPut('documents', rec).then(function () { return rec; });
    },
    get: function (id) { return idbGet('documents', id); },
    listFor: function (bidId) {
      if (!Docs.available()) return Promise.resolve([]);
      return idbAll('documents', 'bidId', bidId);
    },
    all: function () {
      if (!Docs.available()) return Promise.resolve([]);
      return idbAll('documents');
    },
    remove: function (id) { return idbDelete('documents', id); },
    removeForBid: function (bidId) {
      return Docs.listFor(bidId).then(function (list) {
        return Promise.all(list.map(function (d) { return idbDelete('documents', d.id); }));
      });
    },
    /* Metadata without the blobs - what goes into the .json backup. */
    metaFor: function (bidId) {
      return Docs.listFor(bidId).then(function (list) {
        return list.map(function (d) {
          return {
            id: d.id, bidId: d.bidId, name: d.name, type: d.type,
            size: d.size, category: d.category, addedAt: d.addedAt, addedBy: d.addedBy
          };
        });
      });
    },
    estimate: function () {
      if (!root.navigator || !navigator.storage || !navigator.storage.estimate) {
        return Promise.resolve(null);
      }
      return navigator.storage.estimate().catch(function () { return null; });
    },
    /* Ask the browser not to evict us when the disk gets tight. */
    persist: function () {
      if (!root.navigator || !navigator.storage || !navigator.storage.persist) {
        return Promise.resolve(false);
      }
      return navigator.storage.persisted().then(function (already) {
        return already ? true : navigator.storage.persist();
      }).catch(function () { return false; });
    }
  };

  /* ---- public API ------------------------------------------------------ */

  var Store = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    UNITS: COLUMN_UNITS,
    splitColumnUnit: splitColumnUnit,
    UI_VERSION: UI_VERSION,
    /* Exposed so the layout chain can be exercised on its own - it is the half
       that does not travel with the records. */
    migrateUI: migrateUI,
    DEFAULT_PRODUCT_TYPES: DEFAULT_PRODUCT_TYPES,
    DEFAULT_TASK_TYPES: DEFAULT_TASK_TYPES,
    DEFAULT_PORTALS: DEFAULT_PORTALS,
    uid: uid,
    /* The shape of a bid's product rows. Exported because js/products.js needs
       the same conversion for the bid form and there must be one definition. */
    productLinesFromFlat: productLinesFromFlat,
    open: open,
    save: save,
    flush: flush,
    migrate: migrate,
    docs: Docs,

    get db() { return DB; },
    get backend() { return backend; },
    get status() { return lastStatus; },
    /* True when this browser is talking to a shared server rather than keeping
       its own private copy. The pop-out control and the storage warning both
       key off it, and phase 2 hangs the signed-in user here. */
    get shared() { return backend === 'server'; },
    get online() { return backend !== 'server' || online; },
    get user() { return serverUser; },

    /* A conflict or a duplicate came back from the server. js/app.js puts it on
       screen; nothing else needs to know. */
    onConflict: function (fn) { conflictHandler = fn; },

    /* Every table back to its defaults, for this person only. Where they were
       is kept - resetting your columns should not also throw you back to a
       different tab. */
    resetLayout: function () {
      if (!DB) return Promise.resolve();
      // The theme is kept for the same reason the current tab is: this resets
      // tables, and somebody who works in the dark did not ask for the lights.
      var keep = { module: DB.ui.module, section: DB.ui.section,
                   settingsSection: DB.ui.settingsSection, projectBidId: DB.ui.projectBidId,
                   theme: DB.ui.theme };
      DB.ui = Object.assign(freshDB().ui, keep);
      prefsSent = null;
      writeLocalUI();
      return flushPrefs();
    },

    /* Subscribe to any mutation. Used by the KPI header and the bid table. */
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /* Subscribe to save progress. Drives the footer indicator. */
    onStatus: function (fn) {
      statusListeners.push(fn);
      fn(lastStatus);
      return function () {
        var i = statusListeners.indexOf(fn);
        if (i >= 0) statusListeners.splice(i, 1);
      };
    },

    /* Called when another tab writes. The app decides what to do about it. */
    onExternalChange: function (fn) { externalChangeHandler = fn; },

    /* Re-read from disk, discarding the in-memory copy. */
    reload: function () {
      if (backend !== 'indexeddb') {
        DB = readLocalStorage() || DB;
        notify();
        return Promise.resolve(DB);
      }
      return idbGet('state', STATE_KEY).then(function (stored) {
        if (stored) { DB = migrate(stored); notify(); }
        return DB;
      });
    },

    onQuotaError: function (e) {
      var msg = backend === 'localstorage'
        ? 'Could not save - browser storage is full.\n\n' +
          'This browser is using the small localStorage fallback. Running the app ' +
          'with "node serve.js" gives it a much larger database.\n\n'
        : 'Could not save to the local database.\n\n';
      alert(msg + (e && e.message ? e.message : ''));
    },

    reset: function () {
      var ui = DB && DB.ui;
      DB = migrate(freshDB());
      // Their layout is theirs; wiping the records is not a reason to also
      // rearrange their columns.
      if (ui) DB.ui = ui;
      if (root.Rates && root.Rates.ensure) root.Rates.ensure(DB);
      if (root.Catalog && root.Catalog.ensure) root.Catalog.ensure(DB);
      nextReason = 'load';
      save();
      return DB;
    },

    /* ---- project file I/O ---------------------------------------------- */

    /* Documents are deliberately excluded - a project with 100 MB of drawings
       would produce a 130 MB base64 .json. Their metadata rides along so a
       restored file still knows what was attached; the blobs come from the
       separate zip export. */
    exportFile: function () {
      return flush()
        .then(function () { return Docs.all(); })
        .then(function (docs) {
          var payload = JSON.parse(JSON.stringify(DB));
          payload.documentIndex = docs.map(function (d) {
            return {
              id: d.id, bidId: d.bidId, name: d.name, type: d.type,
              size: d.size, category: d.category, addedAt: d.addedAt, addedBy: d.addedBy
            };
          });
          payload.exportedAt = new Date().toISOString();
          downloadJSON(payload, 'DiVerse-Bids-' + root.U.stampDate(new Date()) + '.json');
          return payload.documentIndex.length;
        });
    },

    importFile: function (file, done) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.bids)) {
            throw new Error('This does not look like a saved project file ' +
              '(no "bids" array). If you meant to load a proposal template, use ' +
              'Load Template on the Proposal tab instead.');
          }
          if ((parsed.schemaVersion || 0) > SCHEMA_VERSION) {
            throw new Error('This file was saved by a newer version of the app ' +
              '(schema ' + parsed.schemaVersion + ' vs ' + SCHEMA_VERSION + ').');
          }
          var index = parsed.documentIndex || [];
          delete parsed.documentIndex;
          delete parsed.exportedAt;
          var ui = DB && DB.ui;
          DB = migrate(parsed);
          // The layout in a backup belongs to whoever exported it. Keep the
          // person doing the restore on their own.
          if (ui) DB.ui = ui;
          nextReason = 'load';
          if (root.Rates && root.Rates.ensure) root.Rates.ensure(DB);
          if (root.Catalog && root.Catalog.ensure) root.Catalog.ensure(DB);
          save();
          done(null, DB, index);
        } catch (err) {
          done(err);
        }
      };
      reader.onerror = function () { done(new Error('Could not read the file.')); };
      reader.readAsText(file);
    }
  };

  function downloadJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  Store.downloadJSON = downloadJSON;
  Store.downloadBlob = downloadBlob;
  root.Store = Store;
})(window);
