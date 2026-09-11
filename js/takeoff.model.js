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

  /* The units anything in the app is measured or sold in. Offered as a
     datalist rather than a <select>: takeoffs already in the database carry
     free-typed units ("Sticks", "Lot"), and a hard select would drop them the
     first time the row was touched.

     Defined in js/store.js, because the schema-16 migration needs both this
     list and splitColumnUnit before this file has been parsed. Re-exported
     here so the takeoff code has one place to reach for. */
  var UNITS = root.Store.UNITS;
  var splitColumnUnit = root.Store.splitColumnUnit;

  function newItem(partial) {
    return Object.assign({
      id: uid('mi'),
      feature: '', option: '', vendor: '', partNo: '', description: '',
      qty: null, um: 'EA', material: '', grade: '', weightLb: null,
      unitCost: null, catalogId: null,
      qtyMode: 'manual', qtyExpr: '',
      /* What the drawing takeoff measured, and what the vendor sells it in.
         See requiredQty/orderQty for how the two become a number to order.

           scopeKey  the drawing-takeoff column this row is measured by, or
                     null for a row that stands on its own (tax, freight, the
                     bag of washers nobody draws)
           packQty   how much of that measure comes in one purchased item -
                     21 LF to a stick of pipe, 100 EA to a packet of washers
           packUm    the unit packQty is counted in
           costBasis 'pack' - unitCost is the price of one purchased item
                     'unit' - unitCost is the price per LF/EA measured */
      scopeKey: null, packQty: null, packUm: '', costBasis: 'pack',
      /* What to order, when it is not what the division came to. Null means
         the calculation stands - see orderQty. */
      orderQtyOverride: null,
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

  /* The unit a row is billed in.

     COST_ROWS names a default - Hrs for labour, Days for equipment - but the
     shop does not always bill that way: supervision quoted by the week, a truck
     by the load. p.rowUnits holds only the exceptions, exactly as p.rowLabels
     holds only the renamed labels, so the ordinary case is an empty object and
     costs nothing to store.

     Finish is the one row whose unit is already per-product data (it follows
     the product's own unit), so it reads from finish.um as it always did. */
  function rowUnit(p, id) {
    var custom = p.rowUnits && p.rowUnits[id];
    if (custom && String(custom).trim()) return String(custom).trim();
    return defaultRowUnit(p, id);
  }

  function defaultRowUnit(p, id) {
    var d = costRowDef(id);
    if (!d) return '';
    if (d.umPath) return pathGet(p, d.umPath) || '';
    return d.um || '';
  }

  function isRowHidden(p, id) { return !!(p.hiddenRows && p.hiddenRows[id]); }

  /* Hidden rows can never show on the proposal - a line you are not billing is
     not a line you tell the client about. */
  function isRowOnProposal(p, id) {
    if (isRowHidden(p, id)) return false;
    return !(p.proposalRows && p.proposalRows[id] === false);
  }

  function isItemOnProposal(item) { return item.showInProposal !== false; }

  /* What an extra charge comes to.

     It started as a flat amount, because the rows it replaced were ad-hoc sums
     appended to a formula. But most of them are not flat at all - two lifts at
     $1,000, four permits at $200 - and typing the product of that by hand loses
     the quantity, which is the thing anybody reviewing the estimate wants to
     see. So a row with both a quantity and a unit price is their product.

     A row with only an amount still works and is untouched, which is what makes
     this safe on every extra already in the database: no migration, and an
     estimator who wants to type one number still can. */
  function extraAmount(e) {
    if (!e) return 0;
    if (e.qty !== null && e.qty !== undefined && e.qty !== '' &&
        e.unitPrice !== null && e.unitPrice !== undefined && e.unitPrice !== '') {
      return n(e.qty) * n(e.unitPrice);
    }
    return n(e.amount);
  }

  function newColumn(label, um) {
    var split = splitColumnUnit(label);
    return { key: uid('col'), label: split.label, um: um || split.um || 'EA' };
  }

  function newGroup(name, columns) {
    return {
      id: uid('grp'),
      name: name || 'Items',
      items: [],
      grid: {
        columns: (columns || []).map(function (label) { return newColumn(label); }),
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
      /* Ad-hoc charges. The Lancaster Platform
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
      rowUnits: {},       // { supervisor: 'Wks' }  absent = the row's default unit
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

  /* ---- scopes ---------------------------------------------------------- */

  /* A SCOPE is one thing measured off the drawings - "Top Rail 1-1/2\" Pipe".
     It is named, not keyed: the estimator draws the same scope on two sheets
     and puts it in two groups, and those are one quantity to order, not two.
     So the identity is the heading itself, compared the way a person compares
     them - case, spacing and punctuation set aside.

     Deliberately the same normalisation Catalog.norm uses on part numbers, and
     for the same reason. */
  function scopeKey(label) {
    return String(label == null ? '' : label).toLowerCase()
      .replace(/[\s\-_.\/]+/g, '').trim();
  }

  /* Every scope on a product, with its total across all of that product's
     groups. The one thing the drawing grid, the material rows, the scope
     picker and the export all read, so they cannot disagree. */
  function productScopes(p) {
    var order = [], by = {};
    ((p && p.groups) || []).forEach(function (g) {
      var cols = (g.grid && g.grid.columns) || [];
      var rows = (g.grid && g.grid.rows) || [];
      cols.forEach(function (col) {
        var k = scopeKey(col.label);
        if (!k) return;
        if (!by[k]) {
          by[k] = { key: k, name: col.label, um: col.um || '', total: 0, columns: [] };
          order.push(by[k]);
        }
        // The first column to name a scope decides how it is spelled and what
        // unit it is in; a later one that left its unit blank inherits it.
        if (!by[k].um && col.um) by[k].um = col.um;
        by[k].columns.push({ groupId: g.id, colKey: col.key });
        rows.forEach(function (r) { by[k].total += n(r.values[col.key]); });
      });
    });
    return order;
  }

  function findScope(p, key) {
    var all = productScopes(p);
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }

  function scopeTotal(p, key) {
    var s = key ? findScope(p, key) : null;
    return s ? s.total : null;
  }

  /* ---- quantities ------------------------------------------------------ */

  /* Three quantities, and keeping them apart is the whole point:

       requiredQty  what the job needs   - 76.9 LF of pipe
       packQty      what a vendor sells  - 21 LF to a stick
       orderQty     what you buy         - 4 sticks

     The app used to hold only the last one, so the division happened on a
     calculator and went unrecorded. */
  function requiredQty(item, group, p) {
    if (item.qtyMode === 'takeoff') return scopeTotal(p, item.scopeKey);
    if (item.qtyMode === 'formula') {
      try { return evalQtyExpr(item.qtyExpr, group); }
      catch (e) { return null; }
    }
    return item.qty == null || item.qty === '' ? null : n(item.qty);
  }

  /* Whole items, always - you cannot buy 3.7 sticks of pipe.

     A hand-typed quantity with no pack size is returned exactly as typed. That
     is not an oversight: every material row that predates this feature is one
     of those, so the rounding cannot reach back and change a number an
     estimator already signed off. Rounding starts the moment the row is told
     what a vendor sells it in, or is measured off the drawings. */
  function computedOrderQty(item, group, p) {
    var req = requiredQty(item, group, p);
    if (req == null) return null;
    var per = n(item.packQty);
    if (per > 0) return Math.ceil(req / per);
    return item.qtyMode === 'takeoff' ? Math.ceil(req) : req;
  }

  /* WHAT IS ACTUALLY ORDERED, WHICH IS NOT ALWAYS THE ARITHMETIC.
   *
   * A stick is already on the shelf; the vendor has a minimum of five; two
   * offcuts will cover the short run. The division is right and the answer is
   * still wrong, and the only way to say so used to be unlinking the row from
   * the drawings - which threw away the measurement that justified the number
   * in the first place.
   *
   * So the calculation stays, visible and still recalculating, and the typed
   * figure sits on top of it. Absent means the calculation stands, the same
   * bargain hiddenRows/rowLabels/rowUnits make, which is why no material row
   * already in the database needed a field written to it. */
  function orderQty(item, group, p) {
    var o = item.orderQtyOverride;
    if (o != null && o !== '') return n(o);
    return computedOrderQty(item, group, p);
  }

  /* An override typed when the drawings said one thing, still sitting there
     now they say another.
   *
   * The comparison is against orderQtyBase - what the calculation said at the
   * moment the number was typed - and NOT against the calculation as it stands.
   * Those two readings look alike and only one is any use. A row where the
   * typed 6 differs from the computed 4 is not stale, it is overridden: that
   * disagreement IS the override, and reporting it would be the row telling
   * the estimator what they had just that second decided, on every render,
   * forever. What is worth saying is that the ground has moved since - that the
   * drawings now come to 5 where they came to 4 when 6 was chosen.
   *
   * Reported, never resolved. The estimator may still want their 6.
   *
   * A row overridden with no base recorded says nothing rather than guessing:
   * silence is the safe answer when there is no "before" to compare to. */
  function orderQtyStale(item, group, p) {
    var o = item.orderQtyOverride;
    if (o == null || o === '') return null;
    if (item.orderQtyBase == null) return null;
    var calc = computedOrderQty(item, group, p);
    if (calc == null || calc === n(item.orderQtyBase)) return null;
    return { typed: n(o), was: n(item.orderQtyBase), computes: calc };
  }

  /* What the row is costed at. Kept as the name every caller already uses -
     the tree, the export, the cost roll-up all want the quantity being paid
     for, which is the quantity ordered. */
  function itemQty(item, group, p) { return orderQty(item, group, p); }

  function itemQtyError(item, group, p) {
    if (item.qtyMode === 'takeoff') {
      if (!item.scopeKey) return 'No drawing scope linked';
      return findScope(p, item.scopeKey) ? null
        : 'The drawing scope this row was measured by is gone';
    }
    if (item.qtyMode !== 'formula') return null;
    try { evalQtyExpr(item.qtyExpr, group); return null; }
    catch (e) { return e.message; }
  }

  /* A vendor quotes a stick of pipe either way round - $96.73 for the stick,
     or $4.61 a foot - and which one it is cannot be guessed from the number.
     costBasis says, so the row can carry the quote as given. */
  function itemTotal(item, group, p) {
    if (item.unitCost == null || item.unitCost === '') return 0;
    var q = item.costBasis === 'unit'
      ? requiredQty(item, group, p)
      : orderQty(item, group, p);
    if (q == null) return 0;
    return q * n(item.unitCost);
  }

  /* Whether the pack size is measured in the same thing the scope is. A stick
     of pipe measured in LF against a pack size given in EA is a division that
     means nothing. Reported, never enforced - the estimator may know something
     the units do not say. */
  function unitMismatch(item, group, p) {
    if (item.qtyMode !== 'takeoff') return null;      // nothing to compare against
    if (!(n(item.packQty) > 0) || !item.packUm) return null;
    var s = findScope(p, item.scopeKey);
    if (!s || !s.um) return null;
    if (scopeKey(s.um) === scopeKey(item.packUm)) return null;
    return { from: s.um, to: item.packUm };
  }

  /* Scope in, material row out.
   *
   * Anything measured on the drawings is something that has to be bought, so a
   * scope with a quantity gets a material row without being asked for one.
   * What it will NOT do is take anything away: a scope deleted from the grid
   * leaves its row behind, priced and part-numbered, for somebody to decide
   * about. Losing a costed line because a column was renamed is not a trade
   * worth making for the convenience.
   *
   * Returns the rows it created, so the caller can say so rather than the
   * table quietly growing.
   */
  function syncScopeRows(p) {
    if (!p) return [];
    var linked = {};
    p.groups.forEach(function (g) {
      g.items.forEach(function (it) { if (it.scopeKey) linked[it.scopeKey] = true; });
    });

    var added = [];
    productScopes(p).forEach(function (s) {
      if (linked[s.key] || !s.total) return;
      var owner = p.groups.filter(function (g) {
        return g.id === s.columns[0].groupId;
      })[0] || p.groups[0];
      if (!owner) return;
      var item = newItem({
        feature: s.name,
        um: s.um || 'EA',
        qtyMode: 'takeoff',
        scopeKey: s.key
      });
      // The rate library knows this scope by name if it has been bought before,
      // in which case the row arrives priced. Anything less than an exact,
      // single match is left for the Vendor Part No dropdown to settle.
      var known = root.Catalog && root.Catalog.byFeature
        ? root.Catalog.byFeature(s.name) : [];
      if (known.length === 1) applyCatalogTo(item, known[0]);
      owner.items.push(item);
      linked[s.key] = true;
      added.push(item);
    });
    return added;
  }

  /* Copy a rate-library part onto a material row. Lives here rather than in
     the UI because syncScopeRows needs it too, and two copies of "what a part
     fills in" would drift. */
  function applyCatalogTo(item, c) {
    if (!item || !c) return item;
    item.vendor = c.vendor;
    item.partNo = c.partNo;
    item.description = c.description;
    if (c.feature) item.feature = c.feature;
    if (c.option) item.option = c.option;
    item.material = c.material;
    item.grade = c.grade;
    item.um = c.um || item.um;
    item.unitCost = c.unitCost;
    item.catalogId = c.id;
    if (c.packQty != null && c.packQty !== '') item.packQty = Number(c.packQty);
    if (c.packUm) item.packUm = c.packUm;
    return item;
  }

  /* ---- drawing grid ---------------------------------------------------- */

  /* Keyed three ways on purpose.
   *
   * A TK("...") in a saved quantity formula names a column by the heading it
   * had when the formula was written, and until schema 16 that heading carried
   * the unit in it - 'Top Rail_1-1/2" Pipe (LF)'. Moving the unit into a field
   * of its own would have left every one of those expressions pointing at a
   * column that no longer answers to that name.
   *
   * Rewriting the formulas in the migration was the alternative, and it is the
   * worse one: it means parsing and re-emitting expressions somebody typed, on
   * bids that have already gone out, to fix a name we are the ones who changed.
   * Answering to the old name costs one line. */
  function gridSubtotals(group) {
    var out = {};
    if (!group || !group.grid) return out;
    group.grid.columns.forEach(function (col) {
      var sum = 0;
      group.grid.rows.forEach(function (row) { sum += n(row.values[col.key]); });
      out[col.label] = sum;
      out[col.key] = sum;
      if (col.um) out[col.label + ' (' + col.um + ')'] = sum;
    });
    return out;
  }

  /* ---- documents ------------------------------------------------------- *
   *
   * The drawings a takeoff was measured off, as links rather than as files.
   * They live in OneDrive, where the people who issue them keep issuing them;
   * a copy pulled into this database would be a second, quietly older set of
   * drawings, which is worse than no copy at all.
   *
   * One list per takeoff, shared by every product in it - a drawing set is not
   * a property of the handrail. Created on first read the way projectRates is,
   * so no takeoff already in the database needed a migration to grow one.
   *
   * NOT js/store.js's Docs store: that is an IndexedDB blob store for uploaded
   * files, keyed by bid, and it cannot exist on the localStorage backend at
   * all. A link is small enough to live in the record and sync with it.
   */
  var DOC_CATEGORIES = ['Drawing set', 'Specification', 'Addendum', 'Other'];

  function documents(t) {
    if (!Array.isArray(t.documents)) t.documents = [];
    return t.documents;
  }

  function newDocument(partial) {
    return Object.assign({
      id: uid('doc'), name: '', url: '', category: 'Drawing set',
      addedAt: new Date().toISOString(), addedBy: ''
    }, partial || {});
  }

  function findDocument(t, id) {
    if (!t || !id) return null;
    var list = documents(t);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* Which document a drawing reference opens.
   *
   * A row with no docId follows the takeoff's drawing set, which is what makes
   * "all of them point at the one PDF" the default rather than something to be
   * set up. A row that names a document it no longer has - because somebody
   * deleted it - resolves to null and is drawn as having no link, rather than
   * as an anchor pointing nowhere. */
  function docForRow(t, row) {
    if (!t) return null;
    if (row && row.docId) return findDocument(t, row.docId);
    return findDocument(t, t.drawingDocId);
  }

  /* How many drawing references across the whole takeoff currently open a
     given document. Shown beside it, and named in the confirm before it is
     deleted, so "delete" is never a guess about what it will disconnect. */
  function docRefCount(t, docId) {
    var isDefault = t.drawingDocId === docId;
    var n2 = 0;
    (t.products || []).forEach(function (p) {
      (p.groups || []).forEach(function (g) {
        ((g.grid && g.grid.rows) || []).forEach(function (r) {
          if (r.docId ? r.docId === docId : isDefault) n2++;
        });
      });
    });
    return n2;
  }

  /* ---- product roll-up ------------------------------------------------- */

  /* `p` is the product the group belongs to, needed by any row measured off a
     drawing scope - those total across every group, so the row cannot be
     costed from its own group alone. Optional, and a group whose rows are all
     hand-typed costs the same without it. */
  function groupMaterialCost(group, p) {
    return group.items.reduce(function (s, it) { return s + itemTotal(it, group, p); }, 0);
  }

  function computeProduct(p) {
    var materialCost = p.groups.reduce(function (s, g) { return s + groupMaterialCost(g, p); }, 0);

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

    var extrasTotal = (p.extras || []).reduce(function (s, e) { return s + extraAmount(e); }, 0);

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
    UNITS: UNITS,
    splitColumnUnit: splitColumnUnit, newColumn: newColumn,
    scopeKey: scopeKey, productScopes: productScopes, findScope: findScope,
    scopeTotal: scopeTotal, syncScopeRows: syncScopeRows,
    requiredQty: requiredQty, orderQty: orderQty, unitMismatch: unitMismatch,
    computedOrderQty: computedOrderQty, orderQtyStale: orderQtyStale,
    DOC_CATEGORIES: DOC_CATEGORIES,
    documents: documents, newDocument: newDocument, findDocument: findDocument,
    docForRow: docForRow, docRefCount: docRefCount,
    applyCatalogTo: applyCatalogTo,
    costRowDef: costRowDef,
    rowLabel: rowLabel,
    defaultRowLabel: defaultRowLabel,
    rowUnit: rowUnit,
    defaultRowUnit: defaultRowUnit,
    extraAmount: extraAmount,
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
