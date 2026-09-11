/* references.js - the References tab.
 *
 * These are estimating rules of thumb - hours per linear foot, painting rates,
 * pipe schedules. They were hardcoded markup, but rates move, so every heading
 * and every cell is editable and saved with the project.
 *
 * There is deliberately no delete: a reference row that looks wrong today is
 * usually a rate that needs correcting, not a line to remove. Edit it instead,
 * or use "Restore defaults" to put a whole table back.
 */
(function (root) {
  'use strict';

  var U = root.U;
  var editing = false;

  function db() { return root.Store.db; }
  function tables() { return db().references || []; }

  function render() {
    var host = U.$('section-references');
    if (!host || host.classList.contains('hidden')) return;

    host.innerHTML =
      '<div class="flex flex-wrap items-center justify-between gap-3 mb-5">' +
        '<div>' +
          '<h2 class="text-lg font-bold text-ink-strong">Reference Tables</h2>' +
          '<p class="text-xs text-muted mt-0.5">Estimating rules of thumb. ' +
            'Rates change &mdash; edit any heading or value and it is saved with the project.</p>' +
        '</div>' +
        '<button onclick="References.toggleEdit()" class="px-4 py-2 rounded-lg text-sm font-semibold transition ' +
          (editing ? 'bg-ok hover:bg-ok-hover text-white' : 'bg-chrome hover:bg-chrome-soft text-white') + '">' +
          '<i class="fas ' + (editing ? 'fa-check' : 'fa-pen') + ' mr-1.5"></i>' +
          (editing ? 'Done editing' : 'Edit tables') + '</button>' +
      '</div>' +
      '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">' +
        tables().map(renderTable).join('') +
      '</div>' +
      (editing
        ? '<p class="mt-4 text-2xs text-faint">' +
          'Click any heading, row label or value to change it. Values are free text so ' +
          'ranges like <code class="bg-neutral-soft px-1 rounded">0.15 - 0.25</code> keep their form.</p>'
        : '');
  }

  function renderTable(t, ti) {
    return '<div class="bg-surface rounded-xl shadow-sm p-6 border border-line">' +
      '<div class="flex items-start justify-between gap-2 mb-4">' +
        '<h3 class="text-lg font-bold text-ink-strong flex items-center gap-2 flex-1 min-w-0">' +
          '<i class="fas ' + U.escAttr(t.icon || 'fa-table') + ' text-brand"></i>' +
          (editing
            ? '<input value="' + U.escAttr(t.title) + '" onchange="References.setTitle(' + ti + ',this.value)" ' +
              'class="flex-1 min-w-0 px-2 py-1 bg-warn-soft border border-warn/30 rounded text-lg font-bold text-ink-strong outline-none focus:border-brand">'
            : U.esc(t.title)) +
        '</h3>' +
        (editing
          ? '<button onclick="References.restore(' + ti + ')" title="Restore this table to the shipped defaults" ' +
            'class="text-2xs text-faint hover:text-brand-ink underline whitespace-nowrap shrink-0">Restore defaults</button>'
          : '') +
      '</div>' +
      '<table class="w-full text-sm grid-table"><thead><tr>' +
        t.columns.map(function (c, ci) {
          return '<th class="px-3 py-2 col-' + c.align + ' font-semibold text-muted text-xs">' +
            (editing
              ? '<input value="' + U.escAttr(c.label) + '" onchange="References.setColumn(' + ti + ',' + ci + ',this.value)" ' +
                'class="w-full px-1 py-0.5 bg-warn-soft border border-warn/30 rounded text-xs font-semibold col-' + c.align + ' outline-none focus:border-brand">'
              : U.esc(c.label)) + '</th>';
        }).join('') +
      '</tr></thead><tbody>' +
        t.rows.map(function (row, ri) {
          return '<tr>' + t.columns.map(function (c, ci) {
            var v = row[ci] == null ? '' : row[ci];
            // First column is the row's name; the rest are values. Both edit
            // the same way, so there is one thing to learn.
            var mono = ci > 0 ? ' font-mono' : '';
            return '<td class="px-3 py-2 col-' + c.align + mono + '">' +
              (editing
                ? '<input value="' + U.escAttr(v) + '" onchange="References.setCell(' + ti + ',' + ri + ',' + ci + ',this.value)" ' +
                  'class="w-full px-1 py-0.5 bg-warn-soft border border-warn/30 rounded text-sm col-' + c.align + mono +
                  ' outline-none focus:border-brand">'
                : U.esc(v)) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
      '</tbody></table></div>';
  }

  function seedFor(id) {
    var seed = root.REFERENCE_SEED || [];
    for (var i = 0; i < seed.length; i++) if (seed[i].id === id) return seed[i];
    return null;
  }

  root.References = {
    render: render,

    toggleEdit: function () {
      editing = !editing;
      render();
      if (!editing) U.toast('Reference tables saved.', 'ok');
    },

    setTitle: function (ti, v) {
      var t = tables()[ti];
      var name = String(v || '').trim();
      if (!name) { render(); return; }   // never let a table lose its heading
      t.title = name;
      root.Store.save();
    },
    setColumn: function (ti, ci, v) {
      var c = tables()[ti].columns[ci];
      var name = String(v || '').trim();
      if (!name) { render(); return; }
      c.label = name;
      root.Store.save();
    },
    setCell: function (ti, ri, ci, v) {
      // Free text on purpose: these hold ranges like "0.15 - 0.25" and sizes
      // like '1.900" (48.3 mm)', which a number input would destroy.
      tables()[ti].rows[ri][ci] = String(v == null ? '' : v).trim();
      root.Store.save();
    },

    restore: function (ti) {
      var t = tables()[ti];
      var seed = seedFor(t.id);
      if (!seed) { U.toast('No shipped defaults for this table.', 'warn'); return; }
      if (!confirm('Restore "' + t.title + '" to the shipped defaults?\n\n' +
        'Any rates you have edited in this table will be replaced.')) return;
      db().references[ti] = JSON.parse(JSON.stringify(seed));
      root.Store.save();
      render();
      U.toast('"' + seed.title + '" restored.', 'ok');
    },

    /* Exposed for tests and for anything that needs to read a rate. */
    table: function (id) {
      return tables().filter(function (t) { return t.id === id; })[0] || null;
    }
  };
})(window);
