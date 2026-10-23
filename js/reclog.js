/* reclog.js - the history of a Production or Inventory record.
 *
 * The bid history (js/history.js) knows bids: their stages, their fields, the
 * takeoff and proposal riding along. This is the same idea for the records
 * that come after the award - sales orders, engineering requests, job orders,
 * parts - kept deliberately smaller: who did what, when, and what moved.
 *
 *   rec.log = [ { id, at, by, kind: 'created'|'edit'|'event', text, changes:[{f, label, a, b}] } ]
 *
 * Each record kind says which fields are worth recording and what to call
 * them - a whitelist, as the bid history keeps, because a log that says
 * `targetAuto: true -> false` buries the line that says the ship date moved.
 *
 * Consecutive edits by the same person within two minutes fold into one entry,
 * so typing a PO number one field at a time is one line, not five.
 */
(function (root) {
  'use strict';

  var U = root.U;
  var MERGE_MS = 2 * 60 * 1000;

  function actor() {
    var u = root.Auth && root.Auth.user;
    if (!u) return '';
    return u.initials || u.name || u.username || '';
  }

  function list(rec) {
    if (!Array.isArray(rec.log)) rec.log = [];
    return rec.log;
  }

  function push(rec, entry) {
    entry.id = root.Store.uid('lg');
    entry.at = entry.at || new Date().toISOString();
    entry.by = entry.by === undefined ? actor() : entry.by;
    list(rec).push(entry);
    rec.updatedAt = entry.at;
    rec.updatedBy = entry.by;
    return entry;
  }

  function show(field, v) {
    if (v == null || v === '') return '(blank)';
    if (field && field.fmt) return field.fmt(v);
    return String(v);
  }

  /* Run fn, then record which of `fields` it changed. fields:
     [{ key, label, fmt? }] - fmt turns a stored value into what the log says. */
  function track(rec, fields, fn) {
    var before = {};
    fields.forEach(function (f) { before[f.key] = JSON.stringify(rec[f.key]); });
    var out = fn();
    var changes = fields.filter(function (f) {
      return JSON.stringify(rec[f.key]) !== before[f.key];
    }).map(function (f) {
      var was = before[f.key] === undefined ? undefined : JSON.parse(before[f.key]);
      return { f: f.key, label: f.label, a: show(f, was), b: show(f, rec[f.key]) };
    });
    if (!changes.length) return out;

    var log = list(rec);
    var last = log[log.length - 1];
    var me = actor();
    if (last && last.kind === 'edit' && last.by === me &&
        Date.now() - Date.parse(last.at) < MERGE_MS) {
      changes.forEach(function (c) {
        var hit = last.changes.filter(function (x) { return x.f === c.f; })[0];
        if (hit) hit.b = c.b; else last.changes.push(c);
      });
      // A field changed and changed back is no change at all.
      last.changes = last.changes.filter(function (x) { return x.a !== x.b; });
      last.at = new Date().toISOString();
      if (!last.changes.length) log.pop();
      rec.updatedAt = last.at || rec.updatedAt;
      return out;
    }
    push(rec, { kind: 'edit', changes: changes });
    return out;
  }

  function card(rec, o) {
    o = o || {};
    var entries = list(rec).slice().reverse();
    var body = entries.length ? entries.map(function (e) {
      var icon = e.kind === 'created' ? 'fa-plus text-ok'
        : e.kind === 'event' ? 'fa-flag text-brand' : 'fa-pen text-muted';
      return '<li class="flex gap-3 py-2 border-b border-line last:border-0">' +
        '<i class="fas ' + icon + ' text-xs mt-1 w-4 text-center"></i>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="text-sm text-ink">' +
            (e.kind === 'edit'
              ? e.changes.map(function (c) {
                  return '<span class="font-semibold">' + U.esc(c.label) + '</span> ' +
                    '<span class="text-muted">' + U.esc(c.a) + '</span> &rarr; ' + U.esc(c.b);
                }).join('<br>')
              : U.esc(e.text || '')) +
          '</div>' +
          '<div class="text-2xs text-faint mt-0.5">' + U.esc(U.stamp ? U.stamp(e.at) : e.at) +
            (e.by ? ' &middot; ' + U.esc(e.by) : '') + '</div>' +
        '</div></li>';
    }).join('') : '<li class="py-6 text-center text-sm text-faint">Nothing recorded yet.</li>';
    return root.UI.card({
      title: o.title || 'History', icon: 'fa-clock-rotate-left',
      body: '<ul class="max-h-96 overflow-y-auto pr-1">' + body + '</ul>'
    });
  }

  root.RecLog = {
    created: function (rec, text) { return push(rec, { kind: 'created', text: text || 'Created.' }); },
    event: function (rec, text) { return push(rec, { kind: 'event', text: text }); },
    track: track,
    card: card,
    actor: actor
  };
})(window);
