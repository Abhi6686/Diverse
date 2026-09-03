/* proposal.js - the client-facing bid proposal, rebuilt natively.

   Keeps the exact JSON shape of Bid Proposal v3 1.html
     {version, selectedStyle, frameLogo, hasManuallyToggledLogoFrame,
      proposalData, companyData, scopeItems:[{id,no,description,details,cost}]}
   so templates move between the two apps in either direction. The nine style
   definitions are lifted verbatim into js/proposal.styles.js. */
(function (root) {
  'use strict';

  var U = root.U, M = root.TakeoffModel;
  var state = { id: null, editing: 'content' };

  function db() { return root.Store.db; }
  function current() { return state.id ? db().proposals[state.id] : null; }
  function save() { root.Store.save(); render(); }

  function blank(bid) {
    return {
      id: root.Store.uid('pro'),
      takeoffId: null,
      bidId: bid ? bid.id : null,
      version: '1.0.0',
      selectedStyle: 1,
      frameLogo: true,
      hasManuallyToggledLogoFrame: false,
      showRollupLines: true,
      proposalData: Object.assign({
        proposalNo: '', submittedDate: U.today(), approvalDeadline: '',
        projectName: bid ? bid.project : '', projectAddress: ''
      }, JSON.parse(JSON.stringify(root.PROPOSAL_DEFAULTS || {}))),
      companyData: Object.assign({}, db().company || root.COMPANY_DEFAULT || {}),
      scopeItems: []
    };
  }

  /* ---- generation from a takeoff --------------------------------------- */

  /* The scope bullets for one product.

     What appears here is curated in the takeoff: every material row and every
     Cost & Labour row carries a tick box, and only ticked rows are described.
     Unticking never changes the price - it just stops telling the client about
     that line. Amounts are never printed per line; the product carries one
     price. */
  /* A spec line: the feature, then the full description of the part.
     "Pipe - Carbon Steel 8 SCH 40 PIPE A-500 GR B 8.625\" OD .322 Thk." This
     reads from the Description rather than the old Options column, which held
     an abbreviated restatement of the same thing - the client should be given
     the full specification, not the shorthand. */
  function specOf(it) {
    return [it.feature, it.description].filter(Boolean).join(' - ');
  }

  function detailsFor(p) {
    var html = [];
    var seen = {};

    /* A product with more than one component group prints each group as its own
       sub-heading with its parts under it - "Embedded Bollards", then its
       specs; "Surface Mounted Bollards", then its. With a single group there is
       nothing to distinguish, so the name is left out.

       Deduping is per group rather than across the product, so the same pipe
       appearing under both bollard types is listed under both, which is what
       the reader needs. */
    var multi = p.groups.length > 1;

    function bullets(list) {
      return list.length
        ? '<ul>' + list.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul>'
        : '';
    }

    var lead = [];
    if (p.material) lead.push('Material: ' + p.material);
    if (lead.length) html.push(bullets(lead));

    p.groups.forEach(function (g) {
      var specs = [];
      g.items.forEach(function (it) {
        if (!M.isItemOnProposal(it)) return;
        var s = specOf(it);
        var key = (multi ? g.id + '|' : '') + s;
        if (!s || seen[key]) return;
        seen[key] = true;
        specs.push(s);
      });
      if (!specs.length) return;
      if (multi) html.push('<p>' + U.esc(g.name) + '</p>');
      html.push(bullets(specs));
    });

    // Ticked Cost & Labour rows become inclusion bullets under their current
    // (possibly renamed) description.
    var tail = [];
    M.COST_ROWS.forEach(function (def) {
      if (!M.isRowOnProposal(p, def.id)) return;
      var label = M.rowLabel(p, def.id);
      if (label && tail.indexOf(label) < 0) tail.push(label);
    });
    (p.extras || []).forEach(function (e) {
      if (e.showInProposal === false || !e.label) return;
      if (tail.indexOf(e.label) < 0) tail.push(e.label);
    });

    // The linear-feet line the proposal has to carry per product type. Always
    // present, regardless of what has been unticked.
    if (p.unit === 'EA') {
      if (p.totalQty || p.totalLF) tail.push('Total Quantity: ' + U.qty(p.totalQty || p.totalLF) + ' EA');
    } else if (p.totalLF) {
      tail.push('Total Linear Feet: ' + U.qty(p.totalLF) + ' LF');
    }
    if (tail.length) html.push(bullets(tail));

    return html.join('');
  }

  function generateFromTakeoff(takeoffId) {
    var d = db();
    var t = d.takeoffs[takeoffId];
    if (!t) { U.toast('That takeoff no longer exists.', 'err'); return; }
    if (!t.products.length) {
      U.toast('Add at least one product type before generating a proposal.', 'warn');
      return;
    }
    var bid = t.bidId ? d.bids.filter(function (b) { return b.id === t.bidId; })[0] : null;

    var existingId = bid && bid.proposalId && d.proposals[bid.proposalId] ? bid.proposalId : null;
    var p = existingId ? d.proposals[existingId] : blank(bid);
    var isRegen = !!existingId && p.scopeItems.length > 0;

    if (isRegen) {
      var locked = p.scopeItems.filter(function (s) { return s.locked; }).length;
      var msg = 'Regenerate the scope items from this takeoff?\n\n' +
        'Costs and linear feet will be refreshed from the estimate.' +
        (locked ? '\n' + locked + ' locked item(s) will keep their wording.'
                : '\nAny wording you edited will be overwritten - lock an item first to keep it.');
      if (!confirm(msg)) return;
    }

    var prevByType = {};
    p.scopeItems.forEach(function (s) { if (s.sourceType) prevByType[s.sourceType] = s; });

    var roll = M.computeTakeoff(t);

    /* Miscellaneous never appears as its own line - the client should not be
       reading an invoice for welding consumables. It is spread equally across
       the product lines instead, and so is the rounding uplift, so the printed
       TOTAL BID PRICE lands exactly on the rounded figure with no stray
       "Roundoff" row. When the rollup breakdown is switched off, freight and
       tax fold in the same way, so the proposal total always equals the
       takeoff's Total Bid Cost either way. */
    var folded = roll.misc + roll.roundoff;
    if (!p.showRollupLines) folded += roll.freight + roll.tax;
    var shares = splitEqually(folded, roll.products.length);

    var items = [];
    roll.products.forEach(function (x, i) {
      var prod = x.product;
      var prev = prevByType[prod.type];
      // Added in whole cents so the distributed pennies cannot drift.
      var cents = Math.round(x.calc.total * 100) + Math.round((shares[i] || 0) * 100);
      items.push({
        id: prev ? prev.id : root.Store.uid('si'),
        no: i + 1,
        sourceType: prod.type,
        locked: prev ? !!prev.locked : false,
        description: prev && prev.locked ? prev.description
          : 'Supply and Installation of ' + prod.type,
        details: prev && prev.locked ? prev.details : detailsFor(prod),
        cost: cents / 100
      });
    });

    if (p.showRollupLines) {
      // Named as the printed proposal names them, and the tax line carries its
      // rate so the client can check the arithmetic.
      var taxPct = U.n((t.rollup || {}).taxPct);
      var extra = [
        ['Delivery and Freight Charges', roll.freight],
        ['Tax' + (taxPct ? ' (' + U.qty(taxPct) + '%)' : ''), roll.tax]
      ];
      extra.forEach(function (e) {
        if (!e[1]) return;
        items.push({
          id: root.Store.uid('si'), no: items.length + 1, sourceType: null, locked: false,
          description: e[0], details: '', cost: Math.round(e[1] * 100) / 100
        });
      });
    }

    p.scopeItems = items;
    p.takeoffId = t.id;
    p.generatedAt = new Date().toISOString();
    p.proposalData.projectName = t.project.name || p.proposalData.projectName;
    p.proposalData.projectAddress = t.project.location || p.proposalData.projectAddress;
    // The bid is where the proposal number is entered, so it wins over the
    // takeoff's copy of it and over anything already on the document.
    p.proposalData.proposalNo = (bid && bid.proposalNo) ||
      t.project.proposalNo || p.proposalData.proposalNo;
    if (!p.proposalData.submittedDate) p.proposalData.submittedDate = U.today();
    if (t.project.bidDueDate) p.proposalData.approvalDeadline = t.project.bidDueDate;

    d.proposals[p.id] = p;
    if (bid) bid.proposalId = p.id;
    state.id = p.id;
    d.ui.lastProposalId = p.id;
    root.Store.save();
    root.App.switchTab('proposal');
    U.toast(isRegen ? 'Proposal refreshed from the takeoff.' : 'Proposal generated.', 'ok');
  }

  /* Splits an amount into n equal parts that still sum to it exactly.
     324.80 over 3 is 108.27 / 108.27 / 108.26, not 108.27 x 3 (which would
     overstate the bid by a cent). Handles negatives, so a negative roundoff
     distributes correctly too. */
  function splitEqually(amount, n) {
    if (!n || n <= 0) return [];
    var cents = Math.round(amount * 100);
    var base = Math.floor(cents / n);
    var remainder = cents - base * n;          // 0 .. n-1, always non-negative
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push((base + (i < remainder ? 1 : 0)) / 100);
    }
    return out;
  }

  /* ---- totals ---------------------------------------------------------- */

  function total(p) {
    return (p.scopeItems || []).reduce(function (s, i) { return s + U.n(i.cost); }, 0);
  }

  /* ---- rendering ------------------------------------------------------- */

  function render() {
    var host = U.$('section-proposal');
    if (!host || host.classList.contains('hidden')) return;
    var p = current();
    if (!p) { host.innerHTML = renderPicker(); return; }
    host.innerHTML =
      '<div class="grid grid-cols-1 xl:grid-cols-[440px_1fr] gap-6 no-print-grid">' +
        '<div class="no-print">' + renderEditor(p) + '</div>' +
        '<div>' + renderDocShell(p) + '</div>' +
      '</div>';
    ['pd-proposalData-submittedDate', 'pd-proposalData-approvalDeadline']
      .forEach(function (id) { U.wireDateField(id); });
    paintDoc();
  }

  function renderPicker() {
    var d = db();
    var list = Object.keys(d.proposals).map(function (k) { return d.proposals[k]; });
    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-8">' +
      '<h3 class="text-lg font-bold text-slate-800 mb-1">Proposal</h3>' +
      '<p class="text-sm text-slate-500 mb-6">Generate one from a takeoff, or start a blank document.</p>' +
      (list.length ? '<div class="space-y-2 mb-6">' + list.map(function (p) {
        return '<button onclick="Proposal.open(\'' + p.id + '\')" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 transition flex items-center justify-between">' +
          '<span class="text-sm font-semibold text-slate-800">' + U.esc(p.proposalData.projectName || 'Untitled') + '</span>' +
          '<span class="text-sm font-mono text-slate-600">' + U.currency(total(p)) + '</span></button>';
      }).join('') + '</div>' : '') +
      '<div class="flex gap-3">' +
        '<button onclick="Proposal.createBlank()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold"><i class="fas fa-plus mr-1.5"></i>Blank proposal</button>' +
        '<button onclick="Proposal.pickTemplateFile()" class="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-semibold"><i class="fas fa-folder-open mr-1.5"></i>Load template (.json)</button>' +
      '</div></div>';
  }

  /* A proposal is a snapshot of a takeoff, so it can silently fall behind the
     estimate it came from. Without this strip, "opens the generated proposal"
     quietly means "opens a stale one". */
  function isStale(p) {
    var t = p.takeoffId ? db().takeoffs[p.takeoffId] : null;
    if (!t || !p.generatedAt || !t.updatedAt) return false;
    return t.updatedAt > p.generatedAt;
  }

  function sourceBar(p) {
    var t = p.takeoffId ? db().takeoffs[p.takeoffId] : null;
    if (!t) {
      return '<div class="px-4 py-2 border-b border-slate-200 bg-slate-50 text-[11px] text-slate-400">' +
        'Not linked to a takeoff &mdash; scope items and prices are hand-entered.</div>';
    }
    var regen = '<button onclick="Proposal.generateFromTakeoff(\'' + t.id + '\')" ' +
      'class="px-2.5 py-1 rounded text-[11px] font-semibold whitespace-nowrap ';

    if (isStale(p)) {
      return '<div class="px-4 py-2.5 border-b border-amber-200 bg-amber-50 flex items-center gap-2">' +
        '<i class="fas fa-triangle-exclamation text-amber-500 text-xs"></i>' +
        '<span class="flex-1 text-[11px] text-amber-900 leading-snug">The takeoff has changed since this ' +
          'proposal was generated. Costs and linear feet below may be out of date.</span>' +
        regen + 'bg-amber-600 hover:bg-amber-500 text-white">Regenerate</button></div>';
    }
    return '<div class="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2">' +
      '<span class="flex-1 text-[11px] text-slate-500">' +
        (p.generatedAt ? 'Generated from the takeoff on ' + U.esc(U.date(p.generatedAt.slice(0, 10)))
                       : 'Linked to a takeoff.') + '</span>' +
      regen + 'bg-slate-100 hover:bg-slate-200 text-slate-700">Regenerate</button></div>';
  }

  function renderEditor(p) {
    var pd = p.proposalData, cd = p.companyData;
    var S = root.PROPOSAL_STYLES;

    function field(label, path, type, ph) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      return '<div><label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">' + label + '</label>' +
        '<input type="' + (type || 'text') + '" value="' + U.escAttr(val) + '" placeholder="' + (ph || '') + '" ' +
        'onchange="Proposal.set(\'' + path + '\',this.value)" ' +
        'class="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400"></div>';
    }
    /* MM-DD-YYYY text field rather than <input type="date">, whose display order
       follows the browser locale and cannot be set from the page. */
    function dateField(label, path) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      var id = 'pd-' + path.replace(/\./g, '-');
      return '<div><label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">' +
        label + ' <span class="text-slate-400 font-normal normal-case">(MM-DD-YYYY)</span></label>' +
        '<div class="relative">' +
          '<input type="text" id="' + id + '" value="' + U.esc(U.dateToInput(val)) + '" ' +
            'placeholder="MM-DD-YYYY" maxlength="10" inputmode="numeric" autocomplete="off" ' +
            'onchange="Proposal.setDate(\'' + path + '\',\'' + id + '\')" ' +
            'class="w-full px-2.5 py-1.5 pr-8 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">' +
          '<input type="date" id="' + id + '__picker" tabindex="-1" aria-hidden="true" class="absolute opacity-0 pointer-events-none w-0 h-0 right-8 bottom-0">' +
          '<button type="button" onclick="U.openDatePicker(\'' + id + '\')" tabindex="-1" title="Open calendar" ' +
            'class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-blue-600">' +
            '<i class="fas fa-calendar-alt text-xs"></i></button>' +
        '</div></div>';
    }
    function area(label, path, rows) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      return '<div><label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">' + label + '</label>' +
        '<textarea rows="' + (rows || 2) + '" onchange="Proposal.set(\'' + path + '\',this.value)" ' +
        'class="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400 resize-y">' + U.esc(val) + '</textarea></div>';
    }
    function rich(label, path) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      var id = 'rt-' + path.replace(/\./g, '-');
      return '<div><label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">' + label + '</label>' +
        toolbar(id) +
        '<div id="' + id + '" contenteditable="true" data-path="' + path + '" ' +
        'oninput="Proposal.richInput(this)" ' +
        'class="prose-mini w-full px-2.5 py-2 bg-white border border-slate-200 rounded-b-lg text-sm outline-none focus:border-blue-400 max-h-56 overflow-y-auto">' +
        U.sanitizeHTML(U.toHTMLList(val)) + '</div></div>';
    }

    var sections = {
      content: field('Proposal No.', 'proposalData.proposalNo') +
        dateField('Submitted Date', 'proposalData.submittedDate') +
        dateField('Approval Deadline', 'proposalData.approvalDeadline') +
        field('Project Name', 'proposalData.projectName') +
        field('Project Site Address', 'proposalData.projectAddress') +
        field('Proposal Type Slogan', 'proposalData.type') +
        area('Introductory Thank You Message', 'proposalData.description', 3) +
        area('Closing Acceptance Note', 'proposalData.acceptanceNote', 3),

      scope: renderScopeEditor(p),

      terms: rich('Terms &amp; Conditions', 'proposalData.terms') +
        rich('Payment Terms', 'proposalData.paymentTerms') +
        rich('Inclusions &amp; Clarifications', 'proposalData.inclusions'),

      company: field('Company Corporate Name', 'companyData.name') +
        area('Corporate Dispatch Office Address', 'companyData.address', 2) +
        field('Phone Number', 'companyData.phone') +
        field('Email Address', 'companyData.email') +
        field('Brand Subtitle / Slogan', 'companyData.brandSlogan') +
        '<div><label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Company Logo</label>' +
          '<div class="flex items-center gap-2">' +
            '<input type="file" accept="image/*" onchange="Proposal.pickLogo(this)" class="text-xs flex-1">' +
            (cd.logoType === 'custom' ? '<button onclick="Proposal.clearLogo()" class="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded">Clear</button>' : '') +
          '</div>' +
          (cd.logoType === 'custom' && cd.logoUrl ? '<img src="' + cd.logoUrl + '" class="mt-2 h-12 object-contain">' : '') +
        '</div>' +
        '<label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" ' +
          (p.frameLogo ? 'checked' : '') + ' onchange="Proposal.set(\'frameLogo\',this.checked)"> ' +
          'Frame logo in a white card <span class="text-slate-400 text-xs">(helps logos with white backgrounds on dark styles)</span></label>'
    };

    var tabs = [['content', 'Details'], ['scope', 'Scope Items'], ['terms', 'Terms'], ['company', 'Company']];

    return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden sticky top-4">' +
      '<div class="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">' +
        '<h3 class="text-sm font-bold text-slate-800">Bid Proposal Generator</h3>' +
        '<button onclick="Proposal.open(null)" class="text-xs text-slate-400 hover:text-slate-700" title="Choose another proposal"><i class="fas fa-exchange-alt"></i></button></div>' +

      sourceBar(p) +

      '<div class="px-4 py-3 border-b border-slate-200">' +
        '<label class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Style Template</label>' +
        '<select onchange="Proposal.set(\'selectedStyle\',Number(this.value))" class="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">' +
        Object.keys(S).map(function (k) {
          return '<option value="' + k + '"' + (Number(k) === p.selectedStyle ? ' selected' : '') + '>' +
            k + '. ' + U.esc(S[k].name) + (S[k].isDark ? ' (dark)' : '') + '</option>';
        }).join('') + '</select></div>' +

      '<div class="flex border-b border-slate-200 bg-slate-50 overflow-x-auto">' +
        tabs.map(function (t) {
          var on = state.editing === t[0];
          return '<button onclick="Proposal.setEditing(\'' + t[0] + '\')" class="px-4 py-2.5 text-xs font-semibold whitespace-nowrap ' +
            (on ? 'text-blue-700 border-b-2 border-blue-600 bg-white' : 'text-slate-500 hover:text-slate-800') + '">' + t[1] + '</button>';
        }).join('') + '</div>' +

      '<div class="p-4 space-y-3 max-h-[560px] overflow-y-auto">' + sections[state.editing] + '</div>' +

      '<div class="p-3 border-t border-slate-200 bg-slate-50 grid grid-cols-2 gap-2">' +
        '<button onclick="Proposal.print()" class="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold"><i class="fas fa-file-pdf mr-1"></i>Export PDF</button>' +
        '<button onclick="Proposal.exportTemplate()" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"><i class="fas fa-download mr-1"></i>Save .json</button>' +
        (p.takeoffId ? '<button onclick="Proposal.generateFromTakeoff(\'' + p.takeoffId + '\')" class="col-span-2 px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold"><i class="fas fa-sync mr-1"></i>Refresh from takeoff</button>' : '') +
      '</div></div>';
  }

  function toolbar(targetId) {
    function b(cmd, icon, title, arg) {
      return '<button type="button" onmousedown="event.preventDefault()" ' +
        'onclick="Proposal.exec(\'' + targetId + '\',\'' + cmd + '\'' + (arg ? ",'" + arg + "'" : '') + ')" ' +
        'title="' + title + '" class="px-2 py-1 hover:bg-slate-200 rounded text-slate-600 text-xs"><i class="fas ' + icon + '"></i></button>';
    }
    return '<div class="flex gap-0.5 bg-slate-100 border border-slate-200 border-b-0 rounded-t-lg px-1 py-1">' +
      b('bold', 'fa-bold', 'Bold') + b('italic', 'fa-italic', 'Italic') +
      b('underline', 'fa-underline', 'Underline') +
      '<span class="w-px bg-slate-300 mx-1"></span>' +
      b('insertUnorderedList', 'fa-list-ul', 'Bulleted list') +
      b('insertOrderedList', 'fa-list-ol', 'Numbered list') +
      '<span class="w-px bg-slate-300 mx-1"></span>' +
      b('outdent', 'fa-outdent', 'Outdent') + b('indent', 'fa-indent', 'Indent') +
      '</div>';
  }

  function renderScopeEditor(p) {
    return '<div class="space-y-2">' + p.scopeItems.map(function (s, i) {
      return '<div class="border border-slate-200 rounded-lg p-3 ' + (s.locked ? 'bg-amber-50/50 border-amber-200' : 'bg-slate-50/50') + '">' +
        '<div class="flex items-center gap-2 mb-2">' +
          '<span class="w-6 h-6 rounded bg-slate-200 text-slate-600 text-[10px] font-bold flex items-center justify-center">' + (i + 1) + '</span>' +
          '<input value="' + U.escAttr(s.description) + '" onchange="Proposal.setScope(' + i + ',\'description\',this.value)" ' +
            'class="flex-1 px-2 py-1 bg-white border border-slate-200 rounded text-sm font-semibold outline-none focus:border-blue-400">' +
          '<button onclick="Proposal.toggleLock(' + i + ')" title="' + (s.locked ? 'Unlock - regeneration will overwrite this wording' : 'Lock the wording so regenerating the proposal keeps it') + '" ' +
            'class="w-6 h-6 rounded text-xs ' + (s.locked ? 'text-amber-600' : 'text-slate-300 hover:text-slate-600') + '"><i class="fas fa-' + (s.locked ? 'lock' : 'lock-open') + '"></i></button>' +
          '<button onclick="Proposal.removeScope(' + i + ')" class="w-6 h-6 rounded text-slate-300 hover:text-red-600 text-xs"><i class="fas fa-times"></i></button>' +
        '</div>' +
        toolbar('sc-' + i) +
        '<div id="sc-' + i + '" contenteditable="true" data-scope="' + i + '" oninput="Proposal.scopeRichInput(this)" ' +
          'class="prose-mini px-2 py-2 bg-white border border-slate-200 rounded-b text-xs outline-none focus:border-blue-400 max-h-40 overflow-y-auto">' +
          U.sanitizeHTML(U.toHTMLList(s.details)) + '</div>' +
        '<div class="flex items-center gap-2 mt-2">' +
          '<span class="text-[10px] font-bold text-slate-500 uppercase">Cost</span>' +
          '<input type="number" step="any" value="' + (s.cost == null ? '' : s.cost) + '" onchange="Proposal.setScope(' + i + ',\'cost\',this.value)" ' +
            'class="w-32 px-2 py-1 bg-white border border-slate-200 rounded text-sm text-right font-mono outline-none focus:border-blue-400">' +
        '</div></div>';
    }).join('') +
      '<button onclick="Proposal.addScope()" class="w-full px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1"></i>Add scope item</button>' +
      '<label class="flex items-start gap-2 text-xs text-slate-600 pt-2"><input type="checkbox" class="mt-0.5" ' +
        (p.showRollupLines ? 'checked' : '') + ' onchange="Proposal.set(\'showRollupLines\',this.checked)"> ' +
        '<span>Show freight / tax / roundoff as separate lines' +
        '<span class="block text-[10px] text-slate-400">Untick to fold them into the product prices too. ' +
        'Miscellaneous is always folded in and never shown.</span></span></label>' +
      '<div class="flex items-center justify-between pt-3 mt-2 border-t-2 border-slate-800">' +
        '<span class="text-xs font-bold uppercase tracking-wider text-slate-700">Total Bid Price</span>' +
        '<span class="font-mono text-base font-bold text-slate-900">' + U.currency2(total(p)) + '</span></div>' +
      '</div>';
  }

  /* ---- the document ---------------------------------------------------- */

  function renderDocShell() {
    return '<div class="overflow-x-auto"><div id="proposalDoc" class="mx-auto shadow-xl"></div></div>';
  }

  /* The printed document, block by block, in the order it appears on paper.
     js/proposal.paginate.js deals these into letter-size pages and puts the
     running header and the page number on each one.

     Every block carries its own spacing as padding, never margin: two adjacent
     margins collapse into one, which would make a block's height depend on what
     preceded it and throw the measuring out at every page break. */
  function docBlocks(p, s) {
    var pd = p.proposalData, cd = p.companyData;
    var out = [];
    function add(html, extra) {
      out.push(Object.assign({ html: html }, extra || {}));
    }

    /* ---- letterhead: logo left, contact block right, in one outlined card */
    var logo = cd.logoType === 'custom' && cd.logoUrl
      ? '<img src="' + cd.logoUrl + '" alt="logo" class="h-12 object-contain">'
      : defaultLogo(s);

    add('<div class="pb-6"><div class="flex items-center justify-between gap-6 px-5 py-4 ' +
      'rounded-xl border ' + s.borderPrimary + ' ' + s.cardBg + '">' +
        (p.frameLogo ? '<div class="bg-white rounded-lg p-1.5 shrink-0">' + logo + '</div>'
                     : '<div class="shrink-0">' + logo + '</div>') +
        '<div class="text-right text-[10px] leading-relaxed ' + s.textSecondary + '">' +
          '<div class="text-[12px] font-bold ' + s.textPrimary + '">' + U.esc(cd.name) + '</div>' +
          U.esc(cd.address) + '<br>' +
          '<span class="font-semibold ' + s.textPrimary + '">' + U.esc(cd.phone) + '</span><br>' +
          '<span class="font-mono">' + U.esc(cd.email) + '</span>' +
        '</div>' +
      '</div></div>');

    /* ---- title, centred, ruled under the words only */
    add('<div class="text-center pb-5">' +
      '<h1 class="inline-block text-[30px] font-black tracking-[0.12em] pb-1 ' +
        'border-b-[3px] ' + s.titleColor + ' ' + s.borderPrimary + '">BID PROPOSAL</h1></div>');

    /* ---- what the proposal is for */
    if (pd.type) {
      add('<div class="pb-5"><div class="px-6 py-4 rounded-xl border ' + s.borderPrimary + ' ' +
        s.cardBg + ' text-center">' +
        '<div class="text-[15px] font-bold tracking-[0.06em] leading-relaxed ' + s.textPrimary + '">' +
          U.esc(pd.type).toUpperCase() + '</div></div></div>');
    }

    /* ---- the five identifying fields, label and value on one line */
    function meta(label, value) {
      return '<div class="py-1 text-[11px] leading-snug">' +
        '<span class="font-bold tracking-wider ' + s.textMuted + '">' + label + '</span> ' +
        '<span class="font-semibold ' + s.textPrimary + '">' + U.esc(value || '-') + '</span></div>';
    }
    add('<div class="pb-5"><div class="grid grid-cols-2 gap-x-8 px-5 py-3 rounded-xl border ' +
      s.borderPrimary + ' ' + s.cardBg + '">' +
        '<div>' + meta('PROPOSAL NO:', pd.proposalNo) +
          meta('SUBMITTED DATE:', U.date(pd.submittedDate)) +
          meta('APPROVAL DEADLINE:', U.date(pd.approvalDeadline)) + '</div>' +
        '<div>' + meta('PROJECT NAME:', pd.projectName) +
          meta('ADDRESS:', pd.projectAddress) + '</div>' +
      '</div></div>');

    if (pd.description) {
      add('<div class="pb-5 px-1 text-[11.5px] leading-relaxed ' + s.textSecondary + '">' +
        U.esc(pd.description) + '</div>');
    }

    /* ---- scope: ruled entries, not a table. Title left, price right. */
    add(sectionHead(s, 'SCOPE OF WORK AND BIDDING PRICE'), { keepWithNext: true });

    if (!p.scopeItems.length) {
      add('<div class="py-8 text-center text-xs ' + s.textMuted + '">No scope items yet.</div>');
    }
    p.scopeItems.forEach(function (item) {
      var details = item.details
        ? '<div class="prose-doc text-[10.5px] pt-1.5 pl-1 ' + s.textSecondary + '">' +
          U.sanitizeHTML(U.toHTMLList(item.details)) + '</div>'
        : '';
      add('<div class="scope-row py-3 border-b ' + s.borderPrimary + '">' +
        '<div class="flex items-baseline justify-between gap-6">' +
          '<div class="text-[12px] font-bold ' + s.textPrimary + '">' + U.esc(item.description) + '</div>' +
          '<div class="text-[12px] font-bold font-mono whitespace-nowrap ' + s.textPrimary + '">' +
            U.currency2(item.cost) + '</div>' +
        '</div>' + details + '</div>',
        // A scope entry is one thought: the price and the specification it buys
        // must not end up on different sheets.
        { splitAt: null });
    });

    add('<div class="pt-5 pb-2"><div class="flex items-center justify-between gap-6 px-6 py-4 ' +
      'rounded-xl ' + s.totalBg + '">' +
        '<span class="text-[13px] font-black tracking-[0.15em] ' + s.textAccent + '">TOTAL BID PRICE</span>' +
        '<span class="text-[22px] font-black font-mono ' + s.textAccent + '">' +
          U.currency2(total(p)) + '</span></div></div>');

    /* ---- the contractual half */
    if (pd.terms || pd.inclusions || pd.paymentTerms) {
      add('<div class="pt-8 pb-6 flex items-center gap-4">' +
        '<span class="flex-1 border-t border-dashed ' + s.borderPrimary + '"></span>' +
        '<span class="text-[9px] font-bold tracking-[0.25em] ' + s.textMuted + '">CONTRACT DETAILS &amp; TERMS</span>' +
        '<span class="flex-1 border-t border-dashed ' + s.borderPrimary + '"></span>' +
      '</div>', { keepWithNext: true });
    }

    // Order follows the printed proposal: what is agreed, then what is
    // included, then how it is paid for.
    [['TERMS &amp; CONDITIONS', pd.terms],
     ['INCLUSIONS &amp; CLARIFICATIONS', pd.inclusions],
     ['PAYMENT TERMS', pd.paymentTerms]].forEach(function (sec) {
      if (!sec[1]) return;
      add(sectionHead(s, sec[0]), { keepWithNext: true });
      add('<div class="prose-doc text-[10.5px] pb-4 ' + s.textSecondary + '">' +
        U.sanitizeHTML(U.toHTMLList(sec[1])) + '</div>', { splitAt: 'li' });
    });

    if (pd.acceptanceNote) {
      add('<div class="pt-4 pb-2 px-1 text-[11px] font-semibold leading-relaxed ' +
        s.textPrimary + '">' + U.esc(pd.acceptanceNote) + '</div>');
    }

    add('<div class="signature-block pt-6">' +
      '<div class="border-t ' + s.borderPrimary + ' pt-12">' +
        '<div class="grid grid-cols-3 gap-8 text-center">' +
          ['SIGNATURE', 'NAME', 'DATE'].map(function (l) {
            return '<div class="text-[12px] font-bold tracking-wider ' + s.textPrimary + '">' + l + '</div>';
          }).join('') +
        '</div>' +
      '</div></div>');

    return out;
  }

  function sectionHead(s, title) {
    return '<div class="pt-2 pb-3">' +
      '<h2 class="text-[13px] font-extrabold tracking-[0.08em] uppercase pb-2 ' +
        s.sectionHeaderColor + '">' + title + '</h2>' +
      '<div class="border-t ' + s.borderPrimary + '"></div></div>';
  }

  /* "August 24, 2026" - the long form the printed proposal is dated with. */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function longDate(iso) {
    if (!iso) return '';
    var d = U.parseDate(iso);
    if (!d || isNaN(d.getTime())) return '';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function paintDoc() {
    var p = current();
    var host = U.$('proposalDoc');
    if (!p || !host) return;
    var s = root.PROPOSAL_STYLES[p.selectedStyle] || root.PROPOSAL_STYLES[1];
    var pd = p.proposalData, cd = p.companyData;

    host.className = 'mx-auto ' + s.documentBg;
    host.style.width = '8.5in';
    host.style.minHeight = '';

    /* Repeated at the top of every page but the first, whose letterhead does
       the same job. Names the company and which proposal this is - what a
       loose sheet on somebody's desk needs to say. */
    function header() {
      return '<div class="flex items-start justify-between gap-6 text-[8px] ' +
        'font-semibold tracking-[0.12em] uppercase leading-snug ' + s.textMuted + '">' +
        '<span class="max-w-[45%]">' + U.esc(cd.name) + '</span>' +
        '<span class="max-w-[50%] text-right">BID PROPOSAL: ' +
          U.esc(pd.projectName || '') + '</span></div>';
    }

    function footer(no) {
      return '<div class="flex items-center justify-between text-[8px] ' + s.textMuted + '">' +
        '<span>' + U.esc(longDate(pd.submittedDate)) + '</span>' +
        '<span>Page ' + no + '</span></div>';
    }

    host.innerHTML = root.Paginate.flow({
      host: host,
      blocks: docBlocks(p, s),
      pageClass: 'doc-page ' + s.documentBg,
      header: header,
      footer: footer
    });

    /* Web fonts land after the first paint, and every height measured against a
       fallback face is a shade wrong - an error that accumulates down the page
       until a break lands in the wrong place. Measure once more when they are
       actually there. */
    if (!fontsSettled && document.fonts && document.fonts.ready) {
      fontsSettled = true;
      document.fonts.ready.then(function () { paintDoc(); });
    }
  }

  var fontsSettled = false;

  /* Wordmark used when no custom logo is uploaded, matching the v3 treatment. */
  function defaultLogo(s) {
    return '<div class="flex items-baseline"><span class="text-2xl font-black ' +
      (s.isDark ? 'text-white' : 'text-slate-900') + '">Di</span>' +
      '<span class="text-2xl font-black ' + s.textAccent + '">Verse</span></div>';
  }

  /* ---- editing --------------------------------------------------------- */

  function setPath(path, value) {
    var p = current();
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (o, k) { return o[k]; }, p);
    target[last] = value;
    if (path.indexOf('companyData.') === 0) db().company[last] = value;
    save();
  }

  /* ---- template file I/O (v3-compatible) ------------------------------- */

  function exportTemplate() {
    var p = current();
    var name = prompt('Filename for the proposal template:',
      (p.proposalData.projectName || 'proposal').replace(/[^\w\- ]+/g, '') + '.json');
    if (name == null) return;
    if (!/\.json$/i.test(name)) name += '.json';
    root.Store.downloadJSON({
      version: '1.0.0',
      selectedStyle: p.selectedStyle,
      frameLogo: p.frameLogo,
      hasManuallyToggledLogoFrame: p.hasManuallyToggledLogoFrame,
      proposalData: p.proposalData,
      companyData: p.companyData,
      scopeItems: p.scopeItems.map(function (s, i) {
        return { id: s.id, no: i + 1, description: s.description, details: s.details, cost: U.n(s.cost) };
      })
    }, name);
  }

  function loadTemplate(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var q = JSON.parse(e.target.result);
        if (!q || !q.proposalData || !q.companyData || !Array.isArray(q.scopeItems)) {
          throw new Error('Missing required proposal sections (proposalData, companyData, or scopeItems).');
        }
        var p = current() || blank(null);
        if (typeof q.selectedStyle === 'number' && q.selectedStyle >= 1 && q.selectedStyle <= 9) {
          p.selectedStyle = q.selectedStyle;
        }
        if (typeof q.frameLogo === 'boolean') p.frameLogo = q.frameLogo;
        if (typeof q.hasManuallyToggledLogoFrame === 'boolean') p.hasManuallyToggledLogoFrame = q.hasManuallyToggledLogoFrame;
        ['proposalNo', 'submittedDate', 'approvalDeadline', 'projectName', 'projectAddress',
          'description', 'acceptanceNote', 'type'].forEach(function (k) {
            p.proposalData[k] = q.proposalData[k] || '';
          });
        ['terms', 'paymentTerms', 'inclusions'].forEach(function (k) {
          p.proposalData[k] = U.toHTMLList(q.proposalData[k]);
        });
        ['name', 'address', 'phone', 'email', 'logoType', 'logoUrl', 'brandSlogan'].forEach(function (k) {
          p.companyData[k] = q.companyData[k] || (k === 'logoType' ? 'default' : '');
        });
        p.scopeItems = q.scopeItems.map(function (s, i) {
          return {
            id: s.id || root.Store.uid('si'),
            no: typeof s.no === 'number' ? s.no : i + 1,
            description: s.description || '',
            details: U.toHTMLList(s.details),
            cost: typeof s.cost === 'number' ? s.cost : parseFloat(s.cost) || 0,
            sourceType: null, locked: false
          };
        });
        db().proposals[p.id] = p;
        state.id = p.id;
        save();
        U.toast('Proposal template loaded.', 'ok');
      } catch (err) {
        U.toast('Could not load template: ' + err.message, 'err');
      }
    };
    reader.readAsText(file);
  }

  root.Proposal = {
    render: render,
    generateFromTakeoff: generateFromTakeoff,
    isStale: isStale,
    total: total,
    open: function (id) {
      state.id = id;
      db().ui.lastProposalId = id;
      // Called both from the Bids row (needs the navigation) and from boot,
      // where App.switchTab runs again straight afterwards anyway.
      if (root.App) root.App.switchTab('proposal');
      save();
    },
    currentId: function () { return state.id; },
    createBlank: function () {
      var p = blank(null);
      db().proposals[p.id] = p;
      state.id = p.id;
      save();
    },
    setEditing: function (t) { state.editing = t; render(); },
    set: setPath,

    /* Stores ISO but keeps the box reading MM-DD-YYYY; leaves the old value in
       place and flags the field when the text is not a real date. */
    setDate: function (path, elId) {
      var el = U.$(elId);
      var typed = el.value.trim();
      var iso = U.inputToDate(typed);
      if (typed && iso === null) {
        el.classList.add('border-red-400', 'bg-red-50');
        U.toast('Enter the date as MM-DD-YYYY.', 'err');
        return;
      }
      el.classList.remove('border-red-400', 'bg-red-50');
      el.value = U.dateToInput(iso);
      setPath(path, iso || '');
    },

    richInput: function (el) {
      var path = el.getAttribute('data-path');
      var keys = path.split('.');
      var last = keys.pop();
      var target = keys.reduce(function (o, k) { return o[k]; }, current());
      target[last] = U.sanitizeHTML(el.innerHTML);
      root.Store.save();
      paintDoc();
    },
    scopeRichInput: function (el) {
      var i = Number(el.getAttribute('data-scope'));
      current().scopeItems[i].details = U.sanitizeHTML(el.innerHTML);
      root.Store.save();
      paintDoc();
    },
    exec: function (targetId, cmd, arg) {
      var el = U.$(targetId);
      if (!el) return;
      el.focus();
      document.execCommand(cmd, false, arg || null);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },

    setScope: function (i, field, value) {
      var s = current().scopeItems[i];
      s[field] = field === 'cost' ? (value === '' ? 0 : Number(value)) : value;
      if (field === 'cost') { root.Store.save(); paintDoc(); }
      else { root.Store.save(); paintDoc(); }
    },
    addScope: function () {
      current().scopeItems.push({
        id: root.Store.uid('si'), no: current().scopeItems.length + 1,
        description: 'New scope item', details: '', cost: 0, sourceType: null, locked: false
      });
      save();
    },
    removeScope: function (i) { current().scopeItems.splice(i, 1); save(); },
    toggleLock: function (i) {
      var s = current().scopeItems[i];
      s.locked = !s.locked;
      save();
    },

    pickLogo: function (input) {
      var f = input.files && input.files[0];
      if (!f) return;
      if (f.size > 1024 * 1024) {
        U.toast('That image is over 1 MB and may not fit in browser storage. Try a smaller file.', 'warn');
      }
      var r = new FileReader();
      r.onloadend = function () {
        var p = current();
        p.companyData.logoType = 'custom';
        p.companyData.logoUrl = r.result;
        db().company.logoType = 'custom';
        db().company.logoUrl = r.result;
        save();
      };
      r.readAsDataURL(f);
    },
    clearLogo: function () {
      var p = current();
      p.companyData.logoType = 'default';
      p.companyData.logoUrl = '';
      db().company.logoType = 'default';
      db().company.logoUrl = '';
      save();
    },

    exportTemplate: exportTemplate,
    loadTemplate: loadTemplate,
    pickTemplateFile: function () { U.$('proposalTemplateInput').click(); },

    print: function () {
      document.body.classList.add('printing-proposal');
      root.print();
      setTimeout(function () { document.body.classList.remove('printing-proposal'); }, 500);
    }
  };

  /* Ctrl+P on the Proposal tab should behave like the Export PDF button rather
     than dumping the whole app onto paper. beforeprint fires for the keyboard
     shortcut and the browser menu alike. */
  root.addEventListener('beforeprint', function () {
    var sec = U.$('section-proposal');
    if (sec && !sec.classList.contains('hidden') && current()) {
      document.body.classList.add('printing-proposal');
    }
  });
  root.addEventListener('afterprint', function () {
    document.body.classList.remove('printing-proposal');
  });
})(window);
