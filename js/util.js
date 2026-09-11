/* util.js - formatting and small DOM helpers shared by every module. */
(function (root) {
  'use strict';

  var money0 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });
  var money2 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  var num2 = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  var U = {
    /* Dash for empty so tables stay readable; 0 is a real value and prints. */
    currency: function (n) {
      if (n == null || n === '' || isNaN(n)) return '-';
      return money0.format(Number(n));
    },
    currency2: function (n) {
      if (n == null || n === '' || isNaN(n)) return '-';
      return money2.format(Number(n));
    },
    num: function (n, dp) {
      if (n == null || n === '' || isNaN(n)) return '-';
      if (dp === undefined) return num2.format(Number(n));
      return Number(n).toLocaleString('en-US', {
        minimumFractionDigits: dp, maximumFractionDigits: dp
      });
    },
    /* Bid totals are quoted on a round ten. The rule, from the worked examples:
       drop the cents, then move up to the next multiple of ten unless already
       sitting on one.
         101,980.65 -> 101,980    (floor is 101,980, already a multiple)
         101,981.25 -> 101,990
         101,988.75 -> 101,990 */
    roundTo10: function (v) {
      var n = Number(v);
      if (!isFinite(n)) return 0;
      return Math.ceil(Math.floor(n) / 10) * 10;
    },

    /* Trims trailing zeros: 442.43 stays, 64.00 becomes 64. */
    qty: function (n) {
      if (n == null || n === '' || isNaN(n)) return '-';
      var v = Number(n);
      return (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    },
    /* Dates are stored as ISO 'YYYY-MM-DD' and shown as MM-DD-YYYY throughout.

       parseDate splits the ISO string by hand rather than using new Date(iso):
       the Date constructor reads a bare 'YYYY-MM-DD' as UTC midnight, so in any
       negative-offset timezone (all of the US) it renders as the day before. */
    parseDate: function (v) {
      if (!v) return null;
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
      var d = new Date(v);
      return isNaN(d) ? null : d;
    },

    /* A CALENDAR DATE -> MM-DD-YYYY.
       For values stored as bare 'YYYY-MM-DD' - due dates, award dates. These
       are days, not moments: a due date of the 22nd is the 22nd everywhere on
       earth, so it must never be put through a timezone. See U.stamp below for
       the other kind, and pick deliberately between them. */
    date: function (d) {
      var dt = U.parseDate(d);
      if (!dt) return '-';
      var mm = String(dt.getMonth() + 1).padStart(2, '0');
      var dd = String(dt.getDate()).padStart(2, '0');
      return mm + '-' + dd + '-' + dt.getFullYear();
    },

    /* ---- moments ---------------------------------------------------------
     *
     * The other kind of date: an instant, stored as a full UTC ISO timestamp -
     * createdAt, the history log, a takeoff's updatedAt.
     *
     * These are shown in IST, always, whatever the machine reading them is set
     * to. The office is in India; a timestamp that silently means something
     * different on a laptop that has travelled is worse than useless in an
     * audit log. Storage stays UTC, which is unambiguous and sorts correctly
     * as a plain string.
     *
     * This replaces `U.date(iso.slice(0, 10))`, which was in six places and was
     * wrong twice over: it dropped the time, and it took the UTC calendar date.
     * A bid entered at 02:00 IST is 20:30 the PREVIOUS day in UTC, so it was
     * displayed a day early - for five and a half hours out of every twenty-four.
     */
    TZ: 'Asia/Kolkata',
    TZ_LABEL: 'IST',

    /* Built once. Intl.DateTimeFormat is expensive to construct and these are
       called per row, per render. */
    _istParts: null,
    istParts: function (v) {
      var d = v instanceof Date ? v : (v ? new Date(v) : null);
      if (!d || isNaN(d)) return null;
      if (!U._istParts) {
        U._istParts = new Intl.DateTimeFormat('en-US', {
          timeZone: U.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
      }
      var out = {};
      U._istParts.formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
      // 24-hour formatting gives midnight as '24' in some ICU builds.
      if (out.hour === '24') out.hour = '00';
      return out;
    },

    /* The IST calendar day an instant fell on, as MM-DD-YYYY. */
    stampDate: function (v) {
      var p = U.istParts(v);
      return p ? p.month + '-' + p.day + '-' + p.year : '-';
    },

    /* The same day as a plain 'YYYY-MM-DD' - the form calendar dates are stored
       in. For turning a moment into the day it happened on, which is the one
       legitimate crossing between the two kinds of date on this page. */
    stampISO: function (v) {
      var p = U.istParts(v);
      return p ? p.year + '-' + p.month + '-' + p.day : '';
    },

    /* The time of day it happened, in IST, 24-hour. */
    stampTime: function (v) {
      var p = U.istParts(v);
      return p ? p.hour + ':' + p.minute : '';
    },

    /* Both, labelled - so a figure on screen is never ambiguous about which
       clock it is on. */
    stamp: function (v) {
      var p = U.istParts(v);
      if (!p) return '-';
      return p.month + '-' + p.day + '-' + p.year + ' ' +
             p.hour + ':' + p.minute + ' ' + U.TZ_LABEL;
    },

    /* ISO -> MM-DD-YYYY for an input's value ('' rather than '-' when unset). */
    dateToInput: function (iso) {
      var s = U.date(iso);
      return s === '-' ? '' : s;
    },

    /* MM-DD-YYYY -> ISO. Returns '' when incomplete, null when the date does
       not exist (13-45-2026), so callers can tell "empty" from "invalid". */
    inputToDate: function (text) {
      var s = String(text == null ? '' : text).trim();
      if (!s) return '';
      var m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(s);
      if (!m) return null;
      var mo = +m[1], da = +m[2], yr = +m[3];
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      var dt = new Date(yr, mo - 1, da);
      // Rejects 02-30-2026, which Date would silently roll into March.
      if (dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;
      return yr + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
    },

    today: function () {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0');
    },

    esc: function (t) {
      if (t == null) return '';
      return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    /* For values going into a single-quoted inline handler argument. */
    escAttr: function (t) {
      return U.esc(t).replace(/\n/g, ' ');
    },

    /* A URL somebody typed, if it is one you can safely put in an href.
     *
     * esc() escapes the quotes, which stops the attribute being broken out of -
     * and does nothing at all about the scheme. `javascript:alert(1)` survives
     * escaping intact and runs on click, in the page's own origin, and so does
     * a `data:text/html` document. Every link in this app is typed or pasted by
     * a user, so the scheme has to be checked rather than assumed.
     *
     * An allow-list of two, because those are the two that answer the question
     * "can this be opened in a new tab". Anything else - including a blank, a
     * bare `example.com` with no scheme, or a mailto: - comes back null, and
     * the caller draws something that is not a link.
     *
     * Being an allow-list rather than a block-list is the point. A browser
     * ignores whitespace and control characters when it resolves a URL, so a
     * "javascript:" with a newline dropped into the middle of it is a live
     * script to the browser and an unknown scheme to any check that hunts for
     * the bad ones by name. Asking instead whether it *starts* as http(s) has
     * no such gap: the worst it can do is refuse a mangled link that would not
     * have opened anyway. */
    safeUrl: function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      return /^https?:\/\/\S/i.test(s) ? s : null;
    },

    n: function (v) {
      if (v === '' || v == null) return 0;
      var x = Number(v);
      return isNaN(x) ? 0 : x;
    },
    /* Null-safe lowercase for filters - several seeded bids have empty fields. */
    low: function (v) { return String(v == null ? '' : v).toLowerCase(); },

    $: function (id) { return document.getElementById(id); },

    /* Allow only the tags the proposal editor's toolbar can produce. */
    sanitizeHTML: function (html) {
      var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, UL: 1, OL: 1, LI: 1, BR: 1, P: 1, DIV: 1, SPAN: 1 };
      var tmp = document.createElement('div');
      tmp.innerHTML = String(html == null ? '' : html);
      (function walk(node) {
        var kids = Array.prototype.slice.call(node.childNodes);
        kids.forEach(function (c) {
          if (c.nodeType === 1) {
            if (!ALLOWED[c.tagName]) {
              while (c.firstChild) node.insertBefore(c.firstChild, c);
              node.removeChild(c);
              return;
            }
            Array.prototype.slice.call(c.attributes).forEach(function (a) {
              c.removeAttribute(a.name);
            });
            walk(c);
          } else if (c.nodeType !== 3) {
            node.removeChild(c);
          }
        });
      })(tmp);
      return tmp.innerHTML;
    },

    /* Accepts either the array form or the HTML string form the v3 proposal
       schema allows for terms/inclusions/details. */
    toHTMLList: function (v) {
      if (Array.isArray(v)) {
        return '<ul>' + v.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul>';
      }
      return typeof v === 'string' ? v : '';
    },

    /* A date field that actually reads MM-DD-YYYY.

       <input type="date"> renders in whatever order the browser's locale wants
       (dd-mm-yyyy on this machine) and that is not overridable from the page.
       So the visible control is a text box we format ourselves - and the
       calendar behind the button is the app's own, js/datepicker.js, which
       reads the same way round as the field it fills in. It used to be a hidden
       native date input opened purely to borrow the browser's popup, which
       meant the field said MM-DD-YYYY and the calendar it opened said
       dd-mm-yyyy, on the same screen, for the same date. */
    /* `onchange` is optional and is inline handler source, for the callers that
       write a date straight to the record rather than reading every field back
       on submit. The calendar popup dispatches a bubbling change event on this
       same text input (see openDatePicker), so picking a date and typing one
       both arrive the same way. */
    dateFieldHTML: function (id, iso, cls, onchange) {
      return '<div class="relative">' +
        '<input type="text" id="' + id + '" value="' + U.esc(U.dateToInput(iso)) + '" ' +
          'placeholder="MM-DD-YYYY" maxlength="10" inputmode="numeric" autocomplete="off" ' +
          (onchange ? 'onchange="' + onchange + '" ' : '') +
          // Read at call time, not load time: js/ui.js is loaded after this
          // file, so UI does not exist yet while these definitions are running.
          'class="' + (cls || root.UI.CONTROL) + ' pr-9">' +
        '<button type="button" onclick="U.openDatePicker(\'' + id + '\')" tabindex="-1" ' +
          'title="Open calendar" class="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-brand">' +
          '<i class="fas fa-calendar-alt text-xs"></i></button>' +
        '</div>';
    },

    /* The one entry point to the calendar. Every date field in the app is built
       by dateFieldHTML above or calls this directly, so swapping what happens
       here changed all of them at once.

       `o` is passed through to DatePicker.open - { mark, markLabel, onPick } -
       which is how the revised due date shows the original on the grid. */
    openDatePicker: function (id, o) {
      var text = typeof id === 'string' ? U.$(id) : id;
      if (!text || !root.DatePicker) return;
      root.DatePicker.open(text, o);
    },

    /* Types the dashes for you and flags a date that cannot exist. */
    wireDateField: function (id) {
      var el = U.$(id);
      if (!el || el.dataset.dateWired) return;
      el.dataset.dateWired = '1';

      el.addEventListener('input', function () {
        var digits = el.value.replace(/\D/g, '').slice(0, 8);
        var out = digits.slice(0, 2);
        if (digits.length > 2) out += '-' + digits.slice(2, 4);
        if (digits.length > 4) out += '-' + digits.slice(4, 8);
        // Only rewrite while adding, so backspacing over a dash still works.
        if (out.length >= el.value.length) el.value = out;
        el.classList.remove('border-danger', 'bg-danger-soft');
      });

      el.addEventListener('blur', function () {
        var iso = U.inputToDate(el.value);
        if (iso === null) {
          el.classList.add('border-danger', 'bg-danger-soft');
        } else {
          el.classList.remove('border-danger', 'bg-danger-soft');
          el.value = U.dateToInput(iso);
        }
      });
    },

    /* Reads a wired date field back as ISO. Invalid text yields ''. */
    readDateField: function (id) {
      var el = U.$(id);
      if (!el) return '';
      return U.inputToDate(el.value) || '';
    },

    setDateField: function (id, iso) {
      var el = U.$(id);
      if (el) {
        el.value = U.dateToInput(iso);
        el.classList.remove('border-danger', 'bg-danger-soft');
      }
    },

    debounce: function (fn, ms) {
      var t;
      return function () {
        var args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    },

    toast: function (msg, kind) {
      var host = U.$('toastHost');
      if (!host) return;
      var colors = {
        ok: 'bg-ok', warn: 'bg-amber-600',
        err: 'bg-red-600', info: 'bg-chrome'
      };
      var el = document.createElement('div');
      el.className = 'text-white text-sm px-4 py-2.5 rounded-lg shadow-lg animate-fade-in ' +
        (colors[kind] || colors.info);
      el.textContent = msg;
      host.appendChild(el);
      setTimeout(function () {
        el.style.transition = 'opacity .3s';
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 300);
      }, kind === 'err' ? 6000 : 2600);
    }
  };

  root.U = U;
})(window);
