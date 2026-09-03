/* takeoff.model.js - data shape and cost maths.

   Mirrors Estimation_Lancaster Township.xlsx exactly:
     Material Cost = SUM(qty x unitCost)
     Subtotal      = Material + Finish + Eng + Fab + Install + Supervisor + Forklift + Truck
     Markup        = Subtotal x 25%
     Overhead      = Subtotal x 20%
     Total         = Subtotal + Markup + Overhead
   and at project level:
     Base = SUM(product totals); Misc = Base x 5%; Tax = Base x 7%;
     Total Bid = Base + Misc + Freight + Tax + Roundoff
   Kept separate from the UI so the numbers can be checked on their own. */
(function (root) {
  'use strict';

  var uid = function (p) { return root.Store.uid(p); };
  var n = function (v) { return root.U.n(v); };

  /* ---- construction ---------------------------------------------------- */

  function newItem(partial) {
    return Object.assign({
      id: uid('mi'),
      feature: '', option: '', vendor: '', partNo: '', description: '',
      qty: null, um: 'EA', material: '', grade: '', weightLb: null,
      unitCost: null, catalogId: null,
      qtyMode: 'manual', qtyExpr: '',
      // Ticked by default. Untick to keep the row in the cost but off the
      // client-facing proposal. Absent === true, so nothing is written for the
      // normal case.
      showInProposal: true
    }, partial || {});
  }

  /* The seven standard Cost & Labour rows, in sheet order. Everything that
     iterates them - the table, the cost maths, the proposal bullets - reads
     this one list, so a row is defined once. */
  var COST_ROWS = [
    { id: 'finish', qtyPath: 'finish.qty', ratePath: 'finish.unitCost',
      umPath: 'finish.um', derived: true, totalKey: 'finishTotal' },
    { id: 'engineering', label: 'Engineering cost', qtyPath: 'labour.engineering.hrs',
      ratePath: 'labour.engineering.rate', um: 'Hrs', derived: true, totalKey: 'engTotal' },
    { id: 'fabrication', label: 'Fabrication cost', qtyPath: 'labour.fabrication.hrs',
      ratePath: 'labour.fabrication.rate', um: 'Hrs', derived: true, totalKey: 'fabTotal' },
    { id: 'installation', label: 'Installation cost', qtyPath: 'labour.installation.hrs',
      ratePath: 'labour.installation.rate', um: 'Hrs', derived: true, totalKey: 'instTotal' },
    { id: 'supervisor', label: 'Supervisor', qtyPath: 'labour.supervisor.hrs',
      ratePath: 'labour.supervisor.rate', um: 'Hrs', derived: false, totalKey: 'supTotal' },
    { id: 'forklift', label: 'Forklift', qtyPath: 'equipment.forklift.days',
      ratePath: 'equipment.forklift.rate', um: 'Days', derived: false, totalKey: 'forkTotal' },
    { id: 'truck', label: 'Truck for Transport', qtyPath: 'equipment.truck.days',
      ratePath: 'equipment.truck.rate', um: 'Days', derived: false, totalKey: 'truckTotal' }
  ];

  function costRowDef(id) {
    for (var i = 0; i < COST_ROWS.length; i++) if (COST_ROWS[i].id === id) return COST_ROWS[i];
    return null;
  }

  /* Every product's first Cost & Labour line starts with this, and the estimator
     cannot delete it - only add to it. So the line reads "Finish - Painted" on
     one product and "Finish - Hot Dip Galvanized" on another, instead of the
     free-for-all the label used to be. `p.finish.label` holds only the part
     after the dash. */
  var FINISH_PREFIX = 'Finish - ';

  function finishLabel(p) {
    var s = p.finish && p.finish.label ? String(p.finish.label).trim() : '';
    return s ? FINISH_PREFIX + s : FINISH_PREFIX.replace(/\s*-\s*$/, '');
  }

  /* Default label for a row. `finish` is per-product (the sheet's finish
     wording), the rest are fixed. */
  function defaultRowLabel(p, id) {
    if (id === 'finish') return finishLabel(p);
    var d = costRowDef(id);
    return d ? d.label : id;
  }

  /* What the row is actually called on this product - the estimator's override
     if there is one, otherwise the default. */
  function rowLabel(p, id) {
    // Finish is not renamable through rowLabels: its text lives in
    // finish.label so the fixed prefix can never be edited away.
    if (id === 'finish') return finishLabel(p);
    var custom = p.rowLabels && p.rowLabels[id];
    return custom && String(custom).trim() ? custom : defaultRowLabel(p, id);
  }

  function isRowHidden(p, id) { return !!(p.hiddenRows && p.hiddenRows[id]); }

  /* Hidden rows can never show on the proposal - a line you are not billing is
     not a line you tell the client about. */
  function isRowOnProposal(p, id) {
    if (isRowHidden(p, id)) return false;
    return !(p.proposalRows && p.proposalRows[id] === false);
  }

  function isItemOnProposal(item) { return item.showInProposal !== false; }

  function newGroup(name, columns) {
    return {
      id: uid('grp'),
      name: name || 'Items',
      items: [],
      grid: {
        columns: (columns || []).map(function (label) {
          return { key: uid('col'), label: label };
        }),
        rows: []
      }
    };
  }

  /* `tk` is the takeoff the product is being added to, so a project that has
     set its own rates seeds the new product from those rather than the shop
     defaults. Optional - omitting it uses the shop defaults. */
  function newProduct(type, tk) {
    var t = root.Rates.template(type);
    var r = root.Rates.forType(type, tk);
    return {
      id: uid('prd'),
      type: type,
      sow: t.sow,
      material: t.material,
      unit: t.unit,
      groups: t.groups.map(function (g) { return newGroup(g.name, g.columns); }),
      totalLF: null,
      totalQty: null,                       // used when unit is EA (bollards)
      finish: { label: t.finishLabel, qty: null, um: t.unit, unitCost: r.finishPerLF },
      labour: {
        engineering: { hrs: null, rate: r.engineeringRate },
        fabrication: { hrs: null, rate: r.fabricationRate },
        installation: { hrs: null, rate: r.installationRate },
        supervisor: { hrs: null, rate: r.supervisorRate }
      },
      equipment: {
        forklift: { days: null, rate: r.forkliftPerDay },
        truck: { days: null, rate: r.truckPerDay }
      },
      /* Ad-hoc charges that don't fit a rate x qty line. The Lancaster Platform
         sheet hid three of these inside formulas (+(1000*2)+(200*2) appended to
         installation, supervisor and truck); as their own rows they show up in
         the total and on the proposal instead of vanishing into a cell. */
      extras: [],
      markupPct: r.markupPct,
      overheadPct: r.overheadPct,
      overrides: {},
      /* All three store only the exceptions, so the default state - every row
         visible, default labels, everything shown on the proposal - is three
         empty objects and costs nothing to persist. */
      hiddenRows: {},     // { forklift: true }  removed from the table AND the cost
      rowLabels: {},      // { engineering: 'Detailing' }  absent = default label
      proposalRows: {}    // { supervisor: false }  absent = shown on the proposal
    };
  }

  function newTakeoff(bid) {
    var rr = root.Rates.ensure(root.Store.db).rollup;
    return {
      id: uid('tko'),
      bidId: bid ? bid.id : null,
      project: {
        name: bid ? bid.project : '',
        location: '',
        // The proposal number belongs to the bid; the takeoff and the proposal
        // document both take their copy from there rather than being retyped.
        proposalNo: bid ? (bid.proposalNo || '') : '',
        bidDueDate: bid ? (bid.dueDate || '') : ''
      },
      products: [],
      rollup: Object.assign({}, rr),
      createdAt: new Date().toISOString()
    };
  }

  /* ---- formula-driven quantities (opt-in per row) ---------------------- */

  /* Deliberately tiny: numbers, + - * / ( ), ROUNDUP/ROUND/ROUNDDOWN/CEILING/
     FLOOR/MIN/MAX and TK("column"). Tokenised and evaluated by hand rather than
     handed to eval, so a stray takeoff cell can never execute anything. */
  function evalQtyExpr(expr, group) {
    if (!expr || !String(expr).trim()) return null;
    var subs = gridSubtotals(group);
    var src = String(expr);
    var pos = 0;

    function ws() { while (pos < src.length && /\s/.test(src[pos])) pos++; }
    function fail(msg) { throw new Error(msg + ' at ' + pos); }

    function parseExpr() {
      var v = parseTerm();
      for (;;) {
        ws();
        var c = src[pos];
        if (c === '+') { pos++; v += parseTerm(); }
        else if (c === '-') { pos++; v -= parseTerm(); }
        else return v;
      }
    }
    function parseTerm() {
      var v = parseFactor();
      for (;;) {
        ws();
        var c = src[pos];
        if (c === '*') { pos++; v *= parseFactor(); }
        else if (c === '/') { pos++; var d = parseFactor(); v = d === 0 ? 0 : v / d; }
        else return v;
      }
    }
    function parseFactor() {
      ws();
      if (src[pos] === '-') { pos++; return -parseFactor(); }
      if (src[pos] === '+') { pos++; return parseFactor(); }
      if (src[pos] === '(') { pos++; var v = parseExpr(); ws(); if (src[pos] !== ')') fail('expected )'); pos++; return v; }
      var m = /^[0-9]*\.?[0-9]+/.exec(src.slice(pos));
      if (m) { pos += m[0].length; return parseFloat(m[0]); }
      var fn = /^[A-Za-z]+/.exec(src.slice(pos));
      if (!fn) fail('unexpected "' + (src[pos] || 'end') + '"');
      pos += fn[0].length;
      var name = fn[0].toUpperCase();
      ws();
      if (src[pos] !== '(') fail('expected ( after ' + name);
      pos++;
      var args = [];
      if (name === 'TK') {
        ws();
        var quote = src[pos];
        if (quote !== '"' && quote !== "'") fail('TK needs a quoted column name');
        pos++;
        var label = '';
        while (pos < src.length && src[pos] !== quote) {
          if (src[pos] === '\\') pos++;
          label += src[pos++];
        }
        pos++;                                   // closing quote
        ws();
        if (src[pos] !== ')') fail('expected )');
        pos++;
        var hit = subs[label];
        if (hit === undefined) throw new Error('No takeoff column named "' + label + '"');
        return hit;
      }
      for (;;) {
        ws();
        if (src[pos] === ')') { pos++; break; }
        args.push(parseExpr());
        ws();
        if (src[pos] === ',') { pos++; continue; }
        if (src[pos] === ')') { pos++; break; }
        fail('expected , or )');
      }
      switch (name) {
        case 'ROUNDUP': return ceilTo(args[0], args[1]);
        case 'CEILING': return ceilTo(args[0], args[1]);
        case 'ROUNDDOWN': case 'FLOOR': return floorTo(args[0], args[1]);
        case 'ROUND': return roundTo(args[0], args[1]);
        case 'MIN': return Math.min.apply(Math, args);
        case 'MAX': return Math.max.apply(Math, args);
        case 'ABS': return Math.abs(args[0]);
        default: throw new Error('Unknown function ' + name + '()');
      }
    }
    function pow10(d) { return Math.pow(10, d == null ? 0 : d); }
    function ceilTo(v, d) { var p = pow10(d); return Math.ceil(v * p) / p; }
    function floorTo(v, d) { var p = pow10(d); return Math.floor(v * p) / p; }
    function roundTo(v, d) { var p = pow10(d); return Math.round(v * p) / p; }

    var out = parseExpr();
    ws();
    if (pos < src.length) fail('unexpected trailing input');
    return isFinite(out) ? out : null;
  }

  function itemQty(item, group) {
    if (item.qtyMode === 'formula') {
      try { return evalQtyExpr(item.qtyExpr, group); }
      catch (e) { return null; }
    }
    return item.qty == null || item.qty === '' ? null : n(item.qty);
  }

  function itemQtyError(item, group) {
    if (item.qtyMode !== 'formula') return null;
    try { evalQtyExpr(item.qtyExpr, group); return null; }
    catch (e) { return e.message; }
  }

  function itemTotal(item, group) {
    var q = itemQty(item, group);
    if (q == null || item.unitCost == null || item.unitCost === '') return 0;
    return q * n(item.unitCost);
  }

  /* ---- drawing grid ---------------------------------------------------- */

  function gridSubtotals(group) {
    var out = {};
    if (!group || !group.grid) return out;
    group.grid.columns.forEach(function (col) {
      var sum = 0;
      group.grid.rows.forEach(function (row) { sum += n(row.values[col.key]); });
      out[col.label] = sum;
      out[col.key] = sum;
    });
    return out;
  }

  /* ---- product roll-up ------------------------------------------------- */

  function groupMaterialCost(group) {
    return group.items.reduce(function (s, it) { return s + itemTotal(it, group); }, 0);
  }

  function computeProduct(p) {
    var materialCost = p.groups.reduce(function (s, g) { return s + groupMaterialCost(g); }, 0);

    /* Each row's own value is always computed and returned, whether or not it
       is hidden, so restoring a hidden row brings its typed numbers straight
       back. Only the running total skips hidden rows. */
    var rowTotals = {};
    var rowsTotal = 0;
    COST_ROWS.forEach(function (def) {
      var qty = n(pathGet(p, def.qtyPath));
      var rate = n(pathGet(p, def.ratePath));
      var t = qty * rate;
      rowTotals[def.totalKey] = t;
      if (!isRowHidden(p, def.id)) rowsTotal += t;
    });

    var extrasTotal = (p.extras || []).reduce(function (s, e) { return s + n(e.amount); }, 0);

    var subtotal = materialCost + rowsTotal + extrasTotal;
    var markup = subtotal * n(p.markupPct) / 100;
    var overhead = subtotal * n(p.overheadPct) / 100;

    return Object.assign({
      materialCost: materialCost,
      extrasTotal: extrasTotal,
      labourEquipTotal: rowsTotal + extrasTotal,
      subtotal: subtotal,
      markup: markup,
      overhead: overhead,
      total: subtotal + markup + overhead,
      hiddenCount: COST_ROWS.filter(function (d) { return isRowHidden(p, d.id); }).length,
      itemCount: p.groups.reduce(function (s, g) { return s + g.items.length; }, 0)
    }, rowTotals);
  }

  function computeTakeoff(t) {
    var products = (t.products || []).map(function (p) {
      return { product: p, calc: computeProduct(p) };
    });
    var base = products.reduce(function (s, x) { return s + x.calc.total; }, 0);
    var totalLF = (t.products || []).reduce(function (s, p) { return s + n(p.totalLF); }, 0);

    var r = t.rollup || {};
    var misc = base * n(r.miscPct) / 100;
    var tax = base * n(r.taxPct) / 100;
    var freight = n(r.freight);

    var preRound = base + misc + freight + tax;

    /* 'auto10' quotes on a round ten and reports the uplift as the roundoff.
       'manual' keeps a hand-typed roundoff - the Lancaster workbook does this
       (a flat 343), and tests/verify-lancaster.js reproduces it. */
    var roundoff, total;
    if (r.roundMode === 'manual') {
      roundoff = n(r.roundoff);
      total = preRound + roundoff;
    } else {
      total = root.U.roundTo10(preRound);
      roundoff = total - preRound;
    }

    return {
      products: products,
      base: base,
      totalLF: totalLF,
      misc: misc,
      freight: freight,
      tax: tax,
      preRound: preRound,
      roundoff: roundoff,
      total: total
    };
  }

  /* ---- auto-fill with override ---------------------------------------- */

  function pathGet(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function pathSet(obj, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (o, k) { return o[k]; }, obj);
    target[last] = value;
  }

  var DERIVED_PATHS = ['finish.qty', 'labour.engineering.hrs',
    'labour.fabrication.hrs', 'labour.installation.hrs'];

  /* Recomputes every derived field the user has not taken over. */
  function applyDerived(p, tk) {
    var d = root.Rates.derive(p.type, p.totalLF, tk);
    DERIVED_PATHS.forEach(function (path) {
      if (p.overrides[path]) return;
      var v = d[path];
      pathSet(p, path, v == null ? null : Math.round(v * 1000) / 1000);
    });
  }

  function setField(p, path, value) {
    pathSet(p, path, value === '' || value == null ? null : Number(value));
    if (DERIVED_PATHS.indexOf(path) >= 0) p.overrides[path] = true;
  }

  function clearOverride(p, path, tk) {
    delete p.overrides[path];
    applyDerived(p, tk);
  }

  function clearAllOverrides(p, tk) {
    p.overrides = {};
    applyDerived(p, tk);
  }

  function derivedValue(p, path, tk) {
    var d = root.Rates.derive(p.type, p.totalLF, tk);
    return d[path] == null ? null : Math.round(d[path] * 1000) / 1000;
  }

  root.TakeoffModel = {
    COST_ROWS: COST_ROWS,
    FINISH_PREFIX: FINISH_PREFIX,
    costRowDef: costRowDef,
    rowLabel: rowLabel,
    defaultRowLabel: defaultRowLabel,
    isRowHidden: isRowHidden,
    isRowOnProposal: isRowOnProposal,
    isItemOnProposal: isItemOnProposal,
    newItem: newItem, newGroup: newGroup, newProduct: newProduct, newTakeoff: newTakeoff,
    itemQty: itemQty, itemTotal: itemTotal, itemQtyError: itemQtyError,
    evalQtyExpr: evalQtyExpr, gridSubtotals: gridSubtotals,
    groupMaterialCost: groupMaterialCost,
    computeProduct: computeProduct, computeTakeoff: computeTakeoff,
    applyDerived: applyDerived, setField: setField, derivedValue: derivedValue,
    clearOverride: clearOverride, clearAllOverrides: clearAllOverrides,
    pathGet: pathGet, pathSet: pathSet, DERIVED_PATHS: DERIVED_PATHS
  };
})(window);
