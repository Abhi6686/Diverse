/* products.js - what a project is made of, and what each part is made from.
 *
 *   bid.productLines = [ { id, product, materials: [ ... ] }, ... ]
 *
 * One row per product, each carrying its own materials. A project is routinely
 * several products - handrail in one material, bollards in another, a platform
 * in a third - and the bid form had a flat list of products beside a single
 * material select, which could not say which was which. On a bid with three
 * products and two materials the pairing simply was not recorded anywhere.
 *
 * DERIVED FIELDS. bid.products and bid.material still exist and are still what
 * the grid columns, their filters, the XLSX export and the dashboard charts
 * read. They are a projection of productLines, rewritten by sync() on every
 * mutation, so none of those call sites had to change and there is exactly one
 * place the two can be brought back into step. productLines is the record;
 * those two are a view of it.
 *
 * Modelled on js/assignments.js, deliberately and closely: same row shape, same
 * card, same "a new value joins the shared list" bargain. They are the same
 * kind of thing - a small table of rows hanging off a bid - and somebody who
 * has read one should recognise the other.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  function rows(bid) {
    return (bid && Array.isArray(bid.productLines)) ? bid.productLines : [];
  }

  function bidById(id) {
    return db().bids.filter(function (b) { return b.id === id; })[0] || null;
  }

  function rowById(bid, rowId) {
    return rows(bid).filter(function (r) { return r.id === rowId; })[0] || null;
  }

  function materialsOf(r) {
    return (r && Array.isArray(r.materials)) ? r.materials.filter(Boolean) : [];
  }

  /* ---- the derived fields ------------------------------------------------ */

  /* The one place bid.products and bid.material are written.
   *
   * Distinct and order-preserving: a project with two products in carbon steel
   * is one material, not two, and the Material column's filter would otherwise
   * offer "Carbon steel" twice. */
  function distinct(list) {
    var seen = {}, out = [];
    list.forEach(function (v) {
      var k = String(v == null ? '' : v).trim();
      if (!k || seen[k.toLowerCase()]) return;
      seen[k.toLowerCase()] = true;
      out.push(k);
    });
    return out;
  }

  function sync(bid) {
    if (!bid) return;
    var lines = rows(bid);
    bid.products = distinct(lines.map(function (r) { return r.product; }));
    // The grid's Material column is a single value per bid, so several
    // materials read as a list. Kept as a string rather than an array because
    // that is what every existing reader expects.
    bid.material = distinct(lines.reduce(function (acc, r) {
      return acc.concat(materialsOf(r));
    }, [])).join(', ');
  }

  /* ---- mutations --------------------------------------------------------- */

  /* Recorded the same way js/assignments.js records its card, and for the same
     reason: save() runs after the mutation, so the "before" is taken at the top
     of each entry point. See the note there. */
  var pending = null;

  function begin(bid) {
    pending = bid ? root.History.snapshot(bid) : null;
  }

  function save(bid) {
    sync(bid);
    if (pending && bid) {
      root.History.recordEdit(bid, root.History.diff(pending, bid));
    }
    pending = null;
    root.Store.save();
    render(bid);
    if (root.Bids) root.Bids.filterTable();
  }

  function add(bidId) {
    var bid = bidById(bidId);
    if (!bid) return;
    begin(bid);
    if (!Array.isArray(bid.productLines)) bid.productLines = [];
    bid.productLines.push({ id: root.Store.uid('pl'), product: '', materials: [] });
    save(bid);
    var last = bid.productLines[bid.productLines.length - 1];
    var el = U.$('pl-product-' + last.id);
    if (el) el.focus();
  }

  function remove(bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    // Only ask when there is something to lose.
    if ((row.product || materialsOf(row).length) &&
        !confirm('Remove ' + (row.product || 'this row') + ' from this project?')) return;
    // After the confirm: a cancelled removal must leave no snapshot behind.
    begin(bid);
    bid.productLines = rows(bid).filter(function (r) { return r.id !== rowId; });
    save(bid);
  }

  /* A product chosen from the dropdown, or a new one typed into the prompt. The
     new one joins db.productTypes, which is the same bargain the bid form's
     picker makes - see Bids.onProductChange. */
  function onProductChange(sel, bidId, rowId) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    begin(bid);

    if (sel.value !== '__add') {
      row.product = sel.value;
      save(bid);
      return;
    }

    var name = (prompt('Name for the new product type:', '') || '').trim();
    // Cancelled: drop the snapshot, or the next save would diff against it.
    if (!name) { pending = null; render(bid); return; }
    var d = db();
    var existing = d.productTypes.filter(function (p) {
      return p.toLowerCase() === name.toLowerCase();
    })[0];
    if (existing) {
      U.toast('"' + existing + '" is already in the list - selected it.', 'warn');
      row.product = existing;
    } else {
      d.productTypes.push(name);
      row.product = name;
      U.toast('"' + name + '" added to the product list.', 'ok');
    }
    save(bid);
  }

  /* Materials are a set per row, so this toggles rather than assigns. */
  function toggleMaterial(bidId, rowId, name) {
    var bid = bidById(bidId);
    var row = rowById(bid, rowId);
    if (!row) return;
    begin(bid);
    if (!Array.isArray(row.materials)) row.materials = [];
    var i = row.materials.indexOf(name);
    if (i >= 0) row.materials.splice(i, 1); else row.materials.push(name);
    save(bid);
  }

  function onMaterialAdd(sel, bidId, rowId) {
    var value = sel.value;
    sel.value = '';
    if (!value) return;

    if (value !== '__add') { toggleMaterial(bidId, rowId, value); return; }

    var name = (prompt('Name for the new material:', '') || '').trim();
    if (!name) { render(bidById(bidId)); return; }
    var d = db();
    var existing = d.materials.filter(function (m) {
      return m.toLowerCase() === name.toLowerCase();
    })[0];
    if (existing) {
      U.toast('"' + existing + '" is already in the list - selected it.', 'warn');
      toggleMaterial(bidId, rowId, existing);
      return;
    }
    d.materials.push(name);
    toggleMaterial(bidId, rowId, name);
    U.toast('"' + name + '" added to the material list.', 'ok');
  }

  /* ---- the card ---------------------------------------------------------- */

  function row(bidId, r) {
    var types = db().productTypes || [];
    var mats = db().materials || [];
    // A value that predates the managed list stays selectable on its own row
    // instead of being dropped when the select is rebuilt.
    var known = types.indexOf(r.product) >= 0;
    var chosen = materialsOf(r);

    return '<tr class="border-t border-line align-top">' +
      '<td class="py-2 pr-2 w-56">' +
        '<select aria-label="Product" id="pl-product-' + r.id + '" ' +
          'onchange="Products.onProductChange(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
          '<option value="">Select product...</option>' +
          (r.product && !known
            ? '<option value="' + U.escAttr(r.product) + '" selected>' + U.esc(r.product) + '</option>'
            : '') +
          types.map(function (t) {
            return '<option value="' + U.escAttr(t) + '"' + (t === r.product ? ' selected' : '') + '>' +
              U.esc(t) + '</option>';
          }).join('') +
          '<option value="__add">+ Add new product...</option>' +
        '</select>' +
      '</td>' +
      '<td class="py-2 pr-2">' +
        '<div class="flex flex-wrap gap-1 mb-1.5 min-h-[22px] items-center">' +
          (chosen.length
            ? chosen.map(function (m) {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs ' +
                  'font-medium bg-brand-soft text-brand-ink">' + U.esc(m) +
                  '<button type="button" onclick="Products.toggleMaterial(' + bidId + ',\'' +
                    r.id + '\',\'' + U.escAttr(m).replace(/'/g, '&#39;') + '\')" ' +
                    'class="hover:text-danger leading-none" aria-label="Remove ' + U.escAttr(m) + '">' +
                    '&times;</button></span>';
              }).join('')
            : '<span class="text-2xs text-faint">No material yet</span>') +
        '</div>' +
        '<select aria-label="Add a material" ' +
          'onchange="Products.onMaterialAdd(this,' + bidId + ',\'' + r.id + '\')" ' +
          'class="w-full px-2 py-1.5 bg-surface border border-line rounded text-sm outline-none focus:border-brand">' +
          '<option value="">+ Add material...</option>' +
          mats.filter(function (m) { return chosen.indexOf(m) < 0; })
            .map(function (m) {
              return '<option value="' + U.escAttr(m) + '">' + U.esc(m) + '</option>';
            }).join('') +
          '<option value="__add">+ Add new material...</option>' +
        '</select>' +
      '</td>' +
      '<td class="py-2 w-10 text-center">' +
        '<button onclick="Products.remove(' + bidId + ',\'' + r.id + '\')" title="Remove this row" ' +
          'class="btn-icon w-7 h-7 rounded-lg bg-danger-soft text-danger-ink hover:bg-danger-soft/60 inline-flex items-center justify-center">' +
          '<i class="fas fa-trash text-xs"></i></button>' +
      '</td>' +
    '</tr>';
  }

  function card(bid) {
    var body = rows(bid).length
      ? '<div class="overflow-x-auto"><table class="w-full text-sm">' +
          '<thead><tr class="text-3xs font-bold text-faint uppercase tracking-wider text-left">' +
            '<th class="pb-2 pr-2">Product</th>' +
            '<th class="pb-2 pr-2">Material</th>' +
            '<th class="pb-2"></th>' +
          '</tr></thead><tbody>' +
          rows(bid).map(function (r) { return row(bid.id, r); }).join('') +
          '</tbody></table></div>'
      : '<div class="text-center py-8">' +
          '<div class="w-12 h-12 bg-neutral-soft rounded-xl flex items-center justify-center mx-auto mb-3">' +
            '<i class="fas fa-layer-group text-faint"></i></div>' +
          '<p class="text-sm text-muted max-w-sm mx-auto">Nothing listed for this project yet. ' +
          'Add a row per product &mdash; each one carries its own materials, and the ' +
          'Product and Material columns on the bids table are built from these rows.</p>' +
        '</div>';

    return '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden" id="productsCard">' +
      '<div class="px-5 py-3 border-b border-line bg-raised flex items-center justify-between gap-3">' +
        '<h3 class="text-sm font-bold text-ink flex items-center gap-2">' +
          '<i class="fas fa-layer-group text-muted"></i>Products &amp; Materials' +
        '</h3>' +
        '<button onclick="Products.add(' + bid.id + ')" ' +
          'class="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-xs font-semibold flex items-center gap-1.5">' +
          '<i class="fas fa-plus"></i>Add product</button>' +
      '</div>' +
      '<div class="p-5">' + body + '</div></div>';
  }

  /* Repaint just this card. The project page owns the host, so re-rendering the
     whole page from here would fight it for the DOM. */
  function render(bid) {
    var host = U.$('productsCard');
    if (!host || !bid) return;
    host.outerHTML = card(bid);
  }

  root.Products = {
    rows: rows,
    materialsOf: materialsOf,
    sync: sync,
    card: card,
    render: render,
    add: add,
    remove: remove,
    toggleMaterial: toggleMaterial,
    onProductChange: onProductChange,
    onMaterialAdd: onMaterialAdd,

    /* Build the rows from the flat fields a bid used to carry - used by the bid
       form, which still offers the quick intake path of "these products, that
       material" and writes through to here.

       The conversion itself lives in js/store.js, which needs it for the seed
       and the migration and must not depend on this file. One definition. */
    fromFlat: function (products, material) {
      return root.Store.productLinesFromFlat({ products: products, material: material });
    },

    /* Carries a rename through every row that used the value, the same way
       Assign.renameTaskType and Bids.updateEngineer do. */
    renameMaterial: function (from, to) {
      var n = 0;
      db().bids.forEach(function (b) {
        var touched = false;
        rows(b).forEach(function (r) {
          var i = materialsOf(r).indexOf(from);
          if (i >= 0) { r.materials[r.materials.indexOf(from)] = to; n++; touched = true; }
        });
        if (touched) sync(b);
      });
      return n;
    },
    countMaterial: function (name) {
      var n = 0;
      db().bids.forEach(function (b) {
        rows(b).forEach(function (r) { if (materialsOf(r).indexOf(name) >= 0) n++; });
      });
      return n;
    }
  };
})(window);
