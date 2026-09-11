/* presence.js - who else is in here.
 *
 * The shared server has always known who is connected: js/remote.js receives a
 * `presence` event on every join and leave, and until now nothing listened to
 * it. What it did not know was what any of them had OPEN, which is the part
 * worth telling people - two estimators on one project, each unaware of the
 * other, is how one of them loses an afternoon to the other's save.
 *
 * So this does two things: it tells the server which bid this window is looking
 * at, and it answers "who else is on that one" for the two places that show it -
 * the project header and the bids table.
 *
 * OFF THE SERVER IT IS ALL NOTHING. On a laptop opening the file directly, in
 * the test harness, or before anybody has signed in, there is no stream, nobody
 * else to be, and every function here quietly does nothing. Nothing that calls
 * it needs to know which case it is in.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var others = [];        // one entry per OTHER connection: {userId,name,initials,where}
  var mine = null;        // the bid this window is on, so a reconnect can say so again

  function remote() {
    return root.Remote && root.Store && root.Store.backend === 'server' ? root.Remote : null;
  }

  function meId() {
    return root.Auth && root.Auth.user ? root.Auth.user.id : null;
  }

  /* ---- telling the server ------------------------------------------------ */

  /* Called from the one place that knows: App.switchTab, after the page it is
     switching to is on screen. A bid id of null means "not on a project", which
     is a position too - it is how the marker clears when somebody leaves. */
  function here(bidId, section) {
    mine = bidId == null ? null : { bidId: bidId, section: section || null };
    var r = remote();
    if (r) r.where(bidId, section);
  }

  /* ---- hearing about everybody else -------------------------------------- */

  /* One entry per connection arrives; two tabs belonging to one person are two
     entries. Our own are dropped here rather than at the point of use: this
     window knows what it has open, and "also here: yourself" is nonsense.

     A person with the same project open in two windows is still one person, so
     they are folded together by user - but only after their own are removed,
     or somebody with two tabs would hide themselves from themselves. */
  function adopt(list) {
    var me = meId();
    var seen = {};
    others = [];
    (list || []).forEach(function (c) {
      if (!c || (me != null && c.userId === me)) return;
      var key = (c.userId == null ? 'c' + c.clientId : 'u' + c.userId) +
        '@' + (c.where ? c.where.bidId : '-');
      if (seen[key]) return;
      seen[key] = true;
      others.push(c);
    });
    repaint();
  }

  /* Presence changes when somebody opens a project or closes a window, which is
     rare and never while you are typing - so a repaint is affordable and there
     is no need to be clever about which parts of the screen changed. */
  function repaint() {
    if (root.Project && root.Nav && root.Nav.current.module === 'project') {
      root.Project.renderHeader();
    }
    if (root.Bids && root.App && /^(all|active|awarded)$/.test(root.App.currentTab)) {
      root.Bids.filterTable();
    }
  }

  /* ---- what the screen asks ---------------------------------------------- */

  function on(bidId) {
    if (bidId == null) return [];
    return others.filter(function (c) {
      return c.where && String(c.where.bidId) === String(bidId);
    });
  }

  function badge(c) {
    var s = String(c.initials || c.name || '?').trim();
    if (c.initials) return s.slice(0, 3).toUpperCase();
    return s.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* The colour the rest of the app knows this person by, looked up through the
     engineers register on their initials. Somebody with no entry there - a
     connection from a browser that has not signed in - gets the grey. */
  function colorClass(c) {
    if (!root.Bids || !root.Bids.colorClass) return 'pal-none';
    return root.Bids.colorClass(badge(c));
  }

  function names(list) {
    return list.map(function (c) { return c.name || badge(c); }).join(', ');
  }

  /* The chip on the project header: who else has this project open, right now.
     Deliberately not a warning - nobody is locked out and nothing is blocked.
     The app merges two people's edits and says who made them; this is so you
     know to walk over and ask first. */
  function headerChip(bidId) {
    var list = on(bidId);
    if (!list.length) return '';
    return '<span class="flex items-center gap-1.5 pl-2.5 pr-3 py-1 rounded-full bg-chrome-soft/70" ' +
        'title="' + U.escAttr(names(list) + ' ' + (list.length === 1 ? 'is' : 'are') +
        ' looking at this project now') + '">' +
      '<i class="fas fa-eye text-3xs text-faint"></i>' +
      // Their own colour - the one their initials carry in the Engineer column
      // and their hours carry in the calendar. Solid rather than tinted: this
      // sits on the dark header, where a wash of colour at 16% is nothing.
      list.slice(0, 3).map(function (c) {
        return '<span class="presence-dot ' + colorClass(c) + ' w-5 h-5 rounded-full ' +
          'text-3xs font-bold flex items-center justify-center">' + U.esc(badge(c)) + '</span>';
      }).join('') +
      (list.length > 3 ? '<span class="text-3xs text-faint">+' + (list.length - 3) + '</span>' : '') +
    '</span>';
  }

  /* The marker in the bids table, beside the takeoff and proposal icons that are
     already in the project cell. Small on purpose: it is a note, not a state of
     the record. */
  function rowMark(bidId) {
    var list = on(bidId);
    if (!list.length) return '';
    // One person, in their colour; several, in the brand's, since a marker
    // cannot be two colours at once.
    return '<i class="fas fa-eye text-3xs ' +
      (list.length === 1 ? 'presence-eye ' + colorClass(list[0]) : 'text-brand') + '" title="' +
      U.escAttr(names(list) + ' ' + (list.length === 1 ? 'has' : 'have') +
      ' this project open now') + '"></i>';
  }

  /* ---- wiring ------------------------------------------------------------ */

  /* Called once from App.init, after the store has opened and therefore after
     the backend is known. */
  function start() {
    var r = remote();
    if (!r) return;
    r.onPresence(adopt);
    // The stream may already have said hello before this was wired, in which
    // case the first list arrives on the next change. Say where we are now, so
    // everybody else's screen is right even if we never move.
    if (mine) r.where(mine.bidId, mine.section);
  }

  root.Presence = {
    start: start,
    here: here,
    on: on,
    headerChip: headerChip,
    rowMark: rowMark,
    /* For tests and for anything that wants the raw list. */
    get others() { return others.slice(); },
    adopt: adopt
  };
})(window);
