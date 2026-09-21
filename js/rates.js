/* rates.js - labour/equipment rates, markup percentages and the hour formulas,
   all taken from Estimation_Lancaster Township.xlsx.

   The workbook is not internally consistent: Steel Guardrail bills fabrication at
   $120/hr while Wall Mount Handrail bills it at $125/hr. So rates are global
   defaults with a per-product-type override layer on top. */
(function (root) {
  'use strict';

  var GLOBAL_DEFAULTS = {
    finishPerLF: 30,
    engineeringRate: 100,
    fabricationRate: 120,
    installationRate: 125,
    supervisorRate: 125,
    forkliftPerDay: 1000,
    truckPerDay: 250,
    markupPct: 25,
    overheadPct: 20,
    // Excel: F39 = LF*0.3+16, F40 = LF*0.6+24, F41 = LF*0.5
    engFactor: 0.3, engBase: 16,
    fabFactor: 0.6, fabBase: 24,
    instFactor: 0.5, instBase: 0
  };

  var ROLLUP_DEFAULTS = { miscPct: 5, freight: 0, taxPct: 7, roundoff: 0, roundMode: 'auto10' };

  /* Per-type overrides observed in the workbook.

     Wall Mount Handrail bills fabrication at $125/hr, and the Platform sheet
     uses an entirely different set of hour factors (=B39*0.6+16, =B39*1.8,
     =B39*1) because a platform is priced off deck area, not rail run. */
  var BY_TYPE = {
    'Wall Mount Handrail': { fabricationRate: 125 },
    'Galvanized Platform': {
      engFactor: 0.6, engBase: 16,
      fabFactor: 1.8, fabBase: 0,
      instFactor: 1.0, instBase: 0
    }
  };

  /* Product templates: the standard shape of each sheet, so "+ Add Product Type"
     starts you off with the right component groups, finish wording and unit.

     NO GRID COLUMNS. Every template used to carry the full column list off its
     workbook sheet - fifteen of them on Steel Guardrail - and a new product
     arrived with all of them laid out before anybody had measured anything. A
     real job uses three or four, so the estimator's first task was deleting
     eleven columns, and the ones left behind sat in the scope strip as work
     nothing was being bought for.

     The drawing grid is now typed: one column per thing actually being
     measured, named and given its unit as it is created. See Takeoff.addCol.

     The groups stay. "Embedded Bollard" and "Surface Mounted Bollard" are the
     shape of the product rather than a measurement, and re-typing them on every
     bollard job is friction with nothing behind it. */
  var PRODUCT_TEMPLATES = {
    'Steel Guardrail': {
      sow: 'Guardrail',
      material: 'Galvanized Steel',
      finishLabel: 'For interior: Painted / For exterior: Powder coated',
      unit: 'LF',
      groups: [{ name: 'Guardrail' }]
    },
    'Wall Mount Handrail': {
      sow: 'Wall Mount Handrail',
      material: 'Galvanized Steel',
      finishLabel: 'Painted',
      unit: 'LF',
      groups: [{ name: 'Wall Mount Handrail' }]
    },
    'Bollard': {
      sow: 'Bollard',
      material: 'Galvanized Steel',
      finishLabel: 'Sleeve, Color Yellow',
      unit: 'EA',
      groups: [
        { name: 'Embedded Bollard' },
        { name: 'Surface Mounted Bollard' }
      ]
    },
    'Galvanized Platform': {
      sow: 'Platform',
      material: 'Galvanized Steel',
      finishLabel: 'Hot Dip Galvanized',
      unit: 'LF',
      groups: [
        { name: 'Walkway framing' },
        { name: 'Platform at wash bay' }
      ]
    },
    'Stair': {
      sow: 'Stair',
      material: 'Galvanized Steel',
      finishLabel: 'Stringer: Painted',
      unit: 'LF',
      groups: [{ name: 'Stair' }]
    }
  };

  var Rates = {
    GLOBAL_DEFAULTS: GLOBAL_DEFAULTS,
    ROLLUP_DEFAULTS: ROLLUP_DEFAULTS,
    PRODUCT_TEMPLATES: PRODUCT_TEMPLATES,

    TYPES: Object.keys(PRODUCT_TEMPLATES),

    ensure: function (db) {
      if (!db.rates) {
        db.rates = {
          global: Object.assign({}, GLOBAL_DEFAULTS),
          rollup: Object.assign({}, ROLLUP_DEFAULTS),
          byType: JSON.parse(JSON.stringify(BY_TYPE))
        };
      }
      if (!db.rates.global) db.rates.global = Object.assign({}, GLOBAL_DEFAULTS);
      if (!db.rates.rollup) db.rates.rollup = Object.assign({}, ROLLUP_DEFAULTS);
      if (!db.rates.byType) db.rates.byType = JSON.parse(JSON.stringify(BY_TYPE));
      // Fill in any key added by a later build.
      Object.keys(GLOBAL_DEFAULTS).forEach(function (k) {
        if (db.rates.global[k] === undefined) db.rates.global[k] = GLOBAL_DEFAULTS[k];
      });
      Object.keys(ROLLUP_DEFAULTS).forEach(function (k) {
        if (db.rates.rollup[k] === undefined) db.rates.rollup[k] = ROLLUP_DEFAULTS[k];
      });
      return db.rates;
    },

    /* Effective rate set for a product type, most general first:
         shop default -> shop's product-type quirk
                      -> this project -> this project's product-type override

       `t` is the takeoff. Omitting it gives the shop-wide answer, which is what
       callers outside a project (and the parity tests) want. A project stores
       only the keys it has changed, so a later change to a shop rate still
       reaches every project that never touched it.

       The project sits *after* the shop's per-type quirks on purpose. Setting
       Fabrication to $135 for one job should mean $135 on every product in it,
       including Wall Mount Handrail, which the workbook otherwise pins at $125.
       An explicit decision beats an inherited default. */
    forType: function (type, t) {
      var r = Rates.ensure(root.Store.db);
      var pg = (t && t.rates && t.rates.global) || {};
      var pt = (t && t.rates && t.rates.byType && t.rates.byType[type]) || {};
      return Object.assign({}, r.global, r.byType[type] || {}, pg, pt);
    },

    /* The three LF-driven hour formulas plus the finish quantity. */
    derive: function (type, totalLF, t) {
      var r = Rates.forType(type, t);
      var lf = Number(totalLF) || 0;
      return {
        'finish.qty': lf,
        'labour.engineering.hrs': lf * r.engFactor + r.engBase,
        'labour.fabrication.hrs': lf * r.fabFactor + r.fabBase,
        'labour.installation.hrs': lf * r.instFactor + r.instBase
      };
    },

    template: function (type) {
      return PRODUCT_TEMPLATES[type] || {
        // Empty, not 'Finish': the label already carries the "Finish - " prefix,
        // so a custom type starts as just "Finish" for the estimator to finish.
        sow: type, material: '', finishLabel: '', unit: 'LF',
        groups: [{ name: type || 'Items', columns: [] }]
      };
    }
  };

  root.Rates = Rates;
})(window);
