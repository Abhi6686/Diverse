/* datepicker.js - a month grid the app owns.
 *
 * Every date in this app is written MM-DD-YYYY and stored 'YYYY-MM-DD'. The
 * calendar behind those fields used to be a hidden <input type="date">, opened
 * with showPicker() purely to borrow the browser's own popup - which renders in
 * the browser's locale order and cannot be told otherwise. So the field read
 * MM-DD-YYYY and the calendar it opened read dd-mm-yyyy, on the same screen,
 * for the same date.
 *
 * This replaces it. It is the only calendar in the app: U.openDatePicker calls
 * it, and every date field goes through U.dateFieldHTML, so the bid form, the
 * revised due date, the Team & Hours start dates and the proposal's dates all
 * get the same one.
 *
 * WEEKS START SUNDAY here. That is the wall calendar the office reads, and this
 * is a wall calendar. The Employee schedule starts Monday and is right to: it
 * is a working week, which is a different object with a different question -
 * see Schedule.weekStart.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  /* Open at most one, on document.body, positioned fixed - the same rules as
     the grid's popovers, and for the same reason: a date field can sit inside a
     scrolling card, where an absolutely positioned popup is clipped. */
  var el = null;      // the popup
  var state = null;   // { input, cursor, selected, mark, onPick }

  /* ---- dates as plain ISO strings, never as instants --------------------- */

  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function parse(s) { return U.parseDate(s); }

  function firstOfMonth(s) {
    var d = parse(s) || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function shiftDays(s, n) {
    var d = parse(s);
    if (!d) return s;
    d.setDate(d.getDate() + n);
    return iso(d);
  }

  function shiftMonths(s, n) {
    var d = parse(s) || new Date();
    // Clamp to the length of the target month, or 31 January + 1 month lands in
    // March. The 31st going to the 28th is what a person means by "next month".
    var target = new Date(d.getFullYear(), d.getMonth() + n, 1);
    var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(d.getDate(), last));
    return iso(target);
  }

  /* The 42 cells of a month grid: the month, padded out to whole weeks either
     side so every month is the same height and nothing jumps as you page. */
  function grid(cursorISO) {
    var first = firstOfMonth(cursorISO);
    var start = new Date(first);
    start.setDate(1 - first.getDay());          // back to the Sunday
    var out = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({
        date: iso(d),
        day: d.getDate(),
        outside: d.getMonth() !== first.getMonth(),
        weekend: d.getDay() === 0 || d.getDay() === 6
      });
    }
    return out;
  }

  /* ---- rendering --------------------------------------------------------- */

  function cellClass(c) {
    var today = c.date === U.today();
    var picked = c.date === state.selected;
    var cls = 'h-8 w-9 rounded-lg text-sm flex items-center justify-center transition ';
    if (picked) return cls + 'bg-brand text-white font-bold shadow-card';
    if (today) return cls + 'ring-1 ring-brand text-brand-ink font-bold hover:bg-brand-soft';
    if (c.outside) return cls + 'text-faint hover:bg-raised';
    if (c.weekend) return cls + 'text-muted hover:bg-raised';
    return cls + 'text-ink hover:bg-raised';
  }

  function body() {
    var cur = parse(state.cursor) || new Date();
    var cells = grid(state.cursor);

    return '<div class="flex items-center justify-between gap-2 mb-2">' +
        arrow(-1, 'fa-chevron-left', 'Previous month') +
        '<span class="text-sm font-bold text-ink-strong">' +
          MONTHS[cur.getMonth()] + ' ' + cur.getFullYear() + '</span>' +
        arrow(1, 'fa-chevron-right', 'Next month') +
      '</div>' +
      '<div class="grid grid-cols-7 gap-0.5 mb-1">' +
        DOW.map(function (d) {
          return '<span class="h-6 w-9 flex items-center justify-center text-3xs ' +
            'font-bold uppercase tracking-wider text-faint">' + d + '</span>';
        }).join('') +
      '</div>' +
      '<div class="grid grid-cols-7 gap-0.5">' +
        cells.map(function (c) {
          // The mark is a second date worth seeing while choosing this one -
          // the original due date while picking a revised one, say.
          var marked = state.mark && c.date === state.mark;
          return '<button type="button" data-date="' + c.date + '" ' +
            'class="' + cellClass(c) + ' relative" ' +
            (marked ? 'title="' + U.escAttr(state.markLabel || 'Also this date') + '"' : '') + '>' +
            c.day +
            (marked ? '<span class="absolute bottom-0.5 w-1 h-1 rounded-full bg-warn"></span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-line">' +
        '<button type="button" data-act="today" ' +
          'class="px-2.5 py-1 rounded-lg text-xs font-semibold text-brand hover:bg-brand-soft">' +
          'Today</button>' +
        '<button type="button" data-act="clear" ' +
          'class="px-2.5 py-1 rounded-lg text-xs text-muted hover:text-danger">Clear</button>' +
      '</div>';
  }

  function arrow(n, icon, label) {
    return '<button type="button" data-step="' + n + '" title="' + label + '" ' +
      'class="w-7 h-7 rounded-lg text-muted hover:text-ink hover:bg-raised ' +
      'flex items-center justify-center"><i class="fas ' + icon + ' text-xs"></i></button>';
  }

  function paint() {
    if (!el) return;
    el.innerHTML = body();
  }

  /* Under the field, nudged back inside the window on both axes - a date field
     near the bottom of a long form would otherwise open below the fold. */
  function place(anchor) {
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 280;
    var h = el.offsetHeight || 320;
    var left = Math.min(r.left, root.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > root.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
  }

  /* ---- opening and closing ----------------------------------------------- */

  function close() {
    if (!el) return;
    el.remove();
    el = null;
    state = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onDocDown(e) {
    if (!el) return;
    if (el.contains(e.target)) return;
    if (state && state.input && state.input.contains && state.input.contains(e.target)) return;
    if (state && e.target === state.input) return;
    close();
  }

  /* The keyboard is the whole point of owning this: arrows walk the grid, the
     page keys walk months, Enter takes the day under the cursor. */
  function onKey(e) {
    if (!el) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); close(); return; }
    if (k === 'Enter') { e.preventDefault(); pick(state.cursor); return; }

    var by = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1
           : k === 'ArrowUp' ? -7 : k === 'ArrowDown' ? 7 : 0;
    if (by) {
      e.preventDefault();
      state.cursor = shiftDays(state.cursor, by);
      state.selected = state.cursor;
      paint();
      return;
    }
    if (k === 'PageUp' || k === 'PageDown') {
      e.preventDefault();
      state.cursor = shiftMonths(state.cursor, k === 'PageUp' ? -1 : 1);
      state.selected = state.cursor;
      paint();
    }
  }

  function pick(dateISO) {
    var input = state.input;
    var onPick = state.onPick;
    close();
    if (!input) return;
    input.value = dateISO ? U.dateToInput(dateISO) : '';
    input.classList.remove('border-danger', 'bg-danger-soft');
    // The same event a typed date fires, so every call site keeps one code path
    // for "this field changed" whether it was typed or clicked.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onPick) onPick(dateISO);
    input.focus();
  }

  /* `o` may carry { mark, markLabel, onPick }. The input is the text field the
     app already draws - see U.dateFieldHTML - and stays the source of truth. */
  function open(input, o) {
    if (!input) return;
    o = o || {};
    if (el && state && state.input === input) { close(); return; }   // toggle
    close();

    var current = U.inputToDate(input.value);
    var selected = current || null;                 // '' or null when unset
    state = {
      input: input,
      selected: selected || null,
      // An empty field opens on today, unless the caller knows a better place
      // to start: a revised due date is chosen by moving the original, so it
      // opens on the month that date is in rather than on this one.
      cursor: selected || o.startAt || U.today(),
      mark: o.mark || null,
      markLabel: o.markLabel || null,
      onPick: o.onPick || null
    };

    el = document.createElement('div');
    el.className = 'fixed z-[60] bg-surface border border-line-strong rounded-xl ' +
      'shadow-pop p-3 select-none';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Choose a date');
    el.addEventListener('mousedown', function (e) {
      // Keep the field's focus: a blur here would commit the inline editor out
      // from under the calendar it just opened.
      e.preventDefault();
    });
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.date) { pick(btn.dataset.date); return; }
      if (btn.dataset.step) {
        state.cursor = shiftMonths(state.cursor, Number(btn.dataset.step));
        paint();
        return;
      }
      if (btn.dataset.act === 'today') { pick(U.today()); return; }
      if (btn.dataset.act === 'clear') { pick(''); return; }
    });

    document.body.appendChild(el);
    paint();
    place(input);

    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  root.DatePicker = {
    open: open,
    close: close,
    isOpen: function () { return !!el; },
    /* For tests: the 42 cells a month draws, without any DOM. */
    grid: grid,
    shiftMonths: shiftMonths
  };
})(window);
