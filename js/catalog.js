/* catalog.js - the parts catalog / rate library.

   It seeds from the real parts in the Lancaster workbook and then grows on its
   own: every material row you type that isn't already known gets folded in when
   the takeoff saves, so the second time you reach for that part it autofills.
   Prices are versioned rather than overwritten, so you keep a trail of what a
   part cost and when. */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s\-_.\/]+/g, '').trim();
  }

  /* Identity: vendor + part number, falling back to the description when a row
     has no part number (McMaster rows always do, shop-fabricated ones don't). */
  function keyOf(item) {
    var v = norm(item.vendor);
    var p = norm(item.partNo);
    return p ? v + '|' + p : v + '|~' + norm(item.description);
  }

  function ensure(db) {
    if (!Array.isArray(db.catalog)) db.catalog = [];
    if (db.catalog.length === 0 && Array.isArray(root.CATALOG_SEED)) {
      db.catalog = root.CATALOG_SEED.map(function (s) {
        return {
          id: root.Store.uid('cat'),
          vendor: s.vendor || '', partNo: s.partNo || '',
          description: s.description || '', feature: s.feature || '',
          option: s.option || '', material: s.material || '',
          grade: s.grade || '', um: s.um || 'EA',
          unitCost: s.unitCost == null ? null : Number(s.unitCost),
          weightPerUnit: s.weightPerUnit == null ? null : Number(s.weightPerUnit),
          sowTags: (s.sowTags || []).slice(),
          useCount: 1, lastUsedAt: null,
          source: 'seed',
          priceHistory: s.unitCost == null ? [] :
            [{ cost: Number(s.unitCost), at: null, project: 'Lancaster Township (seed)' }]
        };
      });
    }
    return db.catalog;
  }

  function all() { return ensure(root.Store.db); }

  function byKey() {
    var map = {};
    all().forEach(function (c) { map[keyOf(c)] = c; });
    return map;
  }

  function find(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ---- fuzzy matching -------------------------------------------------- */

  /* Subsequence match, rewarding hits at word starts and runs of adjacent
     characters. Enough to make "12801400" and "sch 40 pipe" both land. */
  function fuzzyScore(needle, haystack) {
    var n = needle.toLowerCase(), h = haystack.toLowerCase();
    if (!n) return 0;
    var idx = h.indexOf(n);
    if (idx === 0) return 100;
    if (idx > 0) return 70 - Math.min(idx, 30) * 0.5;

    var hi = 0, score = 0, run = 0;
    for (var i = 0; i < n.length; i++) {
      var found = h.indexOf(n[i], hi);
      if (found < 0) return 0;
      var atWordStart = found === 0 || /[\s\-_.\/(]/.test(h[found - 1]);
      run = found === hi ? run + 1 : 0;
      score += 1 + run * 0.6 + (atWordStart ? 1.5 : 0);
      hi = found + 1;
    }
    return Math.min(score * 2, 60);
  }

  function recencyBoost(lastUsedAt) {
    if (!lastUsedAt) return 0;
    var days = (Date.now() - new Date(lastUsedAt).getTime()) / 86400000;
    if (days < 0) return 0;
    return 6 * Math.exp(-days / 45);          // ~6 today, ~3 after six weeks
  }

  /* Suggestions for a material row. `productType` biases toward parts already
     used on this kind of sheet, which is what keeps a growing list usable. */
  function suggest(query, productType, limit) {
    limit = limit || 8;
    var q = String(query || '').trim();
    var items = all();
    var scored = [];

    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      var match = 0;
      if (q) {
        match = Math.max(
          fuzzyScore(q, c.partNo || ''),
          fuzzyScore(q, c.description || ''),
          fuzzyScore(q, c.feature || ''),
          fuzzyScore(q, c.vendor || '') * 0.7
        );
        if (match <= 0) continue;
      }
      var onType = productType && c.sowTags.indexOf(productType) >= 0;
      scored.push({
        item: c,
        onType: !!onType,
        score: match +
          (onType ? 30 : 0) +
          2 * Math.log(1 + (c.useCount || 0)) +
          recencyBoost(c.lastUsedAt)
      });
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit);
  }

  /* ---- learning -------------------------------------------------------- */

  function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    var shorter = a.length < b.length ? a : b;
    var longer = a.length < b.length ? b : a;
    var hits = 0;
    for (var i = 0; i < shorter.length; i++) if (longer.indexOf(shorter[i]) >= 0) hits++;
    return (hits / longer.length) * (shorter.length / longer.length);
  }

  /* Called once per material row when a takeoff saves. Adds unknown parts,
     versions changed prices, and reports what happened so the row can show a
     price-delta chip. Never blocks or prompts. */
  function learn(row, productType, projectName) {
    if (!row || (!row.description && !row.partNo)) return null;
    var db = root.Store.db;
    ensure(db);
    var map = byKey();
    var k = keyOf(row);
    var now = new Date().toISOString();
    var cost = row.unitCost == null || row.unitCost === '' ? null : Number(row.unitCost);
    var existing = map[k];

    if (!existing) {
      var added = {
        id: root.Store.uid('cat'),
        vendor: row.vendor || '', partNo: row.partNo || '',
        description: row.description || '', feature: row.feature || '',
        option: row.option || '', material: row.material || '',
        grade: row.grade || '', um: row.um || 'EA',
        unitCost: cost,
        weightPerUnit: row.weightLb && row.qty ? Number(row.weightLb) / Number(row.qty) : null,
        sowTags: productType ? [productType] : [],
        useCount: 1, lastUsedAt: now,
        source: 'learned',
        priceHistory: cost == null ? [] : [{ cost: cost, at: now, project: projectName || '' }]
      };
      db.catalog.push(added);
      return { action: 'added', item: added, dupOf: findNearDuplicate(added) };
    }

    existing.useCount = (existing.useCount || 0) + 1;
    existing.lastUsedAt = now;
    if (productType && existing.sowTags.indexOf(productType) < 0) {
      existing.sowTags.push(productType);
    }
    // Keep the richest description/material we have seen.
    ['description', 'feature', 'option', 'material', 'grade', 'um'].forEach(function (f) {
      if (!existing[f] && row[f]) existing[f] = row[f];
    });

    var prev = existing.unitCost;
    if (cost != null && prev !== cost) {
      existing.priceHistory = existing.priceHistory || [];
      existing.priceHistory.push({ cost: cost, at: now, project: projectName || '' });
      if (existing.priceHistory.length > 20) existing.priceHistory.shift();
      existing.unitCost = cost;
      return {
        action: 'repriced', item: existing, from: prev, to: cost,
        delta: prev == null ? null : cost - prev
      };
    }
    return { action: 'used', item: existing };
  }

  function findNearDuplicate(item) {
    if (item.partNo) return null;    // part numbers are authoritative
    var list = all();
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.id === item.id) continue;
      if (norm(c.vendor) !== norm(item.vendor)) continue;
      if (similarity(c.description, item.description) >= 0.9) return c;
    }
    return null;
  }

  function merge(keepId, dropId) {
    var db = root.Store.db;
    var keep = find(keepId), drop = find(dropId);
    if (!keep || !drop || keep === drop) return false;
    keep.useCount = (keep.useCount || 0) + (drop.useCount || 0);
    drop.sowTags.forEach(function (t) {
      if (keep.sowTags.indexOf(t) < 0) keep.sowTags.push(t);
    });
    keep.priceHistory = (keep.priceHistory || []).concat(drop.priceHistory || [])
      .sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : 1; })
      .slice(-20);
    if (!keep.lastUsedAt || (drop.lastUsedAt && drop.lastUsedAt > keep.lastUsedAt)) {
      keep.lastUsedAt = drop.lastUsedAt;
    }
    db.catalog = db.catalog.filter(function (c) { return c.id !== dropId; });
    root.Store.save();
    return true;
  }

  /* Every pair that looks like the same part entered twice. */
  function duplicates() {
    var list = all(), out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        if (norm(a.vendor) !== norm(b.vendor)) continue;
        var same = (a.partNo && norm(a.partNo) === norm(b.partNo)) ||
          (!a.partNo && !b.partNo && similarity(a.description, b.description) >= 0.9);
        if (!same) continue;
        var k = a.id + '|' + b.id;
        if (seen[k]) continue;
        seen[k] = 1;
        out.push({ a: a, b: b });
      }
    }
    return out;
  }

  /* ---- CRUD + CSV ------------------------------------------------------ */

  function create(partial) {
    var db = root.Store.db;
    ensure(db);
    var item = Object.assign({
      id: root.Store.uid('cat'),
      vendor: '', partNo: '', description: '', feature: '', option: '',
      material: '', grade: '', um: 'EA', unitCost: null, weightPerUnit: null,
      sowTags: [], useCount: 0, lastUsedAt: null, source: 'learned', priceHistory: []
    }, partial || {});
    db.catalog.push(item);
    root.Store.save();
    return item;
  }

  function update(id, patch) {
    var item = find(id);
    if (!item) return null;
    if (patch.unitCost !== undefined) {
      var cost = patch.unitCost === '' || patch.unitCost == null ? null : Number(patch.unitCost);
      if (cost !== item.unitCost && cost != null) {
        item.priceHistory = item.priceHistory || [];
        item.priceHistory.push({ cost: cost, at: new Date().toISOString(), project: 'manual edit' });
        if (item.priceHistory.length > 20) item.priceHistory.shift();
      }
      patch.unitCost = cost;
    }
    Object.assign(item, patch);
    root.Store.save();
    return item;
  }

  function remove(ids) {
    var db = root.Store.db;
    var set = {};
    (Array.isArray(ids) ? ids : [ids]).forEach(function (i) { set[i] = 1; });
    db.catalog = db.catalog.filter(function (c) { return !set[c.id]; });
    root.Store.save();
  }

  var CSV_COLS = ['vendor', 'partNo', 'description', 'feature', 'option',
    'material', 'grade', 'um', 'unitCost', 'weightPerUnit', 'sowTags'];

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    var rows = [CSV_COLS.join(',')];
    all().forEach(function (c) {
      rows.push(CSV_COLS.map(function (k) {
        return csvCell(k === 'sowTags' ? c.sowTags.join('; ') : c[k]);
      }).join(','));
    });
    var blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'rate-library-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function importCSV(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { added: 0, updated: 0 };
    var head = rows[0].map(function (h) { return h.trim(); });
    var map = byKey(), added = 0, updated = 0;
    for (var r = 1; r < rows.length; r++) {
      if (!rows[r].join('').trim()) continue;
      var rec = {};
      head.forEach(function (h, i) { rec[h] = (rows[r][i] || '').trim(); });
      if (!rec.description && !rec.partNo) continue;
      rec.unitCost = rec.unitCost === '' ? null : Number(rec.unitCost);
      rec.weightPerUnit = rec.weightPerUnit === '' ? null : Number(rec.weightPerUnit);
      rec.sowTags = rec.sowTags ? rec.sowTags.split(/\s*;\s*/).filter(Boolean) : [];
      var existing = map[keyOf(rec)];
      if (existing) { update(existing.id, rec); updated++; }
      else { map[keyOf(rec)] = create(rec); added++; }
    }
    root.Store.save();
    return { added: added, updated: updated };
  }

  root.Catalog = {
    ensure: ensure, all: all, find: find, keyOf: keyOf,
    suggest: suggest, learn: learn, merge: merge, duplicates: duplicates,
    create: create, update: update, remove: remove,
    exportCSV: exportCSV, importCSV: importCSV,
    fuzzyScore: fuzzyScore
  };
})(window);
