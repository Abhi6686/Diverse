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

  /* ---- writing, and getting it into the bid's history --------------------- */

  /* A proposal is where the number the client actually sees is decided, and
     until now none of it reached the log - the bid recorded that its price
     moved, and nothing recorded that the document quoting it had been rewritten
     the same afternoon.
   *
   * SAME CACHED-DIGEST ARRANGEMENT THE TAKEOFF USES: the mutators have already
   * written by the time they reach here, so the "before" is the digest left
   * over from the last write. Keyed by proposal id, or switching documents
   * would diff one against another.
   *
   * commit() rather than save() is what the callers below reach for, because
   * three of them deliberately do NOT re-render: they are contenteditable
   * handlers, and rebuilding the DOM under a cursor loses the cursor. They
   * repaint the preview instead. The logging has to happen on all of them
   * either way, which is what this separates out.
   */
  var known = { id: null, digest: null };

  function remember(p) {
    known = p
      ? { id: p.id, digest: root.History.snapshotDoc(p, 'proposal') }
      : { id: null, digest: null };
  }

  function bidOf(p) {
    if (!p || p.bidId == null) return null;
    return db().bids.filter(function (b) { return b.id === p.bidId; })[0] || null;
  }

  function commit() {
    var p = current();
    var bid = bidOf(p);
    if (p && bid && known.id === p.id && known.digest) {
      root.History.recordDoc(bid, 'proposal',
        root.History.diffDoc(known.digest, p, 'proposal'));
    }
    if (p) remember(p);
    root.Store.save();
  }

  function save() { commit(); render(); }

  /* ---- what the logo sits on -------------------------------------------- */

  /* A logo is drawn for one background and put on another. One with a white
     background needs a white card under it on a dark style, or it prints as a
     white rectangle in the corner; one drawn in white on transparent needs a
     dark card on a light style, or it disappears entirely. So there are three
     answers and not two.

     It lives in companyData because it is a property of the logo, which means a
     new proposal inherits it from the shop's company record for free - see
     blank(), which copies db().company wholesale.

     The old field was a boolean, `frameLogo` on the proposal itself. It is still
     read here and still written by exportTemplate, so a document saved before
     this - or by the v3 app these templates are shared with - opens with its
     white card exactly as it did. */
  var LOGO_FRAMES = {
    none:  { label: 'None',  hint: 'The logo sits directly on the document',
             swatch: 'bg-transparent border-dashed', card: '' },
    white: { label: 'White', hint: 'For a logo drawn on a white background',
             swatch: 'bg-white', card: 'bg-white' },
    black: { label: 'Black', hint: 'For a logo drawn in white or on a dark background',
             swatch: 'bg-slate-950', card: 'bg-slate-950 ring-1 ring-white/10' }
  };

  function frameOf(p) {
    if (!p) return 'none';
    var v = p.companyData && p.companyData.logoFrame;
    if (LOGO_FRAMES[v]) return v;
    // Nothing chosen: fall back to the boolean this replaced.
    return p.frameLogo ? 'white' : 'none';
  }

  /* HOW LONG A PRICE IS GOOD FOR.

     The office quotes a fortnight, and it was being counted on a calendar and
     typed - so it was sometimes thirteen days, sometimes sixteen, and sometimes
     the last proposal's date left on the document. It follows the submitted
     date now: two weeks after whatever that says, worked out by U.addDays so
     month ends are the calendar's problem.

     Automatic is not the same as fixed. A deadline somebody has set by hand is
     never overwritten - see setSubmittedDate. */
  var APPROVAL_DAYS = 14;

  function blank(bid) {
    return {
      id: root.Store.uid('pro'),
      takeoffId: null,
      bidId: bid ? bid.id : null,
      version: '1.0.0',
      // 13 Lancaster: the reproduction of the PDF the shop actually sends out,
      // so a new proposal comes off the printer looking like the last one did
      // without anybody having to remember to pick it. Documents already saved
      // keep whichever style they were written under.
      selectedStyle: 13,
      frameLogo: true,
      hasManuallyToggledLogoFrame: false,
      showRollupLines: true,
      proposalData: Object.assign({
        proposalNo: '', submittedDate: U.today(),
        approvalDeadline: U.addDays(U.today(), APPROVAL_DAYS),
        projectName: bid ? bid.project : '',
        projectAddress: bid ? (bid.location || '') : ''
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
    /* The bid's Location wins: it is the field the office actually maintains,
       and the takeoff's copy was seeded from it. Falling back the other way
       round keeps a takeoff written before the bid carried an address. */
    p.proposalData.projectAddress = (bid && bid.location) ||
      t.project.location || p.proposalData.projectAddress;
    // The bid is where the proposal number is entered, so it wins over the
    // takeoff's copy of it and over anything already on the document.
    p.proposalData.proposalNo = (bid && bid.proposalNo) ||
      t.project.proposalNo || p.proposalData.proposalNo;
    if (!p.proposalData.submittedDate) p.proposalData.submittedDate = U.today();
    /* Two weeks from submission, not the bid's due date - which is when the
       client wanted the price, not how long the price stands. The old rule put
       a deadline on the document that had usually already passed by the time it
       was sent. Anything set by hand still survives a refresh. */
    if (!p.proposalData.approvalDeadline) {
      p.proposalData.approvalDeadline =
        U.addDays(p.proposalData.submittedDate, APPROVAL_DAYS);
    }

    d.proposals[p.id] = p;
    if (bid) bid.proposalId = p.id;
    state.id = p.id;
    d.ui.lastProposalId = p.id;
    /* Generating is not an edit to diff - the document either did not exist or
       has just been rebuilt wholesale from the takeoff - so it is recorded as
       the event it is. The digest is reset to what was generated, so the first
       hand edit afterwards reads as one change rather than as the whole
       document appearing from nothing. */
    if (bid) root.History.recordDocEvent(bid, 'proposal', isRegen ? 'regenerated' : 'created');
    remember(p);
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
    return '<div class="bg-surface rounded-xl shadow-sm border border-line p-8">' +
      '<h3 class="text-lg font-bold text-ink-strong mb-1">Proposal</h3>' +
      '<p class="text-sm text-muted mb-6">Generate one from a takeoff, or start a blank document.</p>' +
      (list.length ? '<div class="space-y-2 mb-6">' + list.map(function (p) {
        return '<button onclick="Proposal.open(\'' + p.id + '\')" class="w-full text-left px-4 py-3 rounded-lg border border-line hover:border-brand hover:bg-brand-soft/40 transition flex items-center justify-between">' +
          '<span class="text-sm font-semibold text-ink-strong">' + U.esc(p.proposalData.projectName || 'Untitled') + '</span>' +
          '<span class="text-sm font-mono text-muted">' + U.currency(total(p)) + '</span></button>';
      }).join('') + '</div>' : '') +
      '<div class="flex gap-3">' +
        '<button onclick="Proposal.createBlank()" class="px-4 py-2.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold"><i class="fas fa-plus mr-1.5"></i>Blank proposal</button>' +
        '<button onclick="Proposal.pickTemplateFile()" class="px-4 py-2.5 bg-neutral-soft hover:bg-line text-ink rounded-lg text-sm font-semibold"><i class="fas fa-folder-open mr-1.5"></i>Load template (.json)</button>' +
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
      return '<div class="px-4 py-2 border-b border-line bg-raised text-[11px] text-faint">' +
        'Not linked to a takeoff &mdash; scope items and prices are hand-entered.</div>';
    }
    var regen = '<button onclick="Proposal.generateFromTakeoff(\'' + t.id + '\')" ' +
      'class="px-2.5 py-1 rounded text-[11px] font-semibold whitespace-nowrap ';

    if (isStale(p)) {
      return '<div class="px-4 py-2.5 border-b border-warn/40 bg-warn-soft flex items-center gap-2">' +
        '<i class="fas fa-triangle-exclamation text-warn text-xs"></i>' +
        '<span class="flex-1 text-[11px] text-warn-ink leading-snug">The takeoff has changed since this ' +
          'proposal was generated. Costs and linear feet below may be out of date.</span>' +
        regen + 'bg-warn hover:bg-warn-hover text-white">Regenerate</button></div>';
    }
    return '<div class="px-4 py-2 border-b border-line bg-raised flex items-center gap-2">' +
      '<span class="flex-1 text-[11px] text-muted">' +
        (p.generatedAt ? 'Generated from the takeoff on ' + U.esc(U.stamp(p.generatedAt))
                       : 'Linked to a takeoff.') + '</span>' +
      regen + 'bg-neutral-soft hover:bg-line text-ink">Regenerate</button></div>';
  }

  /* Three swatches rather than a checkbox, because the answer is which colour
     and not whether. Each says what it is for: the choice depends on how the
     logo file itself was drawn, which is not something you can see from the
     picture on a white panel. */
  function logoFrameControl(p) {
    var on = frameOf(p);
    return '<div>' +
      '<label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">' +
        'Background behind the logo</label>' +
      '<div class="flex items-center gap-1.5">' +
        Object.keys(LOGO_FRAMES).map(function (key) {
          var f = LOGO_FRAMES[key];
          return '<button onclick="Proposal.setLogoFrame(\'' + key + '\')" ' +
            'title="' + U.escAttr(f.hint) + '" ' +
            'class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs transition ' +
            (on === key ? 'border-brand bg-brand-soft text-brand-ink font-semibold'
                        : 'border-line text-muted hover:border-line-strong') + '">' +
            '<span class="w-4 h-4 rounded border border-line-strong shrink-0 ' + f.swatch + '"></span>' +
            f.label + '</button>';
        }).join('') +
      '</div>' +
      '<p class="text-[10px] text-faint mt-1">' + U.esc(LOGO_FRAMES[on].hint) + '. ' +
        'Kept with the company details, so new proposals start here.</p>' +
    '</div>';
  }

  function renderEditor(p) {
    var pd = p.proposalData, cd = p.companyData;
    var S = root.PROPOSAL_STYLES;

    function field(label, path, type, ph) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      return '<div><label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">' + label + '</label>' +
        '<input type="' + (type || 'text') + '" value="' + U.escAttr(val) + '" placeholder="' + (ph || '') + '" ' +
        'onchange="Proposal.set(\'' + path + '\',this.value)" ' +
        'class="w-full px-2.5 py-1.5 bg-raised border border-line rounded-lg text-sm outline-none focus:border-brand"></div>';
    }
    /* MM-DD-YYYY text field rather than <input type="date">, whose display order
       follows the browser locale and cannot be set from the page. */
    function dateField(label, path, hint) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      var id = 'pd-' + path.replace(/\./g, '-');
      // U.dateFieldHTML rather than a second copy of it. This was a hand-rolled
      // duplicate of the same text-box-plus-calendar pair, which meant two
      // places to fix when the calendar behind it was replaced.
      return '<div><label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">' +
        label + ' <span class="text-faint font-normal normal-case">(MM-DD-YYYY)</span></label>' +
        U.dateFieldHTML(id, val,
          'w-full px-2.5 py-1.5 bg-raised border border-line rounded-lg text-sm ' +
          'outline-none focus:border-brand',
          'Proposal.setDate(&quot;' + path + '&quot;,&quot;' + id + '&quot;)') +
        // A field that fills itself in has to say so, or the next person to
        // change the submitted date is surprised by the box below it moving.
        (hint ? '<p class="text-[10px] text-faint mt-1">' + hint + '</p>' : '') +
      '</div>';
    }
    function area(label, path, rows) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      return '<div><label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">' + label + '</label>' +
        '<textarea rows="' + (rows || 2) + '" onchange="Proposal.set(\'' + path + '\',this.value)" ' +
        'class="w-full px-2.5 py-1.5 bg-raised border border-line rounded-lg text-sm outline-none focus:border-brand resize-y">' + U.esc(val) + '</textarea></div>';
    }
    function rich(label, path) {
      var val = path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, p);
      var id = 'rt-' + path.replace(/\./g, '-');
      return '<div><label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">' + label + '</label>' +
        toolbar(id) +
        '<div id="' + id + '" contenteditable="true" data-path="' + path + '" ' +
        'oninput="Proposal.richInput(this)" ' +
        'class="prose-mini w-full px-2.5 py-2 bg-surface border border-line rounded-b-lg text-sm outline-none focus:border-brand max-h-56 overflow-y-auto">' +
        U.sanitizeHTML(U.toHTMLList(val)) + '</div></div>';
    }

    var sections = {
      content: field('Proposal No.', 'proposalData.proposalNo') +
        dateField('Submitted Date', 'proposalData.submittedDate') +
        dateField('Approval Deadline', 'proposalData.approvalDeadline',
          'Two weeks after the submitted date. Set your own and it stays put.') +
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
        '<div><label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Company Logo</label>' +
          '<div class="flex items-center gap-2">' +
            '<input type="file" accept="image/*" onchange="Proposal.pickLogo(this)" class="text-xs flex-1">' +
            (cd.logoType === 'custom' ? '<button onclick="Proposal.clearLogo()" class="px-2 py-1 text-xs text-danger hover:bg-danger-soft rounded">Clear</button>' : '') +
          '</div>' +
          (cd.logoType === 'custom' && cd.logoUrl ? '<img src="' + cd.logoUrl + '" class="mt-2 h-12 object-contain">' : '') +
        '</div>' +
        logoFrameControl(p)
    };

    var tabs = [['content', 'Details'], ['scope', 'Scope Items'], ['terms', 'Terms'], ['company', 'Company']];

    return '<div class="bg-surface rounded-xl shadow-sm border border-line overflow-hidden sticky top-4">' +
      '<div class="px-4 py-3 border-b border-line bg-raised flex items-center justify-between">' +
        '<h3 class="text-sm font-bold text-ink-strong">Bid Proposal Generator</h3>' +
        '<button onclick="Proposal.open(null)" class="text-xs text-faint hover:text-ink" title="Choose another proposal"><i class="fas fa-exchange-alt"></i></button></div>' +

      sourceBar(p) +

      '<div class="px-4 py-3 border-b border-line">' +
        '<label class="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Style Template</label>' +
        '<select onchange="Proposal.set(\'selectedStyle\',Number(this.value))" class="w-full px-2.5 py-1.5 bg-raised border border-line rounded-lg text-sm outline-none focus:border-brand">' +
        Object.keys(S).map(function (k) {
          return '<option value="' + k + '"' + (Number(k) === p.selectedStyle ? ' selected' : '') + '>' +
            k + '. ' + U.esc(S[k].name) + (S[k].isDark ? ' (dark)' : '') + '</option>';
        }).join('') + '</select></div>' +

      '<div class="flex border-b border-line bg-raised overflow-x-auto">' +
        tabs.map(function (t) {
          var on = state.editing === t[0];
          return '<button onclick="Proposal.setEditing(\'' + t[0] + '\')" class="px-4 py-2.5 text-xs font-semibold whitespace-nowrap ' +
            (on ? 'text-brand-ink border-b-2 border-brand bg-surface' : 'text-muted hover:text-ink-strong') + '">' + t[1] + '</button>';
        }).join('') + '</div>' +

      '<div class="p-4 space-y-3 max-h-[560px] overflow-y-auto">' + sections[state.editing] + '</div>' +

      '<div class="p-3 border-t border-line bg-raised grid grid-cols-2 gap-2">' +
        '<button onclick="Proposal.print()" class="px-3 py-2 bg-chrome hover:bg-chrome-soft text-white rounded-lg text-xs font-semibold"><i class="fas fa-file-pdf mr-1"></i>Export PDF</button>' +
        '<button onclick="Proposal.exportTemplate()" class="px-3 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold"><i class="fas fa-download mr-1"></i>Save .json</button>' +
        (p.takeoffId ? '<button onclick="Proposal.generateFromTakeoff(\'' + p.takeoffId + '\')" class="col-span-2 px-3 py-2 bg-brand-soft hover:bg-brand-soft/60 text-brand-ink rounded-lg text-xs font-semibold"><i class="fas fa-sync mr-1"></i>Refresh from takeoff</button>' : '') +
      '</div></div>';
  }

  function toolbar(targetId) {
    function b(cmd, icon, title, arg) {
      return '<button type="button" onmousedown="event.preventDefault()" ' +
        'onclick="Proposal.exec(\'' + targetId + '\',\'' + cmd + '\'' + (arg ? ",'" + arg + "'" : '') + ')" ' +
        'title="' + title + '" class="px-2 py-1 hover:bg-line rounded text-muted text-xs"><i class="fas ' + icon + '"></i></button>';
    }
    return '<div class="flex gap-0.5 bg-neutral-soft border border-line border-b-0 rounded-t-lg px-1 py-1">' +
      b('bold', 'fa-bold', 'Bold') + b('italic', 'fa-italic', 'Italic') +
      b('underline', 'fa-underline', 'Underline') +
      '<span class="w-px bg-line-strong mx-1"></span>' +
      b('insertUnorderedList', 'fa-list-ul', 'Bulleted list') +
      b('insertOrderedList', 'fa-list-ol', 'Numbered list') +
      '<span class="w-px bg-line-strong mx-1"></span>' +
      b('outdent', 'fa-outdent', 'Outdent') + b('indent', 'fa-indent', 'Indent') +
      '</div>';
  }

  function renderScopeEditor(p) {
    return '<div class="space-y-2">' + p.scopeItems.map(function (s, i) {
      return '<div class="border border-line rounded-lg p-3 ' + (s.locked ? 'bg-warn-soft/40 border-warn/40' : 'bg-raised/50') + '">' +
        '<div class="flex items-center gap-2 mb-2">' +
          '<span class="w-6 h-6 rounded bg-line text-muted text-[10px] font-bold flex items-center justify-center">' + (i + 1) + '</span>' +
          '<input value="' + U.escAttr(s.description) + '" onchange="Proposal.setScope(' + i + ',\'description\',this.value)" ' +
            'class="flex-1 px-2 py-1 bg-surface border border-line rounded text-sm font-semibold outline-none focus:border-brand">' +
          '<button onclick="Proposal.toggleLock(' + i + ')" title="' + (s.locked ? 'Unlock - regeneration will overwrite this wording' : 'Lock the wording so regenerating the proposal keeps it') + '" ' +
            'class="w-6 h-6 rounded text-xs ' + (s.locked ? 'text-warn' : 'text-faint hover:text-muted') + '"><i class="fas fa-' + (s.locked ? 'lock' : 'lock-open') + '"></i></button>' +
          '<button onclick="Proposal.removeScope(' + i + ')" class="w-6 h-6 rounded text-faint hover:text-danger text-xs"><i class="fas fa-times"></i></button>' +
        '</div>' +
        toolbar('sc-' + i) +
        '<div id="sc-' + i + '" contenteditable="true" data-scope="' + i + '" oninput="Proposal.scopeRichInput(this)" ' +
          'class="prose-mini px-2 py-2 bg-surface border border-line rounded-b text-xs outline-none focus:border-brand max-h-40 overflow-y-auto">' +
          U.sanitizeHTML(U.toHTMLList(s.details)) + '</div>' +
        '<div class="flex items-center gap-2 mt-2">' +
          '<span class="text-[10px] font-bold text-muted uppercase">Cost</span>' +
          '<input type="number" step="any" value="' + (s.cost == null ? '' : s.cost) + '" onchange="Proposal.setScope(' + i + ',\'cost\',this.value)" ' +
            'class="w-32 px-2 py-1 bg-surface border border-line rounded text-sm text-right font-mono outline-none focus:border-brand">' +
        '</div></div>';
    }).join('') +
      '<button onclick="Proposal.addScope()" class="w-full px-3 py-2 bg-neutral-soft hover:bg-line text-ink rounded-lg text-xs font-semibold"><i class="fas fa-plus mr-1"></i>Add scope item</button>' +
      '<label class="flex items-start gap-2 text-xs text-muted pt-2"><input type="checkbox" class="mt-0.5" ' +
        (p.showRollupLines ? 'checked' : '') + ' onchange="Proposal.set(\'showRollupLines\',this.checked)"> ' +
        '<span>Show freight / tax / roundoff as separate lines' +
        '<span class="block text-[10px] text-faint">Untick to fold them into the product prices too. ' +
        'Miscellaneous is always folded in and never shown.</span></span></label>' +
      '<div class="flex items-center justify-between pt-3 mt-2 border-t-2 border-line-strong">' +
        '<span class="text-xs font-bold uppercase tracking-wider text-ink">Total Bid Price</span>' +
        '<span class="font-mono text-base font-bold text-ink-strong">' + U.currency2(total(p)) + '</span></div>' +
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

    add('<div class="doc-letterhead pb-6"><div class="flex items-center justify-between gap-6 px-5 py-4 ' +
      'rounded-xl border ' + s.borderPrimary + ' ' + s.cardBg + '">' +
        (function () {
          var card = LOGO_FRAMES[frameOf(p)].card;
          return '<div class="shrink-0' + (card ? ' rounded-lg p-1.5 ' + card : '') + '">' +
            logo + '</div>';
        })() +
        '<div class="lh-contact text-right text-[10px] leading-relaxed ' + s.textSecondary + '">' +
          '<div class="lh-name text-[12px] font-bold ' + s.textPrimary + '">' + U.esc(cd.name) + '</div>' +
          '<span class="lh-address">' + U.esc(cd.address) + '</span><br>' +
          '<span class="lh-phone font-semibold ' + s.textPrimary + '">' + U.esc(cd.phone) + '</span><br>' +
          '<span class="lh-email font-mono">' + U.esc(cd.email) + '</span>' +
        '</div>' +
      '</div></div>');

    /* ---- title, centred, ruled under the words only */
    add('<div class="doc-title text-center pb-5">' +
      '<h1 class="inline-block text-[30px] font-black tracking-[0.12em] pb-1 ' +
        'border-b-[3px] ' + s.titleColor + ' ' + s.borderPrimary + '">BID PROPOSAL</h1></div>');

    /* ---- what the proposal is for */
    if (pd.type) {
      add('<div class="doc-tagline pb-5"><div class="px-6 py-4 rounded-xl border ' + s.borderPrimary + ' ' +
        s.cardBg + ' text-center">' +
        '<div class="text-[15px] font-bold tracking-[0.06em] leading-relaxed ' + s.textPrimary + '">' +
          U.esc(pd.type).toUpperCase() + '</div></div></div>');
    }

    /* ---- the five identifying fields, label and value on one line */
    /* All five values in one face. The proposal number used to be set in the
       monospace and the project name in the prose face, which made the two
       halves of the grid look like they came from different documents. The
       monospace is kept for money, where lining up on the digit is worth
       something; a reference number and a project name are read, not compared. */
    function meta(label, value) {
      return '<div class="meta-row py-1 text-[11px] leading-snug">' +
        '<span class="meta-label font-bold tracking-wider ' + s.textMuted + '">' + label + '</span> ' +
        '<span class="meta-value font-semibold ' + s.textPrimary + '">' +
          U.esc(value || '-') + '</span></div>';
    }
    add('<div class="doc-meta pb-5"><div class="grid grid-cols-2 gap-x-8 px-5 py-3 rounded-xl border ' +
      s.borderPrimary + ' ' + s.cardBg + '">' +
        '<div>' + meta('PROPOSAL NO:', pd.proposalNo) +
          meta('SUBMITTED DATE:', U.date(pd.submittedDate)) +
          meta('APPROVAL DEADLINE:', U.date(pd.approvalDeadline)) + '</div>' +
        '<div>' + meta('PROJECT NAME:', pd.projectName) +
          meta('ADDRESS:', pd.projectAddress) + '</div>' +
      '</div></div>');

    if (pd.description) {
      add('<div class="doc-intro pb-5 px-1 text-[11.5px] leading-relaxed ' + s.textSecondary + '">' +
        U.esc(pd.description) + '</div>');
    }

    /* ---- scope: ruled entries, not a table. Title left, price right. */
    add(sectionHead(s, 'SCOPE OF WORK AND BIDDING PRICE', true), { keepWithNext: true });

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
          '<div class="scope-title text-[12px] font-bold ' + s.textPrimary + '">' + U.esc(item.description) + '</div>' +
          '<div class="scope-price text-[12px] font-bold font-mono whitespace-nowrap ' + s.textPrimary + '">' +
            U.currency2(item.cost) + '</div>' +
        '</div>' + details + '</div>',
        // A scope entry is one thought: the price and the specification it buys
        // must not end up on different sheets.
        { splitAt: null });
    });

    add('<div class="doc-total pt-5 pb-2"><div class="flex items-center justify-between gap-6 px-6 py-4 ' +
      'rounded-xl ' + s.totalBg + '">' +
        '<span class="total-label text-[13px] font-black tracking-[0.15em] ' + s.textAccent + '">TOTAL BID PRICE</span>' +
        '<span class="total-amount text-[22px] font-black font-mono ' + s.textAccent + '">' +
          U.currency2(total(p)) + '</span></div></div>');

    /* ---- the contractual half */
    if (pd.terms || pd.inclusions || pd.paymentTerms) {
      add('<div class="doc-rule pt-8 pb-6 flex items-center gap-4">' +
        '<span class="flex-1 border-t border-dashed ' + s.borderPrimary + '"></span>' +
        '<span class="rule-chip text-[9px] font-bold tracking-[0.25em] ' + s.textMuted + '">CONTRACT DETAILS &amp; TERMS</span>' +
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
      add('<div class="doc-terms prose-doc text-[10.5px] pb-4 ' + s.textSecondary + '">' +
        U.sanitizeHTML(U.toHTMLList(sec[1])) + '</div>', { splitAt: 'li' });
    });

    if (pd.acceptanceNote) {
      add('<div class="doc-accept pt-4 pb-2 px-1 text-[11px] font-semibold leading-relaxed ' +
        s.textPrimary + '">' + U.esc(pd.acceptanceNote) + '</div>');
    }

    /* A ruled line over each label, not just white space. The client signs this
       sheet with a pen: without the rule there is nothing telling them where,
       and the three fields do not line up across the page. */
    add('<div class="signature-block pt-6">' +
      '<div class="border-t ' + s.borderPrimary + ' pt-12">' +
        '<div class="grid grid-cols-3 gap-8 text-center">' +
          ['SIGNATURE', 'NAME', 'DATE'].map(function (l) {
            return '<div>' +
              '<div class="sign-rule border-b ' + s.signatureInput.split(' ')[0] + ' mb-1.5"></div>' +
              '<div class="sign-label text-[12px] font-bold tracking-wider ' + s.textPrimary + '">' +
                l + '</div></div>';
          }).join('') +
        '</div>' +
      '</div></div>');

    return out;
  }

  /* `underline` marks the scope heading. In the printed document that one is
     underlined under the words themselves and the three contractual headings
     are ruled across the page instead - the difference is what tells you the
     scope ledger is the subject and the rest is the small print. Only a theme
     that asks for it draws it that way; without the class nothing changes. */
  function sectionHead(s, title, underline) {
    return '<div class="sec-head' + (underline ? ' sec-head-underline' : '') + ' pt-2 pb-3">' +
      '<h2 class="text-[13px] font-extrabold tracking-[0.08em] uppercase pb-2 ' +
        s.sectionHeaderColor + '">' + title + '</h2>' +
      '<div class="sec-rule border-t ' + s.borderPrimary + '"></div></div>';
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

    /* The typeface and type scale the theme asks for, defined in
       assets/app.css. Themes 1-9 do not carry the key and get nothing, so they
       render exactly as they always have - see the note in proposal.styles.js. */
    var font = s.docFont ? ' ' + s.docFont : '';

    host.className = 'mx-auto ' + s.documentBg + font;
    host.style.width = '8.5in';
    host.style.minHeight = '';

    /* Repeated at the top of every page but the first, whose letterhead does
       the same job. Names the company and which proposal this is - what a
       loose sheet on somebody's desk needs to say. */
    function header() {
      return '<div class="run-head flex items-start justify-between gap-6 text-[8px] ' +
        'font-semibold tracking-[0.12em] uppercase leading-snug ' + s.textMuted + '">' +
        '<span class="max-w-[45%]">' + U.esc(cd.name) + '</span>' +
        '<span class="max-w-[50%] text-right">BID PROPOSAL: ' +
          U.esc(pd.projectName || '') + '</span></div>';
    }

    function footer(no) {
      return '<div class="run-foot flex items-center justify-between text-[8px] ' + s.textMuted + '">' +
        '<span>' + U.esc(longDate(pd.submittedDate)) + '</span>' +
        '<span>Page ' + no + '</span></div>';
    }

    host.innerHTML = root.Paginate.flow({
      host: host,
      blocks: docBlocks(p, s),
      // The class goes on every page as well as the host: the paginator
      // measures against a probe page, and a probe in a different typeface
      // would break in different places from the sheets it is measuring for.
      pageClass: 'doc-page ' + s.documentBg + font,
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
    if (path === 'proposalData.projectAddress') syncAddressToBid(p, value);
    save();
  }

  /* THE ADDRESS IS ONE FACT, EDITABLE FROM TWO PLACES.
   *
   * bid.location is where it lives - the bid form and the project card both
   * write it, the takeoff copies it, and generateFromTakeoff prints it. But the
   * address is also frequently corrected here, on the document, because that is
   * where anybody proof-reading it sees that it is wrong.
   *
   * So a correction made here goes back to the bid, and to the takeoff that
   * sits between them, rather than living on one document while the register
   * keeps the old version. The write only happens when the value actually
   * differs, which is what stops it looping through the render that follows.
   */
  function syncAddressToBid(p, value) {
    if (!p || p.bidId == null) return;
    var bid = db().bids.filter(function (b) { return b.id === p.bidId; })[0];
    if (!bid) return;
    var next = String(value == null ? '' : value).trim();
    if ((bid.location || '') === next) return;

    root.History.track(bid, function () { bid.location = next; });
    var t = bid.takeoffId ? db().takeoffs[bid.takeoffId] : null;
    if (t && t.project) t.project.location = next;
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
      // The boolean goes out as well as the choice, so a template written here
      // still frames the logo in the v3 app these files are shared with.
      frameLogo: frameOf(p) !== 'none',
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
        // Against the style table rather than a hard-coded 1..9: a template
        // written here can name any theme the app has, including the typeset
        // ones added after the v3 nine.
        if (root.PROPOSAL_STYLES[q.selectedStyle]) p.selectedStyle = q.selectedStyle;
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
        // The template may carry the choice; a v3 one carries only the boolean.
        p.companyData.logoFrame = LOGO_FRAMES[q.companyData.logoFrame]
          ? q.companyData.logoFrame
          : (q.frameLogo === false ? 'none' : 'white');
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
        remember(p);
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
      // The baseline the next write diffs against. Without it the first edit
      // of a session reports every field as having moved from empty.
      remember(current());
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
      remember(p);
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
        el.classList.add('border-danger', 'bg-danger-soft');
        U.toast('Enter the date as MM-DD-YYYY.', 'err');
        return;
      }
      el.classList.remove('border-danger', 'bg-danger-soft');
      el.value = U.dateToInput(iso);

      /* Moving the submitted date carries the approval deadline with it, so the
         two weeks are counted from when the proposal actually went out.
         Only while the deadline is still the automatic one, though: it matches
         against what the old submitted date implied, so a fortnight nobody
         touched follows along and a date somebody chose on purpose does not get
         quietly overwritten. */
      if (path === 'proposalData.submittedDate') {
        var p = current();
        var pd = p.proposalData;
        var automatic = !pd.approvalDeadline ||
          pd.approvalDeadline === U.addDays(pd.submittedDate, APPROVAL_DAYS);
        setPath(path, iso || '');
        if (automatic && iso) setPath('proposalData.approvalDeadline', U.addDays(iso, APPROVAL_DAYS));
        return;
      }
      setPath(path, iso || '');
    },

    richInput: function (el) {
      var path = el.getAttribute('data-path');
      var keys = path.split('.');
      var last = keys.pop();
      var target = keys.reduce(function (o, k) { return o[k]; }, current());
      target[last] = U.sanitizeHTML(el.innerHTML);
      commit();
      paintDoc();
    },
    scopeRichInput: function (el) {
      var i = Number(el.getAttribute('data-scope'));
      current().scopeItems[i].details = U.sanitizeHTML(el.innerHTML);
      commit();
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
      commit();
      paintDoc();
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

    /* Written to the shop's company record as well as this proposal, the same
       as the logo itself below - it is a fact about the logo, not about one
       document, and blank() copies db().company into every new proposal. */
    /* The three, and which one a given proposal resolves to - read by the
       letterhead, by the control in the Company tab, and by the tests. */
    LOGO_FRAMES: LOGO_FRAMES,
    logoFrame: frameOf,

    setLogoFrame: function (key) {
      if (!LOGO_FRAMES[key]) return;
      var p = current();
      if (!p) return;
      p.companyData.logoFrame = key;
      // The boolean is kept in step so nothing reading the old field disagrees
      // with what is on screen.
      p.frameLogo = key !== 'none';
      db().company.logoFrame = key;
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
      /* WHAT THE CLIENT ACTUALLY SAW. Nothing on the record moves when a PDF
         is exported, but "which version did they get" is answered by what the
         log says the total was at this moment - so the moment is recorded. */
      var bid = bidOf(current());
      if (bid) {
        root.History.recordDocEvent(bid, 'proposal', 'exported-pdf');
        root.Store.save();
      }
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
