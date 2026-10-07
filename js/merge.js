/* merge.js - folding two people's edits to one record into one.
 *
 * The server stores a takeoff, a bid or a proposal as one JSON record. Two
 * people editing the same record at once used to mean one of them lost: the
 * second save was refused as stale and their screen was replaced with the
 * first person's copy. This is the three-way merge that replaces that.
 *
 *   base    the record as this browser last knew the server had it
 *   mine    the record as it is on this screen, with the unsent edits
 *   theirs  the record as the server has it now
 *
 * Whatever only one side changed is taken from that side. Only a value BOTH
 * sides changed to different things is a real clash, and there the local value
 * wins - the person at this screen is looking at it - and the clash is reported
 * so it can be named in a toast rather than happening silently.
 *
 * Lists of things with an id (products, groups, material rows, catalog parts,
 * history entries) or a key (drawing-takeoff columns) are merged by that id:
 * an addition on either side is kept, a deletion on either side is kept, and
 * an edit to one entry does not disturb the others. Lists without ids (the
 * drawing-takeoff rows) merge position by position, with rows added on both
 * sides all kept.
 *
 * Pure - no DOM, no Store - so tests/merge.js runs it under plain node.
 */
(function (root) {
  'use strict';

  function json(x) { return JSON.stringify(x); }
  function eq(a, b) { return a === b || json(a) === json(b); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(json(x)); }

  function identity(x) {
    if (!isObj(x)) return null;
    if (x.id != null && x.id !== '') return 'id:' + x.id;
    if (x.key != null && x.key !== '') return 'key:' + x.key;
    return null;
  }

  /* Every element has an id (or a key), and no two share one. A list that
     breaks either rule is merged by position instead. */
  function keyed(arr) {
    if (!Array.isArray(arr)) return false;
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var k = identity(arr[i]);
      if (k == null || seen[k]) return false;
      seen[k] = true;
    }
    return true;
  }

  /* Timestamps both sides stamped are not a clash anyone needs to hear about:
     the later of the two is the truth for both. */
  function isStamp(key, a, b) {
    return /At$/.test(String(key)) && typeof a === 'string' && typeof b === 'string' &&
      /^\d{4}-\d\d-\d\d/.test(a) && /^\d{4}-\d\d-\d\d/.test(b);
  }

  function merge(base, mine, theirs, path, conflicts, key) {
    if (eq(mine, theirs)) return mine;
    if (eq(mine, base)) return theirs;
    if (eq(theirs, base)) return mine;

    if (isObj(mine) && isObj(theirs)) return mergeObject(isObj(base) ? base : {}, mine, theirs, path, conflicts);

    if (Array.isArray(mine) && Array.isArray(theirs)) {
      var b = Array.isArray(base) ? base : [];
      if (keyed(mine) && keyed(theirs) && keyed(b)) return mergeKeyed(b, mine, theirs, path, conflicts);
      var pos = mergePositional(b, mine, theirs, path, conflicts);
      if (pos) return pos;
      var set = mergeStringSet(b, mine, theirs);
      if (set) return set;
    }

    if (isStamp(key, mine, theirs)) return mine > theirs ? mine : theirs;

    // Both changed it, to different things. The person at this screen keeps theirs.
    conflicts.push({ path: path, mine: mine, theirs: theirs });
    return mine;
  }

  function mergeObject(base, mine, theirs, path, conflicts) {
    var out = {};
    var keys = {};
    [base, mine, theirs].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = true; }); });
    Object.keys(keys).forEach(function (k) {
      var v = merge(base[k], mine[k], theirs[k], path ? path + '.' + k : k, conflicts, k);
      if (v !== undefined) out[k] = v;
    });
    // Keep mine's key order where it has one, so an unchanged record stringifies
    // the same and is not mistaken for an edit.
    var ordered = {};
    Object.keys(mine).concat(Object.keys(out)).forEach(function (k) {
      if (k in out && !(k in ordered)) ordered[k] = out[k];
    });
    return ordered;
  }

  function index(arr) {
    var m = {};
    arr.forEach(function (x) { m[identity(x)] = x; });
    return m;
  }

  function mergeKeyed(base, mine, theirs, path, conflicts) {
    var B = index(base), M = index(mine), T = index(theirs);

    /* Whose order to follow. Theirs, if they moved anything - it is already
       what everybody else sees - otherwise mine, so a reorder made on this
       screen survives a colleague's unrelated edit. */
    function common(arr) {
      return arr.map(identity).filter(function (k) { return k in B && k in M && k in T; })
        .join('\u0001');
    }
    var theyMoved = common(theirs) !== common(base);
    var lead = theyMoved ? theirs : mine;
    var follow = theyMoved ? mine : theirs;
    var L = theyMoved ? T : M;
    var F = theyMoved ? M : T;

    var out = [];
    var placed = {};
    lead.forEach(function (x) {
      var k = identity(x);
      var inBase = k in B, inOther = k in F;
      if (inBase && !inOther) return;           // deleted on the other side
      var v = inOther
        ? merge(B[k], M[k], T[k], path + '[' + k.replace(/^(id|key):/, '') + ']', conflicts)
        : x;
      if (v === undefined) return;
      out.push(v);
      placed[k] = true;
    });

    // The other side's additions, each after whatever it followed over there.
    follow.forEach(function (x, i) {
      var k = identity(x);
      if (placed[k] || k in B || k in L) return;
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        var pk = identity(follow[j]);
        var idx = -1;
        for (var n = 0; n < out.length; n++) if (identity(out[n]) === pk) { idx = n; break; }
        if (idx >= 0) { at = idx + 1; break; }
      }
      out.splice(at, 0, x);
      placed[k] = true;
    });
    return out;
  }

  /* Lists without ids. Safe only when neither side removed anything: then
     position i means the same row on all three, each row merges on its own, and
     rows appended on both sides are all kept - theirs first, since they are
     already on the server. A removal shifts every later row, so it is left to
     the caller's last resort rather than guessed at. */
  function mergePositional(base, mine, theirs, path, conflicts) {
    if (mine.length < base.length || theirs.length < base.length) return null;
    if (!mine.concat(theirs, base).every(function (x) { return isObj(x) || Array.isArray(x); })) return null;
    var out = [];
    for (var i = 0; i < base.length; i++) {
      out.push(merge(base[i], mine[i], theirs[i], path + '[' + i + ']', conflicts));
    }
    var theirAdds = theirs.slice(base.length);
    var myAdds = mine.slice(base.length).filter(function (x) {
      return !theirAdds.some(function (t) { return eq(t, x); });
    });
    return out.concat(theirAdds, myAdds);
  }

  /* A list of names - regions, materials, task types. Treated as a set: what
     either side added is added, what either side removed is removed. */
  function mergeStringSet(base, mine, theirs) {
    var all = base.concat(mine, theirs);
    if (!all.every(function (x) { return typeof x === 'string'; })) return null;
    function unique(a) { return a.length === new Set(a).size; }
    if (!unique(base) || !unique(mine) || !unique(theirs)) return null;
    var removedByMe = base.filter(function (x) { return mine.indexOf(x) < 0; });
    var out = theirs.filter(function (x) { return removedByMe.indexOf(x) < 0; });
    mine.forEach(function (x) {
      if (base.indexOf(x) < 0 && out.indexOf(x) < 0) out.push(x);
    });
    return out;
  }

  /* The entry point. `value` is a fresh object - never one of the three passed
     in - so the caller can drop it straight into the database. */
  function merge3(base, mine, theirs) {
    var conflicts = [];
    var value = merge(clone(base), clone(mine), clone(theirs), '', conflicts);
    return { value: clone(value), conflicts: conflicts };
  }

  /* A clash path as words for a toast: "products[prd-x].groups[grp-y].items[mi-z].qty"
     becomes "qty", which is the part a person recognises. */
  function describe(conflict) {
    var bits = String(conflict.path || '').split(/[.[\]]+/).filter(Boolean);
    return bits.length ? bits[bits.length - 1] : 'a value';
  }

  var Merge = { merge3: merge3, describe: describe, eq: eq };
  if (typeof module !== 'undefined' && module.exports) module.exports = Merge;
  else root.Merge = Merge;
})(typeof window !== 'undefined' ? window : this);
