/* ui.js - the one place that knows what a button looks like.
 *
 * Every module in this app renders HTML strings, and each of them had grown its
 * own copy of the same markup: `bg-blue-600 hover:bg-blue-500 text-white
 * rounded-lg ...` was written out nineteen times, the card shell seventeen, and
 * font sizes were a scatter of text-[9px], text-[10px] and text-[11px] with no
 * scale behind them. Changing the blue meant grepping twenty-six files and
 * hoping. These builders are that markup, once.
 *
 * Everything here is a pure string builder: no DOM, no state, no events. A
 * caller still writes `host.innerHTML = UI.card({...})` exactly as it wrote the
 * markup by hand, so nothing about how the app renders has changed.
 *
 * THE RULE ABOUT CLASS NAMES. The stylesheet is compiled ahead of time from the
 * class names the scanner can find in the source (see tailwind.config.js), so a
 * class has to appear as a complete literal string. That is why the tables below
 * spell out `bg-brand hover:bg-brand-hover text-white` in full rather than
 * assembling 'bg-' + tone: the assembled version compiles to nothing at all.
 *
 * Colours are semantic. `brand` is the accent, `ok` / `warn` / `danger` are
 * outcomes, `neutral` is a quiet action, `chrome` is the dark header bar. What
 * each resolves to - and what it becomes in the dark theme - is
 * assets/tokens.css, so nothing in here has to know which theme is on.
 */
(function (root) {
  'use strict';

  var U = root.U;

  /* ---- vocabulary ------------------------------------------------------- */

  /* A solid fill: this is the action you came to the screen to take. At most
     one per group, or none of them reads as primary. */
  var SOLID = {
    brand:   'bg-brand hover:bg-brand-hover text-white',
    ok:      'bg-ok hover:bg-ok-hover text-white',
    warn:    'bg-warn hover:bg-warn-hover text-white',
    danger:  'bg-danger hover:bg-danger-hover text-white',
    info:    'bg-info hover:bg-info-hover text-white',
    neutral: 'bg-neutral hover:bg-neutral-hover text-white'
  };

  /* A tinted fill: available, clearly a button, not shouting. The default for
     anything sitting inside a card next to other controls. */
  var SOFT = {
    brand:   'bg-brand-soft hover:bg-brand-soft/60 text-brand-ink',
    ok:      'bg-ok-soft hover:bg-ok-soft/60 text-ok-ink',
    warn:    'bg-warn-soft hover:bg-warn-soft/60 text-warn-ink',
    danger:  'bg-danger-soft hover:bg-danger-soft/60 text-danger-ink',
    info:    'bg-info-soft hover:bg-info-soft/60 text-info-ink',
    neutral: 'bg-neutral-soft hover:bg-neutral-soft/60 text-neutral-ink'
  };

  /* No fill until you point at it: for dense rows and toolbars where a row of
     tinted rectangles would be louder than the data underneath. */
  var GHOST = {
    brand:   'text-brand-ink hover:bg-brand-soft',
    ok:      'text-ok-ink hover:bg-ok-soft',
    warn:    'text-warn-ink hover:bg-warn-soft',
    danger:  'text-danger-ink hover:bg-danger-soft',
    info:    'text-info-ink hover:bg-info-soft',
    neutral: 'text-muted hover:bg-raised hover:text-ink'
  };

  /* On the dark header bar, where the tones above would all be invisible. */
  var CHROME = {
    on:  'bg-brand text-white font-semibold shadow-lg shadow-brand/25',
    off: 'text-chrome-ink/70 hover:text-white hover:bg-chrome-soft/60',
    btn: 'bg-chrome-soft hover:bg-chrome-soft/70 text-white'
  };

  var SIZES = {
    xs: 'px-2 py-1 text-3xs gap-1.5',
    sm: 'px-3 py-1.5 text-xs gap-1.5',
    md: 'px-3 py-2 text-sm gap-2',
    lg: 'px-5 py-2.5 text-sm gap-2'
  };

  var BTN_BASE = 'rounded-lg font-medium transition inline-flex items-center ' +
                 'justify-center whitespace-nowrap disabled:opacity-40 ' +
                 'disabled:cursor-not-allowed disabled:pointer-events-none';

  /* The form control, which was pasted into every panel and modal. */
  var CONTROL = 'w-full px-3 py-2 bg-raised border border-line rounded-lg text-sm ' +
                'text-ink placeholder:text-faint focus:border-brand outline-none transition';

  function variantClass(variant, tone) {
    var t = tone || 'brand';
    if (variant === 'soft')   return SOFT[t]   || SOFT.brand;
    if (variant === 'ghost')  return GHOST[t]  || GHOST.neutral;
    if (variant === 'chrome') return CHROME.btn;
    return SOLID[t] || SOLID.brand;
  }

  function icon(name, extra) {
    if (!name) return '';
    return '<i class="fas ' + name + (extra ? ' ' + extra : '') + '"></i>';
  }

  /* Attributes shared by every control here. `on` is the onclick body, kept as
     a string because that is how every call site in this app already works. */
  function attrs(o) {
    return (o.id ? ' id="' + U.escAttr(o.id) + '"' : '') +
      (o.onclick ? ' onclick="' + o.onclick + '"' : '') +
      (o.title ? ' title="' + U.escAttr(o.title) + '"' : '') +
      (o.disabled ? ' disabled' : '') +
      (o.attrs ? ' ' + o.attrs : '');
  }

  /* ---- the inline editor's two helpers ----------------------------------- */

  /* Saving an inline edit re-renders the card, so the field is a new element by
     the time this runs - it is found again by the field name rather than held
     on to. A brief tint is enough: it says "that landed" without a toast for
     every keystroke's worth of work. */
  function flash(host) {
    var spec;
    try { spec = JSON.parse(host.dataset.edit || '{}'); } catch (e) { return; }
    setTimeout(function () {
      var el = document.querySelector('[data-edit*=\'"field":"' + spec.field + '"\']');
      if (!el) return;
      el.classList.add('edit-saved');
      setTimeout(function () { el.classList.remove('edit-saved'); }, 900);
    }, 0);
  }

  /* Tab moves to the next editable field on the card and opens it, in document
     order - which is the order they are read in. */
  function focusNext(host) {
    var all = Array.prototype.slice.call(document.querySelectorAll('[data-edit]'));
    var i = all.indexOf(host);
    // Re-render may have replaced the node, so fall back to matching on field.
    if (i < 0) {
      var field = (JSON.parse(host.dataset.edit || '{}') || {}).field;
      i = all.findIndex(function (el) {
        try { return JSON.parse(el.dataset.edit).field === field; } catch (e) { return false; }
      });
    }
    setTimeout(function () {
      var fresh = document.querySelectorAll('[data-edit]');
      var next = fresh[i + 1];
      if (next) UI.beginEdit(next);
    }, 0);
  }

  var UI = {
    CONTROL: CONTROL,
    CHROME: CHROME,

    /* A button.
       { label, icon, onclick, tone, variant, size, title, id, type, disabled,
         block, trailingIcon, className } */
    btn: function (o) {
      o = o || {};
      var cls = BTN_BASE + ' ' + (SIZES[o.size] || SIZES.md) + ' ' +
        variantClass(o.variant, o.tone) +
        (o.block ? ' w-full' : '') +
        (o.className ? ' ' + o.className : '');
      return '<button type="' + (o.type || 'button') + '"' + attrs(o) +
        ' class="' + cls + '">' +
        icon(o.icon) + (o.label ? U.esc(o.label) : '') +
        icon(o.trailingIcon, 'text-3xs opacity-70') +
      '</button>';
    },

    /* The same thing as a link - for a platform URL, which must stay a real
       anchor so middle-click and "copy link address" behave. */
    linkBtn: function (o) {
      o = o || {};
      var cls = BTN_BASE + ' ' + (SIZES[o.size] || SIZES.md) + ' ' +
        variantClass(o.variant, o.tone) + (o.className ? ' ' + o.className : '');
      return '<a href="' + U.escAttr(o.href || '#') + '" target="_blank" rel="noopener"' +
        (o.title ? ' title="' + U.escAttr(o.title) + '"' : '') +
        ' class="' + cls + '">' + icon(o.icon) + (o.label ? U.esc(o.label) : '') + '</a>';
    },

    /* A square icon-only button, as used down the Actions column of the bids
       table. Always carries a title: an icon with no label and no tooltip is a
       guess, and there are six of them in a row. */
    iconBtn: function (o) {
      o = o || {};
      var box = o.size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';
      var cls = 'btn-icon rounded-lg flex items-center justify-center shrink-0 transition ' +
        box + ' ' + variantClass(o.variant || 'soft', o.tone);
      // A control that is deliberately unavailable is drawn, not hidden, so the
      // row keeps its shape and the reason can be read off the tooltip.
      if (o.disabled) {
        return '<span title="' + U.escAttr(o.title || '') + '" class="' + box +
          ' rounded-lg bg-raised text-faint flex items-center justify-center ' +
          'shrink-0 cursor-not-allowed">' + icon(o.icon, 'text-xs') + '</span>';
      }
      if (o.href) {
        return '<a href="' + U.escAttr(o.href) + '" target="_blank" rel="noopener" title="' +
          U.escAttr(o.title || '') + '" class="' + cls + '">' + icon(o.icon, 'text-xs') + '</a>';
      }
      return '<button type="button"' + attrs(o) + ' class="' + cls + '">' +
        icon(o.icon, 'text-xs') + '</button>';
    },

    /* A card: the unit every panel in the app is made of.
       { title, icon, blurb, action, body, size, bodyClass } */
    card: function (o) {
      o = o || {};
      var big = o.size === 'lg';
      var head = '';
      if (o.title || o.action) {
        head = '<div class="' + (big ? 'px-6 py-4' : 'px-5 py-3') +
          ' border-b border-line ' + (big ? '' : 'bg-raised ') +
          'flex items-start justify-between gap-3">' +
          '<div class="min-w-0">' +
            (big
              ? '<h2 class="text-lg font-bold text-ink-strong">' + U.esc(o.title) + '</h2>'
              : '<h3 class="text-sm font-bold text-ink flex items-center gap-2">' +
                  icon(o.icon, 'text-muted') + U.esc(o.title) + '</h3>') +
            (o.blurb ? '<p class="text-xs text-muted mt-0.5">' + o.blurb + '</p>' : '') +
          '</div>' +
          (o.action || '') +
        '</div>';
      }
      return '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden">' +
        head +
        '<div class="' + (o.bodyClass || (big ? 'p-6' : 'p-5')) + '">' + (o.body || '') + '</div>' +
      '</div>';
    },

    /* A labelled read-only value, as used all over the project overview. */
    field: function (label, value) {
      return '<div class="min-w-0">' +
        '<div class="text-3xs font-bold text-muted uppercase tracking-wider mb-1">' +
          U.esc(label) + '</div>' +
        '<div class="text-sm text-ink break-words">' +
          (value || '<span class="text-faint">&mdash;</span>') + '</div>' +
      '</div>';
    },

    /* The same labelled value, but double-clicking it turns it into the right
       control in place.

       Opening a modal to change one field is a lot of ceremony for correcting a
       due date, and the modal shows fifteen other fields you did not come to
       touch. This is the same field, edited where you are reading it.

         { bidId, field, type, value, options, hint }
           type    text | number | date | select | textarea
           value   the RAW value to edit, which is not always what is displayed
                   (a date shows MM-DD-YYYY but is stored ISO)
           options for select, an array of strings

       Only the fields a person actually types are given this. Computed ones -
       hours, the team, the totals off the takeoff - keep the plain UI.field, so
       what can be edited is legible rather than something you discover by
       double-clicking everything. */
    editableField: function (label, display, o) {
      o = o || {};
      var spec = { field: o.field, type: o.type || 'text', bidId: o.bidId,
                   value: o.value == null ? '' : String(o.value),
                   options: o.options || null };
      /* The pencil is always faintly there rather than appearing on hover: a
         field you can edit should say so before you touch it. A single click
         opens the editor as well as a double, because nobody guesses that a
         line of text is editable and then guesses that it takes two clicks.

         These live on the project page's details card (see Project.detailsCard),
         which is not itself clickable - so a single click here cannot collide
         with anything. It is also reachable from the keyboard: tabbable, and
         Enter or Space opens it. */
      return '<div class="min-w-0 group">' +
        '<div class="text-3xs font-bold text-muted uppercase tracking-wider mb-1 flex items-center gap-1">' +
          U.esc(label) +
          '<i class="fas fa-pen text-3xs text-faint opacity-40 group-hover:opacity-100 transition"></i>' +
        '</div>' +
        '<div class="edit-field text-sm text-ink break-words rounded px-1 -mx-1 cursor-text ' +
             'hover:bg-raised transition" ' +
             'tabindex="0" role="button" ' +
             'onclick="UI.beginEdit(this)" ' +
             'ondblclick="UI.beginEdit(this)" ' +
             'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();UI.beginEdit(this)}" ' +
             'title="Click to edit ' + U.escAttr(label) + '" ' +
             'data-edit="' + U.escAttr(JSON.stringify(spec)) + '">' +
          (display || '<span class="text-faint">&mdash;</span>') +
        '</div>' +
      '</div>';
    },

    /* Swap the value for a control. The original markup is kept on the node so
       Escape - or a save that the record refuses - can put it back exactly as
       it was rather than re-deriving it. */
    beginEdit: function (host) {
      if (host.dataset.editing) return;
      var spec;
      try { spec = JSON.parse(host.dataset.edit); } catch (e) { return; }
      if (!spec || !spec.field) return;

      host.dataset.editing = '1';
      host.dataset.original = host.innerHTML;

      var control;
      if (spec.type === 'select') {
        control = document.createElement('select');
        (spec.options || []).forEach(function (opt) {
          var el = document.createElement('option');
          el.value = opt; el.textContent = opt;
          if (opt === spec.value) el.selected = true;
          control.appendChild(el);
        });
      } else if (spec.type === 'textarea') {
        control = document.createElement('textarea');
        control.rows = 2;
        control.value = spec.value;
      } else {
        control = document.createElement('input');
        // A date is typed as MM-DD-YYYY and stored ISO, so the control shows
        // the one and U.inputToDate converts on the way out - the same pair the
        // bid form uses, not a second date format nobody expects here.
        control.type = spec.type === 'number' ? 'number' : 'text';
        if (spec.type === 'number') control.step = 'any';
        control.value = spec.type === 'date' ? U.dateToInput(spec.value) : spec.value;
      }
      control.className = 'flex-1 min-w-0 px-2 py-1 bg-surface border border-brand rounded ' +
        'text-sm outline-none';

      /* A row of controls rather than a bare input: something to say what the
         two keys do, a calendar for a date, and somewhere to put the reason a
         value was refused. */
      var wrap = document.createElement('div');
      wrap.className = 'flex items-center gap-1';
      wrap.appendChild(control);

      var problem = document.createElement('div');
      problem.className = 'hidden text-3xs text-danger mt-1';

      function iconButton(cls, title, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;                     // Tab belongs to the next field
        b.title = title;
        b.className = 'w-6 h-6 rounded flex items-center justify-center shrink-0 ' + cls;
        b.innerHTML = '<i class="fas fa-' + (title === 'Cancel' ? 'times' : 'check') +
          ' text-3xs"></i>';
        // mousedown, not click: the input's blur would otherwise fire first and
        // decide the outcome before the button was ever heard from.
        b.addEventListener('mousedown', function (e) { e.preventDefault(); fn(); });
        return b;
      }

      if (spec.type === 'date') {
        var cal = document.createElement('button');
        cal.type = 'button';
        cal.tabIndex = -1;
        cal.title = 'Open calendar';
        cal.className = 'w-6 h-6 rounded flex items-center justify-center shrink-0 ' +
          'text-faint hover:text-brand';
        cal.innerHTML = '<i class="fas fa-calendar-alt text-3xs"></i>';
        cal.addEventListener('mousedown', function (e) {
          e.preventDefault();
          U.openDatePicker(control);
        });
        wrap.appendChild(cal);
      }

      var done = false;

      /* WHAT COUNTS AS A VALUE THIS FIELD CAN TAKE.
         A date that does not exist used to be handed to saveField, which had no
         way to say no from inside a blur handler - so it was dropped and the
         old value came back with nothing said. Now it is refused here, in front
         of the person who typed it, and the editor stays open. */
      function invalid() {
        if (spec.type === 'date') {
          var v = String(control.value || '').trim();
          if (v && U.inputToDate(v) === null) return 'Not a date. Use MM-DD-YYYY.';
        }
        if (spec.type === 'number' && control.value !== '' && isNaN(Number(control.value))) {
          return 'Numbers only.';
        }
        return null;
      }

      function refuse(message) {
        problem.textContent = message;
        problem.classList.remove('hidden');
        control.classList.add('border-danger', 'bg-danger-soft');
        control.focus();
      }

      function finish(commit, thenFocusNext) {
        if (done) return false;
        if (commit) {
          var bad = invalid();
          if (bad) { refuse(bad); return false; }
        }
        done = true;
        delete host.dataset.editing;
        if (!commit) { host.innerHTML = host.dataset.original; return true; }
        root.Bids.saveField(spec.bidId, spec.field, control.value, spec.type, host);
        flash(host);
        if (thenFocusNext) focusNext(host);
        return true;
      }

      control.addEventListener('input', function () {
        problem.classList.add('hidden');
        control.classList.remove('border-danger', 'bg-danger-soft');
      });

      control.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
        // Enter commits, except in a textarea where it is a newline and the
        // only sane commit is leaving the field.
        if (e.key === 'Enter' && spec.type !== 'textarea') { e.preventDefault(); finish(true); return; }
        // Tab saves this one and opens the next, which is how a page of fields
        // actually gets filled in.
        if (e.key === 'Tab' && !e.shiftKey) {
          if (finish(true, true)) e.preventDefault();
        }
      });

      control.addEventListener('blur', function () {
        // The calendar takes the focus away from the field it is filling in;
        // that is not somebody leaving the editor.
        if (root.DatePicker && root.DatePicker.isOpen()) return;
        if (invalid()) { refuse(invalid()); return; }
        finish(true);
      });

      // A select is done the moment it changes; waiting for a blur leaves it
      // looking like nothing happened.
      if (spec.type === 'select') {
        control.addEventListener('change', function () { finish(true); });
      } else {
        wrap.appendChild(iconButton('text-ok-ink hover:bg-ok-soft', 'Save', function () { finish(true); }));
        wrap.appendChild(iconButton('text-faint hover:text-danger', 'Cancel', function () { finish(false); }));
      }

      host.innerHTML = '';
      host.appendChild(wrap);
      host.appendChild(problem);
      control.focus();
      if (control.select) control.select();
    },

    /* A tick where the value is, for a moment, so a save that changed nothing
       visible is still visibly a save. */
    flash: function (host) { flash(host); },

    /* A status pill. `tone` may instead be one of the status-* classes from
       assets/app.css, which is how Bids.STATUSES colours its own. */
    badge: function (text, tone) {
      var cls = SOFT[tone] ? SOFT[tone].replace(/hover:\S+\s?/g, '') : tone;
      return '<span class="inline-block px-2.5 py-1 rounded-full text-3xs font-bold ' +
        'tracking-wider uppercase whitespace-nowrap ' + cls + '">' + U.esc(text) + '</span>';
    },

    /* A small tag: a product, a set of initials, a "+3 more". */
    chip: function (text, o) {
      o = o || {};
      return '<span class="inline-block px-1.5 py-0.5 rounded text-3xs max-w-[150px] truncate ' +
        'align-middle ' + (o.strong ? 'bg-line font-semibold text-ink' : 'bg-raised text-muted') +
        '"' + (o.title ? ' title="' + U.escAttr(o.title) + '"' : '') + '>' +
        U.esc(text) + '</span>';
    },

    /* Nothing to show. Said the same way everywhere - the module placeholder,
       the empty bids table and the project page with no project picked were
       three hand-built variants of this. */
    empty: function (o) {
      o = o || {};
      return '<div class="text-center ' + (o.compact ? 'py-12' : 'p-16') + '">' +
        '<div class="w-16 h-16 bg-raised rounded-2xl flex items-center justify-center mx-auto mb-4">' +
          icon(o.icon || 'fa-inbox', 'text-2xl text-faint') + '</div>' +
        '<h3 class="text-lg font-bold text-ink-strong mb-1">' + U.esc(o.title || '') + '</h3>' +
        (o.blurb ? '<p class="text-sm text-muted max-w-md mx-auto">' + o.blurb + '</p>' : '') +
        (o.action ? '<div class="mt-5">' + o.action + '</div>' : '') +
      '</div>';
    },

    /* The empty state boxed in its own card, which is what a whole page wants. */
    emptyCard: function (o) {
      return '<div class="bg-surface rounded-xl shadow-card border border-line">' +
        UI.empty(o) + '</div>';
    },

    /* An inline notice inside a card - the stale-proposal warning, and the like. */
    notice: function (o) {
      o = o || {};
      var t = o.tone || 'warn';
      var wash = { brand: 'bg-brand-soft border-brand/30 text-brand-ink',
                   ok: 'bg-ok-soft border-ok/30 text-ok-ink',
                   warn: 'bg-warn-soft border-warn/30 text-warn-ink',
                   danger: 'bg-danger-soft border-danger/30 text-danger-ink',
                   info: 'bg-info-soft border-info/30 text-info-ink' }[t];
      return '<div class="px-3 py-2.5 rounded-lg border flex items-center gap-2 ' + wash + '">' +
        icon(o.icon || 'fa-triangle-exclamation', 'text-xs shrink-0') +
        '<span class="flex-1 text-2xs leading-snug">' + (o.text || '') + '</span>' +
        (o.action || '') +
      '</div>';
    },

    /* Form controls. The label above the box, in the small caps the app uses. */
    label: function (text, hint) {
      return '<label class="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">' +
        U.esc(text) +
        (hint ? ' <span class="text-faint normal-case font-normal">' + U.esc(hint) + '</span>' : '') +
      '</label>';
    },

    input: function (o) {
      o = o || {};
      return '<input type="' + (o.type || 'text') + '"' + attrs(o) +
        (o.value != null ? ' value="' + U.escAttr(o.value) + '"' : '') +
        (o.placeholder ? ' placeholder="' + U.escAttr(o.placeholder) + '"' : '') +
        ' class="' + CONTROL + (o.className ? ' ' + o.className : '') + '">';
    },

    /* ---- charts ---------------------------------------------------------- */

    /* Chart.js needs concrete colours, and the tokens are CSS variables, so
       they are read off the document at draw time. That is also what makes the
       charts follow a theme change: re-rendering re-reads them. */
    color: function (name, alpha) {
      var v = getComputedStyle(document.documentElement)
        .getPropertyValue('--c-' + name).trim();
      if (!v) return '#64748b';
      return alpha == null ? 'rgb(' + v + ')' : 'rgb(' + v + ' / ' + alpha + ')';
    },

    /* One categorical order, used by every chart, so the same series is the
       same colour on the bar chart and the pie beside it. */
    chartColors: function () {
      return ['brand', 'ok', 'warn', 'danger', 'info', 'neutral']
        .map(function (t) { return UI.color(t); });
    },

    /* The status colours the bids table uses, so the Status Distribution chart
       agrees with the badges in the grid rather than inventing its own palette.

       Keyed off the badge class each status already carries in Bids.STATUSES,
       not off a second list of status names - one of those spelled "Submitted
       to review" with a capital R would silently colour that slice grey and
       nobody would ever notice. */
    BADGE_TONE: {
      'status-notstarted': 'neutral',
      'status-progress':   'warn',
      'status-submitted':  'brand',
      'status-completed':  'ok',
      'status-awarded':    'ok',
      'status-lost':       'danger',
      'status-noscope':    'info'
    },

    statusColor: function (status) {
      var s = root.Bids && root.Bids.statusOf && root.Bids.statusOf(status);
      return UI.color((s && UI.BADGE_TONE[s.badge]) || 'neutral');
    }
  };

  root.UI = UI;
})(window);
