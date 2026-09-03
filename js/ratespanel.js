/* ratespanel.js - the "Labour, Equipment & Markup" grid, rendered once and used
 * in two places:
 *
 *   Rate Library  -> the shop-wide defaults (js/ratelib.js)
 *   TakeOff       -> one project's overrides of them (js/takeoff.js)
 *
 * The two differ only in where a value comes from and what happens when you
 * change it, so the caller passes a `scope` and the layout stays in one file.
 *
 * scope = {
 *   title, subtitle,          headings
 *   get(key)      -> value shown in the field
 *   isOverridden(key) -> true to paint it amber with a reset arrow
 *   setter(key)   -> the onchange attribute for a field
 *   resetter(key) -> the onclick attribute for the reset arrow, or null
 *   headerRight   -> optional HTML for the top-right corner
 *   footer        -> optional HTML below the grid
 * }
 */
(function (root) {
  'use strict';

  var U = root.U;

  /* Two rows, matching how the numbers are actually reasoned about: money per
     unit first, then the percentages and the hour formulas that derive from LF. */
  var MONEY = [
    ['Finish / LF', 'finishPerLF'],
    ['Engineering / hr', 'engineeringRate'],
    ['Fabrication / hr', 'fabricationRate'],
    ['Installation / hr', 'installationRate'],
    ['Supervisor / hr', 'supervisorRate'],
    ['Forklift / day', 'forkliftPerDay'],
    ['Truck / day', 'truckPerDay']
  ];

  var FACTORS = [
    ['Markup', 'markupPct', '%', '0.1'],
    ['Overhead', 'overheadPct', '%', '0.1'],
    ['Eng factor / LF', 'engFactor'],
    ['Eng base hrs', 'engBase'],
    ['Fab factor / LF', 'fabFactor'],
    ['Fab base hrs', 'fabBase'],
    ['Install factor / LF', 'instFactor'],
    ['Install base hrs', 'instBase']
  ];

  function field(scope, label, key, unit, step) {
    var v = scope.get(key);
    var over = scope.isOverridden ? scope.isOverridden(key) : false;
    var reset = over && scope.resetter ? scope.resetter(key) : null;

    return '<div>' +
      '<label class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider mb-1 ' +
        (over ? 'text-amber-700' : 'text-slate-500') + '">' +
        '<span class="truncate">' + label + '</span>' +
        (reset ? '<button onclick="' + reset + '" title="Use the shop default again" ' +
          'class="text-amber-600 hover:text-amber-800 shrink-0"><i class="fas fa-undo text-[9px]"></i></button>' : '') +
      '</label>' +
      '<div class="flex items-center gap-1">' +
        (unit === '$' ? '<span class="text-slate-400 text-xs">$</span>' : '') +
        '<input type="number" step="' + (step || 'any') + '" value="' + (v == null ? '' : v) + '" ' +
          'onchange="' + scope.setter(key) + '" ' +
          'class="w-full px-2 py-1.5 border rounded-lg text-sm text-right font-mono outline-none focus:border-blue-400 ' +
          // Same amber-means-overridden language as the typed-over formula hours
          // on Cost & Labour, so there is one idea to learn rather than two.
          (over ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-slate-50 border-slate-200') + '">' +
        (unit === '%' ? '<span class="text-slate-400 text-xs">%</span>' : '') +
      '</div></div>';
  }

  root.RatesPanel = {
    MONEY: MONEY,
    FACTORS: FACTORS,
    KEYS: MONEY.map(function (r) { return r[1]; })
      .concat(FACTORS.map(function (r) { return r[1]; })),

    render: function (scope) {
      return '<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5 mb-6">' +
        '<div class="flex items-center justify-between gap-3 mb-4 flex-wrap">' +
          '<div><h3 class="text-sm font-bold text-slate-800">' +
            '<i class="fas fa-sliders-h text-blue-500 mr-2"></i>' + scope.title + '</h3>' +
            (scope.subtitle ? '<p class="text-[11px] text-slate-500 mt-0.5">' + scope.subtitle + '</p>' : '') +
          '</div>' +
          (scope.headerRight || '') +
        '</div>' +
        '<div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">' +
          MONEY.map(function (r) { return field(scope, r[0], r[1], '$'); }).join('') +
        '</div>' +
        '<div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 pt-4 border-t border-slate-100">' +
          FACTORS.map(function (r) { return field(scope, r[0], r[1], r[2], r[3]); }).join('') +
        '</div>' +
        (scope.footer || '') +
        '</div>';
    }
  };
})(window);
