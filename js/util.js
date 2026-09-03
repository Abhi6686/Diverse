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

    /* ISO -> MM-DD-YYYY for display. */
    date: function (d) {
      var dt = U.parseDate(d);
      if (!dt) return '-';
      var mm = String(dt.getMonth() + 1).padStart(2, '0');
      var dd = String(dt.getDate()).padStart(2, '0');
      return mm + '-' + dd + '-' + dt.getFullYear();
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
       So the visible control is a text box we format ourselves, backed by a
       hidden native date input purely to borrow its calendar popup. */
    dateFieldHTML: function (id, iso, cls) {
      return '<div class="relative">' +
        '<input type="text" id="' + id + '" value="' + U.esc(U.dateToInput(iso)) + '" ' +
          'placeholder="MM-DD-YYYY" maxlength="10" inputmode="numeric" autocomplete="off" ' +
          'class="' + (cls || 'w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:border-blue-400 outline-none') + ' pr-9">' +
        '<input type="date" id="' + id + '__picker" tabindex="-1" aria-hidden="true" ' +
          'class="absolute opacity-0 pointer-events-none w-0 h-0 right-8 bottom-0">' +
        '<button type="button" onclick="U.openDatePicker(\'' + id + '\')" tabindex="-1" ' +
          'title="Open calendar" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-blue-600">' +
          '<i class="fas fa-calendar-alt text-xs"></i></button>' +
        '</div>';
    },

    openDatePicker: function (id) {
      var text = U.$(id), picker = U.$(id + '__picker');
      if (!text || !picker) return;
      picker.value = U.inputToDate(text.value) || '';
      picker.onchange = function () {
        text.value = U.dateToInput(picker.value);
        text.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // showPicker is Chrome/Edge/Safari 16+; older engines just get the field.
      if (typeof picker.showPicker === 'function') {
        try { picker.showPicker(); return; } catch (e) { /* fall through */ }
      }
      text.focus();
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
        el.classList.remove('border-red-400', 'bg-red-50');
      });

      el.addEventListener('blur', function () {
        var iso = U.inputToDate(el.value);
        if (iso === null) {
          el.classList.add('border-red-400', 'bg-red-50');
        } else {
          el.classList.remove('border-red-400', 'bg-red-50');
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
        el.classList.remove('border-red-400', 'bg-red-50');
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
        ok: 'bg-emerald-600', warn: 'bg-amber-600',
        err: 'bg-red-600', info: 'bg-slate-800'
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
