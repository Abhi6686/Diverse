/* schedule.js - the calendar behind the Employee view.
 *
 * Turns the day bookings on a bid's assignment rows (see js/assignments.js)
 * into columns of a table. It owns the date arithmetic and nothing else - no
 * DOM, no state - so js/bidgrid.js can render a schedule without growing a
 * second personality, and so the awkward part (which day belongs where) can be
 * reasoned about on its own.
 *
 * THE ZOOM IS A WINDOW, NOT A BUCKET SIZE. Day shows today, Week shows this
 * week, Month shows this month - and all three are drawn as columns of single
 * days, because a day is the unit hours are actually booked in and the point of
 * the view is to see which day somebody is on. Zooming out shows more days at
 * once; it does not stop showing days.
 *
 * (It used to aggregate instead - a week was one column holding a week of
 * hours. That answered "how loaded is next week" but not "what am I doing on
 * Thursday", and the second question is the one the view gets opened for.)
 *
 * A period is still a half-open range [start, end), so no booking can fall
 * between two columns or be counted by both, and the same cell function serves
 * every zoom.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var ZOOMS = {
    day:   { label: 'Day',   icon: 'fa-calendar-day',   step: 'a day' },
    week:  { label: 'Week',  icon: 'fa-calendar-week',  step: 'a week' },
    month: { label: 'Month', icon: 'fa-calendar-days',  step: 'a month' }
  };

  var FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

  /* ---- dates as plain ISO strings ---------------------------------------- */

  /* Everything here works in 'YYYY-MM-DD', the way bookings are stored. These
     are calendar days, not instants, so they never go near a timezone - see the
     note on U.date. */
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function parse(s) { return U.parseDate(s); }

  function shift(s, n) {
    var d = parse(s);
    if (!d) return s;
    d.setDate(d.getDate() + n);
    return iso(d);
  }

  function today() { return U.today(); }

  function isWeekend(s) {
    var d = parse(s);
    if (!d) return false;
    return d.getDay() === 0 || d.getDay() === 6;
  }

  /* The Monday of the week a date falls in. Weeks start Monday because the
     working week does, and a strip that started on Sunday would split every
     week in half down the middle of the useful part. */
  function weekStart(s) {
    var d = parse(s);
    if (!d) return s;
    var back = (d.getDay() + 6) % 7;
    return shift(s, -back);
  }

  function monthStart(s) {
    var d = parse(s);
    return d ? iso(new Date(d.getFullYear(), d.getMonth(), 1)) : s;
  }

  /* ISO 8601 week number, so "Wk 29" means the same thing here as on a
     calendar on the wall. */
  function weekNumber(s) {
    var d = parse(s);
    if (!d) return 0;
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
    var firstThursday = new Date(t.getFullYear(), 0, 4);
    firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
    return 1 + Math.round((t - firstThursday) / (7 * 86400000));
  }

  /* ---- what is booked ---------------------------------------------------- */

  /* Every dated booking on a bid, flattened. One row per engineer per day, so
     a bid with two people on the same Tuesday yields two. */
  function bookings(bid) {
    var out = [];
    root.Assign.rows(bid).forEach(function (r) {
      root.Assign.dayRows(r).forEach(function (d) {
        if (!d.date) return;
        out.push({ engineer: r.engineer || '', date: d.date, hrs: U.n(d.hrs),
                   taskType: r.taskType || '' });
      });
    });
    return out;
  }

  function monthEnd(s) {
    var d = parse(s);
    return d ? iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) : s;
  }

  /* ---- the window -------------------------------------------------------- */

  /* The zoom picks how much calendar is on screen; the anchor picks where. Both
     are held by the grid (in the saved layout) rather than here, so this module
     stays a pure function of the two. */
  function anchorOf(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : today();
  }

  /* Inclusive [from, to] - the first and last day shown. */
  function windowOf(zoom, anchor) {
    var a = anchorOf(anchor);
    if (zoom === 'week') { var w = weekStart(a); return { from: w, to: shift(w, 6) }; }
    if (zoom === 'month') return { from: monthStart(a), to: monthEnd(a) };
    return { from: a, to: a };
  }

  /* Back or forward by one of whatever is on screen, so the control does the
     obvious thing at every zoom: a day, a week, a month.

     Stepping a month works off the 1st rather than the anchor itself, or
     "next month" from the 31st of January lands in March. */
  function step(zoom, anchor, dir) {
    var a = anchorOf(anchor);
    var n = dir < 0 ? -1 : 1;
    if (zoom === 'week') return shift(weekStart(a), 7 * n);
    if (zoom === 'month') {
      var d = parse(monthStart(a));
      return iso(new Date(d.getFullYear(), d.getMonth() + n, 1));
    }
    return shift(a, n);
  }

  /* What the window is called, above the calendar. Says the year, because a
     schedule you have paged three months forward on should not be able to lie
     about which year it is showing. */
  function windowLabel(zoom, anchor) {
    var w = windowOf(zoom, anchor);
    var f = parse(w.from);
    if (zoom === 'month') return FULL_MONTHS[f.getMonth()] + ' ' + f.getFullYear();
    if (zoom === 'week') {
      var t = parse(w.to);
      var span = MONTH_NAMES[f.getMonth()] + ' ' + f.getDate() + ' - ' +
        (f.getMonth() === t.getMonth() ? '' : MONTH_NAMES[t.getMonth()] + ' ') + t.getDate();
      return 'Wk ' + weekNumber(w.from) + ' · ' + span + ' ' + t.getFullYear();
    }
    return DAY_NAMES[f.getDay()] + ' ' + MONTH_NAMES[f.getMonth()] + ' ' +
      f.getDate() + ', ' + f.getFullYear();
  }

  /* True when the window contains today - so the control that jumps back to now
     can be shown as already there rather than offered pointlessly. */
  function isNowWindow(zoom, anchor) {
    var w = windowOf(zoom, anchor);
    var n = today();
    return n >= w.from && n <= w.to;
  }

  /* ---- the columns ------------------------------------------------------- */

  /* The visible days, as half-open [start, end) ranges. `key` is stable so the
     grid can use it as a column key; `label` and `sub` are the two lines of the
     heading. `isWeekStart` marks the Mondays, which is what keeps a month of
     columns readable. */
  function periods(zoom, anchor) {
    var w = windowOf(zoom, anchor);
    var out = [];
    var now = today();
    var d = w.from;
    var guard = 0;

    while (d <= w.to && guard++ < 400) {
      out.push({
        key: 'p-' + d, start: d, end: shift(d, 1),
        label: DAY_NAMES[parse(d).getDay()],
        sub: String(parse(d).getDate()),
        isWeekend: isWeekend(d),
        isWeekStart: parse(d).getDay() === 1,
        isNow: d === now
      });
      d = shift(d, 1);
    }
    return out;
  }

  /* Has this bid got anybody booked inside the window? The Employee view is a
     list of what is happening in the period on screen, so a bid with nothing in
     it is not a row with empty cells - it is a row that does not belong. */
  function hasWorkIn(bid, zoom, anchor) {
    var w = windowOf(zoom, anchor);
    return bookings(bid).some(function (k) {
      return k.date >= w.from && k.date <= w.to && k.hrs;
    });
  }

  /* ---- reading the bookings into the columns ----------------------------- */

  /* THE INDEX, BUILT ONCE PER RENDER.
   *
   * Every figure the schedule shows is "hours on this bid, for this person, in
   * these dates", asked once per cell. Answering it by walking the bid's
   * bookings each time is fine for two rows and not fine for ninety-five: a
   * month of columns asks it thirty-one times a line, plus as many again for
   * the totals row, and each answer rebuilds the booking list from scratch.
   *
   * So the bookings are turned into lookup tables in one pass and every
   * accessor reads those. The three named functions below are wrappers over the
   * same index, so there is one implementation of what a period contains and no
   * second one to drift from it.
   */
  function plan(bids) {
    var perEngineer = {};   // bidId -> engineer -> date -> hrs
    var perBid = {};        // bidId -> date -> hrs
    var perDay = {};        // date -> hrs

    (bids || []).forEach(function (b) {
      if (!b) return;
      var eng = perEngineer[b.id] || (perEngineer[b.id] = {});
      var bid = perBid[b.id] || (perBid[b.id] = {});
      bookings(b).forEach(function (k) {
        if (!k.hrs) return;
        var days = eng[k.engineer] || (eng[k.engineer] = {});
        days[k.date] = (days[k.date] || 0) + k.hrs;
        bid[k.date] = (bid[k.date] || 0) + k.hrs;
        perDay[k.date] = (perDay[k.date] || 0) + k.hrs;
      });
    });

    /* Half-open [start, end), so a booking on the last day of a period belongs
       to that period and not the next, and none is counted by both. Periods are
       single days at every zoom today; this still walks the range, so it stays
       correct if that ever stops being true. */
    function sum(table, period) {
      if (!table) return 0;
      var total = 0, d = period.start, guard = 0;
      while (d < period.end && guard++ < 400) {
        total += table[d] || 0;
        d = shift(d, 1);
      }
      return total;
    }

    return {
      hours: function (bid, engineer, period) {
        var eng = bid && perEngineer[bid.id];
        return sum(eng && eng[engineer], period);
      },
      bidHours: function (bid, period) {
        return sum(bid && perBid[bid.id], period);
      },
      total: function (period) { return sum(perDay, period); }
    };
  }

  /* Hours this engineer has on this bid inside this period. The empty string is
     a real key: work booked to a row nobody is named on is still work, and it
     is looked up the same way as anybody else's. */
  function hoursFor(bid, engineer, period) {
    return plan([bid]).hours(bid, engineer, period);
  }

  /* Everybody's hours on this bid in this period, whoever they are. */
  function bidHoursFor(bid, period) {
    return plan([bid]).bidHours(bid, period);
  }

  /* The shop's load in a period, across every bid on screen. This is the row
     that makes the view worth opening: it is where next week being
     overcommitted is visible without adding anything up. */
  function totalFor(bids, period) {
    return plan(bids).total(period);
  }

  /* ---- how loaded is that ------------------------------------------------ */

  /* A working day is eight hours. A week and a month are that times their
     working days, so the same "is this too much" question can be asked at every
     zoom without the answer changing meaning. */
  var HOURS_PER_DAY = 8;

  function workingDaysIn(period) {
    var n = 0, d = period.start, guard = 0;
    while (d < period.end && guard++ < 400) {
      if (!isWeekend(d)) n++;
      d = shift(d, 1);
    }
    return n;
  }

  function capacityOf(period, people) {
    return workingDaysIn(period) * HOURS_PER_DAY * Math.max(1, people || 1);
  }

  /* 0 for nothing booked, rising to 3 for over capacity. The grid turns this
     into a wash, so an overbooked day is visible without reading the figure. */
  function loadLevel(hours, period, people) {
    if (!hours) return 0;
    var cap = capacityOf(period, people);
    if (!cap) return 1;
    var ratio = hours / cap;
    if (ratio > 1) return 3;
    if (ratio > 0.75) return 2;
    return 1;
  }

  root.Schedule = {
    ZOOMS: ZOOMS,
    HOURS_PER_DAY: HOURS_PER_DAY,
    periods: periods,
    windowOf: windowOf,
    windowLabel: windowLabel,
    isNowWindow: isNowWindow,
    anchorOf: anchorOf,
    hasWorkIn: hasWorkIn,
    step: step,
    today: today,
    bookings: bookings,
    plan: plan,
    hoursFor: hoursFor,
    bidHoursFor: bidHoursFor,
    totalFor: totalFor,
    loadLevel: loadLevel,
    capacityOf: capacityOf,
    workingDaysIn: workingDaysIn,
    weekNumber: weekNumber,
    weekStart: weekStart,
    isWeekend: isWeekend
  };
})(window);
