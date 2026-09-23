/* bidgrid.js - the Bids table.
 *
 * One column-definition array is the single source of truth for the heading,
 * its alignment, how the cell renders, how the column sorts and how it filters.
 * The header, the body, the filter popovers and the column selector all read
 * from it, so adding a column is one entry rather than four edits that drift.
 */
(function (root) {
  'use strict';

  var U = root.U;

  function db() { return root.Store.db; }

  /* A bid nobody is going to work on any more, whichever way it went. */
  function decided(b) { return root.Bids.bucketOf(b) !== 'open'; }

  /* A RE-OPENED JOB SAYS SO WHEREVER ITS NUMBER APPEARS.
     Two entries on the table share a project name and differ by a suffix that
     is four characters at the end of a mono string - easy to read past. The
     tag is the thing that stops somebody working the finished one by mistake.
     Blank on a first entry: it was not a revision of anything. */
  function revisionTag(b) {
    if (!b || !b.revision) return '';
    return ' <span class="px-1 py-px rounded bg-warn-soft text-warn-ink text-3xs font-semibold ' +
      'align-middle" title="' + U.escAttr('Revision ' + b.revision + ' of ' +
        (b.revisionBase || 'this project')) + '">' +
      U.esc(root.Bids.revisionNoText(b.revision)) + '</span>';
  }

  /* Hours cells all look the same; zero prints as a dash so a column of real
     figures is not buried in noughts. */
  function hrs(v, cls) {
    var n = U.n(v);
    return '<span class="font-mono text-xs ' + (cls || 'text-muted') + '">' +
      (n ? U.qty(n) : '<span class="text-faint">&mdash;</span>') + '</span>';
  }

  /* ---- column definitions ---------------------------------------------- */

  /* type drives both sorting and the filter UI:
       text   - contains box
       enum   - checkbox list of the distinct values, with counts
       multi  - same, but the field is an array (products)
       number - numeric compare, contains box
       date   - ISO compare, contains box
       none   - neither sortable nor filterable (Actions) */
  var COLUMNS = [
    /* ACTIONS LEAD, AND THEY ARE ONE BUTTON.

       They used to trail every row, which put them at the far right of a table
       wide enough to scroll - so reaching them meant scrolling away from the
       project name, and the column was wide enough doing it to be most of why
       the table scrolled at all. At the front and frozen they are always under
       the cursor, and one menu is narrower than six icons and says what each
       thing does in words instead of a tooltip.

       Not sortable and not filterable: there is nothing in here to sort by. */
    { key: 'actions', label: '', align: 'center', type: 'none', locked: true,
      width: 'w-12', sticky: 48,
      render: function (b) { return root.Bids.actionCell(b); } },
    /* Counts the rows on screen, 1..N. Not stored on the bid and not sortable:
       it IS the order the table is in, so it cannot fall out of sequence the
       way a saved ordinal did every time a bid was deleted. The number that
       identifies a project and follows it around is Proposal No. below. */
    /* `sticky` is the column's width in pixels, and marks it as part of the
       identity block - the row counter, whichever numbers the view shows, and
       the project name - which stays put while everything else scrolls
       sideways. Those four are exactly what tells you which row you are on, and
       they are already what each view leads with (see VIEW_COLUMNS), so
       freezing them changes no column order that anybody chose.

       The pixel width is needed rather than a class: the left offset of the
       second frozen column is the width of the first, and that is arithmetic
       that has to happen in JavaScript. */
    { key: 'sr', label: 'Sr. No.', align: 'center', type: 'none', width: 'w-14', sticky: 52,
      render: function (b, i) {
        return '<span class="font-mono text-xs text-faint">' + (i + 1) + '</span>';
      } },

    /* The project's identity. Unique across the register - saveBid refuses a
       duplicate - and it flows outward from the bid to its takeoff and its
       proposal document, so one project is one number everywhere it appears. */
    { key: 'proposalNo', label: 'Proposal No.', align: 'center', type: 'text', width: 'w-32', sticky: 116,
      value: function (b) { return U.low(b.proposalNo); },
      text: function (b) { return b.proposalNo || ''; },
      render: function (b) {
        return (b.proposalNo
          ? '<span class="font-mono text-xs font-semibold text-ink">' + U.esc(b.proposalNo) + '</span>'
          : '<span class="text-faint">&mdash;</span>') + revisionTag(b);
      } },

    /* WHICH TIME ROUND THIS IS. Off by default: most jobs are bid once and a
       column of blanks is not worth the width. Switched on - or sorted on -
       when the question is "what have we re-bid", which is the only question
       it answers. The first entry of a job is deliberately blank rather than
       Rev00: it was not a revision of anything. */
    { key: 'revision', label: 'Rev', align: 'center', type: 'number',
      width: 'w-16', offByDefault: true,
      value: function (b) { return b.revision ? U.n(b.revision) : null; },
      text: function (b) { return b.revision ? root.Bids.revisionNoText(b.revision) : ''; },
      render: function (b) {
        return b.revision ? revisionTag(b) : '<span class="text-faint">&mdash;</span>';
      } },

    /* THE JOB NO. COLUMN IS GONE. A project now carries one number for its whole
       life - issued when it is picked up, printed on the proposal, and the same
       number it is won under - so a second column beside Proposal No. would have
       shown the identical string. See Bids.nextProjectNo.

       When the enquiry arrived. All Bids is an arrival register and this is what
       it is read in order of, which is why it takes the Proposal No. slot there:
       a bid has no number until somebody picks it up, so on that list the number
       column could only ever have been a row of em-dashes. */
    { key: 'createdAt', label: 'Created', align: 'center', type: 'date',
      width: 'w-28', sticky: 116, offByDefault: true,
      // Sorted on the raw UTC ISO, which orders correctly as a plain string.
      // Shown and filtered in IST - see U.stamp. Slicing the date off the front
      // of the ISO would give the UTC day, which is the wrong one for the five
      // and a half hours after midnight IST.
      value: function (b) { return b.createdAt || ''; },
      text: function (b) { return U.stampDate(b.createdAt); },
      render: function (b) {
        if (!b.createdAt) return '<span class="text-faint">&mdash;</span>';
        // A backfilled date is a guess made from what else was known about the
        // bid, so it is not dressed up as an observation - and it carries no
        // time, because there is no hour to claim for a date that was inferred.
        if (b.createdAtInferred) {
          return '<span class="text-xs text-faint whitespace-nowrap" ' +
            'title="Estimated - this bid predates the arrival log">~ ' +
            U.stampDate(b.createdAt) + '</span>';
        }
        return '<span class="text-xs text-muted whitespace-nowrap block leading-tight">' +
          U.stampDate(b.createdAt) + '</span>' +
          '<span class="text-3xs text-faint whitespace-nowrap block leading-tight" ' +
            'title="' + U.escAttr(U.stamp(b.createdAt)) + '">' +
            U.stampTime(b.createdAt) + '</span>';
      } },

    /* The column you must be able to read to know which row you are on, so it
       anchors the frozen block: scrolling right to reach Status used to take
       the project name off the screen and leave a table of anonymous figures. */
    { key: 'project', label: 'Project', align: 'left', type: 'text', locked: true, sticky: 200,
      value: function (b) { return U.low(b.project); },
      text: function (b) { return b.project || ''; },
      render: function (b) {
        var short = b.comments ? b.comments.slice(0, 60) + (b.comments.length > 60 ? '...' : '') : '';
        return '<div class="font-semibold text-ink-strong text-sm flex items-center gap-1.5">' +
          U.esc(b.project) +
          (root.Takeoff.hasTakeoff(b) ? '<i class="fas fa-calculator text-3xs text-ok" title="Has a takeoff"></i>' : '') +
          (b.proposalId ? '<i class="fas fa-file-contract text-3xs text-brand" title="Has a proposal"></i>' : '') +
          // Somebody else has this project open right now. Beside the other two
          // marks, because it belongs to the same question: what is going on
          // with this row before I click into it.
          (root.Presence ? root.Presence.rowMark(b.id) : '') +
          '</div>' +
          (short ? '<div class="text-3xs text-faint mt-0.5">' + U.esc(short) + '</div>' : '');
      } },

    { key: 'portal', label: 'Portal', align: 'center', type: 'enum',
      value: function (b) { return b.portal || ''; },
      render: function (b) {
        return '<span class="px-2 py-0.5 bg-neutral-soft rounded text-xs font-medium text-muted">' +
          U.esc(b.portal) + '</span>';
      } },

    /* THE SITE ADDRESS HANGS OFF THE REGION, rather than taking a column of its
       own by default.

       An address is thirty to fifty characters and it is read once - when
       somebody is working out where the job is - while the region is a word and
       is read on every pass down the list. Given a column it would either be
       truncated to uselessness or push everything after it off the screen. So
       the region cell carries a pin when the bid has an address, and the pin
       opens the full thing with somewhere to copy it from and a map link. For
       anybody who does want it as a real column there is one in the picker,
       off by default - see VIEW_COLUMNS. */
    { key: 'region', label: 'Region', align: 'left', type: 'enum',
      value: function (b) { return b.region || ''; },
      render: function (b) {
        return U.esc(b.region || '-') +
          (b.location
            ? ' <button onclick="BidGrid.openLocation(event,' + b.id + ')" ' +
              'title="' + U.escAttr(b.location) + '" aria-label="Site address" ' +
              'class="text-faint hover:text-brand align-middle">' +
              '<i class="fas fa-location-dot text-3xs"></i></button>'
            : '') +
          (b.inRegion === false ? '<span class="block text-3xs text-warn">out of region</span>' : '');
      } },

    /* Off by default on every view; switched on from the column picker by
       anybody who sorts or filters by where the work is. */
    { key: 'location', label: 'Location', align: 'left', type: 'text',
      value: function (b) { return U.low(b.location); },
      text: function (b) { return b.location || ''; },
      render: function (b) {
        return b.location
          ? '<span class="text-xs text-muted block truncate max-w-[260px]" title="' +
            U.escAttr(b.location) + '">' + U.esc(b.location) + '</span>'
          : '<span class="text-faint">&mdash;</span>';
      } },

    { key: 'products', label: 'Product', align: 'left', type: 'multi',
      value: function (b) { return (b.products || []).join(', '); },
      values: function (b) { return (b.products || []).filter(Boolean); },
      render: function (b) { return root.Bids.productCell(b, 3); } },

    { key: 'material', label: 'Material', align: 'center', type: 'enum',
      value: function (b) { return b.material || ''; },
      render: function (b) {
        var cls = b.material === 'Carbon steel' ? 'bg-warn-soft text-warn-ink' :
          b.material === 'Aluminum' ? 'bg-brand-soft text-brand-ink' :
          b.material === 'Stainless steel' ? 'bg-neutral-soft text-ink' :
          b.material === 'Glass' ? 'bg-info-soft text-info-ink' : 'bg-raised text-muted';
        return '<span class="px-2 py-0.5 rounded text-3xs font-medium whitespace-nowrap ' + cls + '">' +
          U.esc(b.material || '-') + '</span>';
      } },

    /* Two columns headed "Engineer" and two pairs headed Estm/Asgn Hrs: one set
       for the intake stage and one for the team, and each view shows exactly
       one of them (see VIEW_COLUMNS). The headers match on purpose - on any
       given tab it reads as one column - so `panelLabel` disambiguates them in
       the column selector and the filter popover, where both are listed. */
    { key: 'engineer', label: 'Engineer', panelLabel: 'Engineer (intake)',
      align: 'center', type: 'enum',
      value: function (b) { return b.engineer || ''; },
      render: function (b) { return root.Bids.engineerCell(b); } },

    { key: 'team', label: 'Engineer', panelLabel: 'Engineer (team)',
      align: 'center', type: 'multi',
      value: function (b) { return root.Assign.engineerList(b).join(', '); },
      values: function (b) { return root.Assign.engineerList(b); },
      // Narrowed to whoever the Engineer filter names, so this column agrees
      // with the Task column beside it. The Employee view draws its own stack
      // from scheduleLines and never reaches here - see render().
      render: function (b) { return root.Bids.teamCell(b, lineFilterInitials()); } },

    /* WHAT THAT PERSON IS DOING, beside the name doing it.
       The Engineer column said who was on a bid and nothing else, so "is the
       take-off finished" meant opening the project. One line per task here,
       lining up with the names to the left.

       Filtered on the task type - "show me every bid with an open Estimating
       task" - which is why it carries `values` rather than only a text value. */
    { key: 'task', label: 'Task', panelLabel: 'Task & status (team)',
      align: 'left', type: 'multi',
      value: function (b) {
        return root.Assign.rows(b).map(function (r) {
          return (r.taskType || '-') + ' (' + root.Assign.statusLabel(r) + ')';
        }).join(', ');
      },
      values: function (b) {
        var seen = {}, out = [];
        root.Assign.rows(b).forEach(function (r) {
          var v = r.taskType || '';
          if (!v || seen[v]) return;
          seen[v] = true;
          out.push(v);
        });
        return out;
      },
      render: function (b) { return taskStack(b); } },

    /* No LF column. Linear feet is a takeoff figure, not a property of the bid
       record: it is computed from the estimating sheet, it is meaningless on a
       bid nobody has estimated yet, and on the register it was a column of
       dashes. bid.lf is still written by the takeoff and still shown on the
       project page, where the takeoff it came from is next to it. */

    { key: 'price', label: 'Bid Price', align: 'right', type: 'number',
      value: function (b) { return b.price == null ? null : U.n(b.price); },
      render: function (b) {
        return '<span class="font-mono text-xs font-semibold text-ink-strong whitespace-nowrap">' +
          U.currency(b.price) +
          (b.priceLocked ? ' <i class="fas fa-lock text-3xs text-warn" title="Locked - a takeoff will not overwrite this"></i>' : '') +
          '</span>';
      } },

    /* The intake pair: the first-pass figures typed on the bid form while the
       bid is still on All Bids.

       There is deliberately no Total Hrs column beside them, nor beside the
       team pair below. Estm and Asgn measure the same work from two sides, so
       adding them counts the job twice - see Assign.totals. */
    { key: 'estHrs', label: 'Estm Hrs', panelLabel: 'Estm Hrs (intake)',
      align: 'right', type: 'number',
      value: function (b) { return U.n(b.estHrs); },
      render: function (b) { return hrs(b.estHrs); } },

    { key: 'assignedHrs', label: 'Asgn Hrs', panelLabel: 'Asgn Hrs (intake)',
      align: 'right', type: 'number',
      value: function (b) { return U.n(b.assignedHrs); },
      render: function (b) { return hrs(b.assignedHrs); } },

    /* The team pair: summed from the bid's assignments, never typed directly,
       so the column and the Team & Hours card cannot disagree. */
    { key: 'activeEstHrs', label: 'Estm Hrs', panelLabel: 'Estm Hrs (team)',
      align: 'right', type: 'number',
      value: function (b) { return root.Assign.totals(b).est; },
      render: function (b) { return hrs(root.Assign.totals(b).est); } },

    { key: 'activeAsgnHrs', label: 'Asgn Hrs', panelLabel: 'Asgn Hrs (team)',
      align: 'right', type: 'number',
      value: function (b) { return root.Assign.totals(b).asgn; },
      render: function (b) { return hrs(root.Assign.totals(b).asgn); } },

    /* Sorted, filtered and read on the date the project is actually working to
       - the revised one once the client has moved it.

       BOTH DATES ARE SHOWN, AND NEITHER IS STRUCK THROUGH. The original used to
       be crossed out under the revised one, which said it had been cancelled;
       it has not been - it is the date on the record, and the reason the
       revision is worth knowing about. So the date in force leads, and the
       original sits under it labelled as the original. */
    { key: 'dueDate', label: 'Due Date', align: 'center', type: 'date',
      // Sort on the ISO string: it is lexicographically ordered, unlike the
      // MM-DD-YYYY the cell displays.
      value: function (b) { return root.Bids.effectiveDueDate(b) || ''; },
      text: function (b) { return U.date(root.Bids.effectiveDueDate(b)); },
      render: function (b) {
        var effective = root.Bids.effectiveDueDate(b);
        var moved = String(b.revisedDueDate || '').trim() && b.dueDate &&
                    b.revisedDueDate !== b.dueDate;
        return '<span class="text-xs whitespace-nowrap ' +
          (moved ? 'text-warn-ink font-semibold' : 'text-muted') + '" ' +
          (moved ? 'title="Revised to ' + U.escAttr(U.date(effective)) +
                   ' from ' + U.escAttr(U.date(b.dueDate)) + '"' : '') + '>' +
          U.date(effective) + '</span>' +
          (moved ? '<span class="block text-3xs text-faint whitespace-nowrap">orig ' +
            U.date(b.dueDate) + '</span>' : '');
      } },

    { key: 'status', label: 'Status', align: 'center', type: 'enum',
      value: function (b) { return b.status || ''; },
      render: function (b) { return root.Bids.statusBadge(b.status); } },

    /* Only meaningful once a bid is decided, so off by default and turned on
       for the Awarded view below. "Decided" comes from the status table rather
       than a second list of status names that would drift from it. */
    { key: 'result', label: 'Result', align: 'center', type: 'enum', offByDefault: true,
      value: function (b) { return decided(b) ? b.status : ''; },
      render: function (b) {
        if (!decided(b)) return '<span class="text-faint">&mdash;</span>';
        return root.Bids.statusBadge(b.status);
      } },

    /* WHEN THIS BID LAST MOVED, AND WHO MOVED IT.
     *
     * Written by History.touch on every recorded change - so this column and
     * the top line of the History card are the same fact, and sorting on it
     * puts whatever the office worked on this morning at the top.
     *
     * SHOWN AS HOW LONG AGO, with the exact stamp on the hover. An absolute
     * timestamp is the right thing when reconciling one record and the wrong
     * thing in a column of forty: "09-22-2026 17:57 IST" has to be subtracted
     * from today before it means anything. Sorting is on the raw ISO, which
     * orders correctly as a plain string - see U.ago for why the days in it
     * are counted on the IST calendar rather than by dividing elapsed hours.
     *
     * Falls back to createdAt, so a bid nobody has touched since it was
     * entered reads as its own arrival rather than as a blank. */
    { key: 'lastModified', label: 'Last Modified', align: 'center', type: 'date',
      width: 'w-32',
      value: function (b) { return root.History.lastMovedAt(b); },
      text: function (b) { return U.stamp(root.History.lastMovedAt(b)); },
      render: function (b) {
        var at = root.History.lastMovedAt(b);
        if (!at) return '<span class="text-faint">&mdash;</span>';
        var who = b.updatedBy || '';
        return '<span class="text-xs text-muted whitespace-nowrap" title="' +
            U.escAttr(U.stamp(at) + (who ? ' · ' + who : '') +
              (b.updatedAt ? '' : ' (never edited - this is when it arrived)')) + '">' +
            U.esc(U.ago(at)) + '</span>' +
          (who
            ? '<span class="block text-3xs text-faint whitespace-nowrap">' +
              U.esc(who) + '</span>'
            : '');
      } },
  ];

  /* The heading is what the column says on the tab you are on; the panel name
     is what it is called where every column is listed at once and two of them
     would otherwise both read "Estm Hrs". */
  function panelName(c) { return c.panelLabel || c.label; }

  function col(key) {
    for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i].key === key) return COLUMNS[i];
    return null;
  }

  function textOf(c, b) {
    if (c.text) return c.text(b);
    var v = c.value ? c.value(b) : '';
    return v == null ? '' : String(v);
  }

  /* ---- persisted layout ------------------------------------------------ */

  /* Columns each view starts with. All three share one COLUMNS array; they
     differ only in what is worth showing - Result is noise on Active Bids, and
     a decided bid's LF rarely matters.

     Each view leads with the number its bids actually have. All Bids is the
     intake register, where a job number means nothing yet; Active Bids works
     off the project and proposal numbers; an awarded job is known by its Job
     No. */
  var VIEW_COLUMNS = {
    // Intake: an arrival register. Read in the order things came in, with the
    // first-pass engineer and hours. No Proposal No. - a bid has not got one
    // until somebody picks it up, so the column would be all em-dashes.
    all: { on: ['sr', 'createdAt', 'engineer', 'estHrs', 'assignedHrs'],
           off: ['proposalNo', 'team', 'task', 'activeEstHrs', 'activeAsgnHrs', 'location',
                 'lastModified'],
           first: ['sr', 'createdAt'] },

    // Working: the team and what it has booked. The intake pair is deliberately
    // absent - showing both would put two "Estm Hrs" columns side by side.
    active: { on: ['sr', 'proposalNo', 'team', 'task', 'activeEstHrs', 'activeAsgnHrs',
                   'lastModified'],
              off: ['createdAt', 'engineer', 'estHrs', 'assignedHrs', 'location'] },

    // On a won job, what it cost in effort is the point, so the hours stay on.
    awarded: { on: ['sr', 'result', 'proposalNo', 'team', 'task', 'activeEstHrs', 'activeAsgnHrs'],
               off: ['createdAt', 'engineer', 'estHrs', 'assignedHrs', 'location',
                     'lastModified'],
               // Read by the project number, so it leads - behind the row
               // counter, which always comes first.
               first: ['sr', 'proposalNo'] }
  };

  function defaults(view) {
    var tweak = VIEW_COLUMNS[view] || {};
    var on = tweak.on || [], off = tweak.off || [], first = tweak.first || [];

    /* COLUMNS declaration order, with this view's leading columns pulled to the
       front. Applied to both lists so the header and the column selector agree. */
    function ordered(keys) {
      var lead = first.filter(function (k) { return keys.indexOf(k) >= 0; });
      return lead.concat(keys.filter(function (k) { return lead.indexOf(k) < 0; }));
    }

    return {
      order: ordered(COLUMNS.map(function (c) { return c.key; })),
      visible: ordered(COLUMNS.filter(function (c) {
        if (c.locked) return true;
        if (on.indexOf(c.key) >= 0) return true;
        if (off.indexOf(c.key) >= 0) return false;
        return !c.offByDefault;
      }).map(function (c) { return c.key; })),
      sort: null,               // { key, dir: 'asc'|'desc' }
      filters: {},              // key -> { contains } or { values: [...] }
      density: 'comfortable',   // 'compact' | 'employee' - see DENSITY below
      zoom: 'day',              // the Employee view's calendar: day | week | month
      widths: {}                // key -> px, only for columns dragged by hand
    };
  }

  /* How much air a row gets. Both keep every row the SAME height, which is the
     point: the old table sized each row to its content, so a bid with three
     product chips or a two-line status was taller than its neighbours and the
     eye lost the line it was reading. The cell clips instead - the full value
     is on the tooltip, and the project page has all of it. */
  var DENSITY = {
    comfortable: { cell: 'px-3 py-3', row: 'h-[52px]' },
    compact:     { cell: 'px-3 py-1.5', row: 'h-[36px]' },
    /* The Employee view: a day-by-day schedule rather than a register. Rows
       size to how many engineers are on the bid instead of to a fixed height,
       so `row` is empty here - see employeeRow. Offered on Active Bids only,
       because a schedule of work nobody has picked up, or of jobs already won,
       is not a schedule of anything. */
    employee:    { cell: 'px-3 py-2', row: '', schedule: true }
  };

  function isSchedule() {
    return !!density().schedule;
  }

  function density() {
    var d = DENSITY[cfg().density];
    // Employee is an Active Bids view. A layout that names it on another tab -
    // saved before switching, or synced from a session that was on Active -
    // falls back rather than rendering a calendar over the wrong list.
    if (d && d.schedule && root.Bids.currentView() !== 'active') return DENSITY.comfortable;
    return d || DENSITY.comfortable;
  }

  /* The frozen columns: the leading run of sticky-marked ones in the order this
     person has actually arranged. It stops at the first non-sticky column,
     because a frozen column with a scrolling one to its left would slide out
     over it. Returns the same array of columns with a `left` offset on each. */
  /* ---- column widths ----------------------------------------------------- */

  /* A column's width in pixels: what this person has dragged it to, or the
     column's own default. Only the frozen ones have a default - the rest are
     laid out by the table until somebody sizes them. */
  var MIN_WIDTH = 56;

  function widthOf(c) {
    var w = cfg().widths[c.key];
    return w ? Math.max(MIN_WIDTH, w) : stickyWidth(c);
  }

  function stickyRun(cols) {
    var out = [], left = 0;
    for (var i = 0; i < cols.length; i++) {
      if (!stickyWidth(cols[i])) break;
      // The left edge of a frozen column is the sum of the widths to its left,
      // so a dragged width has to feed back into this or the block overlaps.
      var w = widthOf(cols[i]);
      out.push({ col: cols[i], left: left, width: w });
      left += w;
    }
    return out;
  }

  /* What a cell needs in order to be one of the frozen ones: the classes that
     pin it (defined in assets/app.css) and the left offset, which is arithmetic
     and so has to be an inline style. `head` raises it above the sticky header
     row, which is itself sticky and would otherwise scroll over the top of it.
     The last one in the run carries the edge shadow that shows the split. */
  function sticky(run, key, head) {
    for (var i = 0; i < run.length; i++) {
      if (run[i].col.key !== key) continue;
      var w = run[i].width;
      return {
        cls: ' col-sticky' + (head ? ' col-sticky-head' : '') +
             (i === run.length - 1 ? ' col-sticky-edge' : ''),
        style: ' style="left:' + run[i].left + 'px;width:' + w + 'px;min-width:' + w + 'px"'
      };
    }
    // Not frozen, but it may still have been dragged to a width. A table cell
    // honours `width` as a suggestion, so max-width has to say it again or a
    // long project name pushes the column back open.
    var c = col(key);
    var custom = c && !stickyWidth(c) && cfg().widths[key];
    return {
      cls: '',
      style: custom
        ? ' style="width:' + custom + 'px;max-width:' + custom + 'px"'
        : ''
    };
  }

  /* Each view keeps its own layout: hiding a column on Awarded Bids should not
     take it away from Active Bids. */
  function cfg() {
    var d = db();
    var view = root.Bids.currentView();
    if (!d.ui.grids) d.ui.grids = {};
    if (!d.ui.grids[view]) d.ui.grids[view] = defaults(view);
    var g = d.ui.grids[view];
    // Heal a layout saved before a column existed, or one naming a column that
    // has since been removed.
    var known = {};
    COLUMNS.forEach(function (c) { known[c.key] = true; });
    g.order = (g.order || []).filter(function (k) { return known[k]; });
    COLUMNS.forEach(function (c) { if (g.order.indexOf(c.key) < 0) g.order.push(c.key); });
    g.visible = (g.visible || []).filter(function (k) { return known[k]; });
    if (!g.visible.length) g.visible = COLUMNS.map(function (c) { return c.key; });
    COLUMNS.forEach(function (c) { if (c.locked && g.visible.indexOf(c.key) < 0) g.visible.push(c.key); });
    if (!g.filters) g.filters = {};
    // Layouts saved before the density setting existed.
    if (!DENSITY[g.density]) g.density = 'comfortable';
    if (!g.widths || typeof g.widths !== 'object') g.widths = {};
    // Layouts saved before the Employee view existed.
    if (!root.Schedule.ZOOMS[g.zoom]) g.zoom = 'day';
    return g;
  }

  /* The visible columns, in this person's order - except that the frozen ones
     are gathered at the front.

     They have to be contiguous and leading, or the pinning has nothing to
     anchor to: a frozen column with a scrolling column to its left would slide
     out over it. In practice this reorders nothing, because the identity block
     is already what every view leads with; it only guarantees it stays that way
     if somebody drags a data column above the project name in the column
     panel. Their order relative to each other is preserved, so Awarded still
     reads Sr. No. then Job No. */
  /* THE EMPLOYEE VIEW SHOWS THE SAME COLUMNS AS EVERY OTHER VIEW.

     It started out with a fixed four - actions, Sr. No., Project, Engineer - on
     the reasoning that anything else would push the calendar off the screen.
     That was the wrong trade to make on somebody else's behalf: a scheduler
     reading who is on what next week wants the due date and the price beside
     it, and the column chooser is right there to take away whatever they do not
     want. So this view reads the saved layout like the others, and the calendar
     lives to the right of it.

     The one column it insists on is Engineer, and it insists on where it goes:
     LAST, hard against the calendar. Every cell in the calendar is a line per
     engineer, and reading a figure back to the name it belongs to is the thing
     you do constantly on this view - so the names sit at the edge the dates
     start at, not four columns away with Portal and Region in between.

     It is placed at render time and never written into `order`, so the position
     it has on Comfortable and Compact is untouched. Everything else here is in
     whatever order the column chooser has been set to. */
  /* Engineer and Task are placed, in that order, hard against the calendar:
     the reading runs name, then what they are doing, then their hours across
     the dates, left to right with nothing in between. Task follows Engineer
     because it is the narrower fact - you find the person, then read what they
     are on. Neither is written into `order`, so the position they have on
     Comfortable and Compact is untouched. */
  var SCHEDULE_LAST = ['team', 'task'];

  function scheduleColumns(g) {
    var keys = g.order.filter(function (k) {
      return SCHEDULE_LAST.indexOf(k) < 0 && g.visible.indexOf(k) >= 0;
    });
    return keys.concat(SCHEDULE_LAST).map(col).filter(Boolean);
  }

  /* What stays put while the calendar scrolls: which row you are on, and no
     more. Everything else, Engineer included, scrolls with the dates - and
     because Engineer is the last thing before them, it is the last to go.

     The widths live here rather than on the column definitions because these
     are not the columns the ordinary grid freezes: activeColumns() gathers
     every sticky column to the front, so marking one here would drag it out of
     the middle of the normal table and freeze it there too. */
  var SCHEDULE_STICKY = { actions: 48, sr: 52, project: 220 };

  function stickyWidth(c) {
    if (!c) return null;
    return isSchedule() ? (SCHEDULE_STICKY[c.key] || null) : (c.sticky || null);
  }

  function activeColumns() {
    var g = cfg();
    var schedule = isSchedule();
    var shown = schedule
      ? scheduleColumns(g)
      : g.order.filter(function (k) { return g.visible.indexOf(k) >= 0; }).map(col);
    var frozen = shown.filter(function (c) { return stickyWidth(c); });
    // Actions leads the frozen block, wherever a saved layout happens to have
    // put it. A frozen column of row controls that is not the leftmost thing on
    // the row is just a column in the middle of the table.
    frozen.sort(function (a, b) {
      return (a.key === 'actions' ? -1 : 0) - (b.key === 'actions' ? -1 : 0);
    });
    return frozen.concat(shown.filter(function (c) { return !stickyWidth(c); }));
  }

  /* ---- where the calendar is pointed ------------------------------------- */

  /* The day the visible window is built around. Deliberately NOT saved with the
     layout: the zoom is a preference, but the position is where you had paged
     to five minutes ago, and a schedule that opens in last March because that
     is where somebody left it is a schedule of nothing. Every reload starts on
     today; the control below moves it. */
  var anchor = null;

  function anchorNow() { return root.Schedule.anchorOf(anchor); }

  /* ---- filtering and sorting ------------------------------------------- */

  function passesFilters(b) {
    var g = cfg();
    var keys = Object.keys(g.filters);
    for (var i = 0; i < keys.length; i++) {
      var f = g.filters[keys[i]];
      var c = col(keys[i]);
      if (!c || !f) continue;
      if (f.contains) {
        if (U.low(textOf(c, b)).indexOf(f.contains.toLowerCase()) < 0) return false;
      }
      if (f.values && f.values.length) {
        if (c.type === 'multi') {
          var vals = c.values(b);
          var hit = vals.some(function (v) { return f.values.indexOf(v) >= 0; });
          // An unassigned row matches the explicit "(none)" choice.
          if (!hit && !(vals.length === 0 && f.values.indexOf('') >= 0)) return false;
        } else if (f.values.indexOf(String(c.value(b))) < 0) {
          return false;
        }
      }
    }
    return true;
  }

  /* THE RESTING ORDER IS NEWEST FIRST.

     With no column sort the table used to come back in the order db.bids
     happens to be in, which is the order things were seeded and appended -
     oldest at the top, so a bid entered this morning was at the bottom of
     ninety-three rows. The list you open is the list of what is going on now.

     Done here rather than as a default `sort` value on purpose: a sort would
     put an arrow on the Created column, which is hidden on two of the three
     views, and would need a migration for every saved layout. This is the
     order the table falls back to, so the third click on a header - which
     clears the sort - lands here rather than back in seed order.

     AN OBSERVED ARRIVAL BEATS AN INFERRED ONE, whatever the two dates say.
     Bids that predate the arrival log had theirs inferred from the only signal
     on the record, which for most of them is the due date - and a due date is
     in the FUTURE. Compared as plain timestamps a bid guessed at "20 September"
     therefore outranks one actually entered this morning, and the backlog sits
     permanently on top of the new work. They are the old bids; they go below.

     `id` breaks the tie, and carries bids with no timestamp at all: it is
     allocated as max+1, so it increases with age just as reliably. */
  function byNewest(a, b) {
    var ai = !!a.createdAtInferred, bi = !!b.createdAtInferred;
    if (ai !== bi) return ai ? 1 : -1;
    var at = a.createdAt || '', bt = b.createdAt || '';
    if (at !== bt) return at < bt ? 1 : -1;
    return (b.id || 0) - (a.id || 0);
  }

  function applySort(list) {
    var g = cfg();
    if (!g.sort) return list.slice().sort(byNewest);
    var c = col(g.sort.key);
    if (!c || c.type === 'none') return list.slice().sort(byNewest);
    var dir = g.sort.dir === 'desc' ? -1 : 1;
    // Copy: sorting the caller's array in place would reorder db.bids itself.
    return list.slice().sort(function (a, b) {
      var av = c.value(a), bv = c.value(b);
      // Empty values always sink, whichever way the column is sorted, so a
      // descending sort does not fill the top of the table with blanks.
      var ae = av == null || av === '';
      var be = bv == null || bv === '';
      if (ae && be) return 0;
      if (ae) return 1;
      if (be) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  function distinct(key) {
    var c = col(key);
    var counts = {};
    root.Bids.baseList().forEach(function (b) {
      if (c.type === 'multi') {
        var vals = c.values(b);
        if (!vals.length) counts[''] = (counts[''] || 0) + 1;
        vals.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
      } else {
        var v = String(c.value(b) == null ? '' : c.value(b));
        counts[v] = (counts[v] || 0) + 1;
      }
    });
    return Object.keys(counts).sort(function (a, b) {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    }).map(function (v) { return { value: v, count: counts[v] }; });
  }

  function filterCount() {
    var g = cfg();
    return Object.keys(g.filters).filter(function (k) {
      var f = g.filters[k];
      return f && (f.contains || (f.values && f.values.length));
    }).length;
  }

  /* ---- rendering ------------------------------------------------------- */

  /* THE ROWS THE TABLE IS SHOWING, in the order it is showing them.
   *
   * One expression, so the export and the screen cannot disagree about which
   * bids are on the list. The XLSX export used to build its own list from
   * db.bids and therefore ignored every filter somebody had set - you narrowed
   * the table to one engineer, pressed export, and got all ninety-five.
   *
   * Defaults to the current tab's list, which is what a caller outside the
   * render loop wants; render passes the list it was handed. */
  function visibleRows(list) {
    var all = list || root.Bids.baseList();
    return applySort(all.filter(passesFilters));
  }

  function render(list) {
    var host = U.$('bidsGridHost');
    if (!host) return;
    var g = cfg();
    var cols = activeColumns();
    var rows = visibleRows(list);

    var run = stickyRun(cols);
    var d = density();
    var schedule = isSchedule();
    var zoom = g.zoom || 'day';
    // The calendar columns, in the Employee view only. Generated per render and
    // never written into the saved layout - they are a picture of the bookings,
    // not columns anybody arranged.
    var cal = schedule ? root.Schedule.periods(zoom, anchorNow()) : [];

    /* THE SCHEDULE LISTS EVERY ACTIVE BID, booked or not.

       It briefly hid the rows with nothing in the window, on the reasoning that
       a page of empty cells is not a schedule. That was wrong twice over: a bid
       nobody is booked to next week is exactly what you want to see when you
       are deciding who to put on it, and the list quietly disagreeing with the
       list on the other two views is its own problem. The bar above says how
       many are booked; nothing is removed.

       The index is built once here and read by every cell - see Schedule.plan.
       Ninety-five rows by thirty-one days is three thousand cells, and each one
       working its own hours out from scratch is the difference between a render
       you notice and one you do not. */
    var idx = schedule ? root.Schedule.plan(rows) : null;

    host.innerHTML =
      chipBar() +
      (schedule ? scheduleBar(zoom, rows) : '') +
      '<div class="bg-surface rounded-xl shadow-card border border-line overflow-hidden">' +
      // Height comes off the viewport rather than a fixed 600px: on a laptop
      // that left the table scrolling inside a half-empty screen, and on a wide
      // monitor it wasted the bottom third.
      // The id and data-keep-scroll are what U.preserveView restores the
      // position by - see the note there. Without them a colleague's save
      // rebuilds this div and the table jumps back to the far left.
      '<div id="bidsGridScroll" data-keep-scroll ' +
           'class="overflow-auto max-h-[calc(100vh-19rem)] min-h-[12rem]" ' +
           'onscroll="BidGrid.onScroll(this)">' +
      // The zoom rides on the table so one CSS rule sizes every period column,
      // rather than each cell carrying its own width.
      '<table class="w-full text-sm grid-table' +
        (schedule ? ' sched-' + zoom : '') +
        '"><thead class="sticky-header"><tr>' +
        cols.map(function (c) { return headerCell(c, g, run); }).join('') +
        (function () {
          var due = schedule ? dueCounts(rows, cal) : [];
          return cal.map(function (p, i) { return periodHead(p, due[i]); }).join('');
        })() +
      '</tr></thead><tbody>' +
      // The row index goes to render() so a positional column - Sr. No. - can
      // count the rows as they are actually laid out, after sorting and
      // filtering, rather than reading a number off the record.
      (rows.length ? rows.map(function (b, i) {
        // THE PROJECT NAME OPENS THE PROJECT - and nothing else does.
        //
        // The click used to be on the whole row, which made every cell on it a
        // trapdoor: reading a figure, selecting a proposal number to copy, or
        // aiming for a cell and missing by a pixel all threw the page away and
        // opened a project. The name is the one thing on the row that reads as
        // a link, so it is the one thing that behaves like one.
        //
        // A Lost bid stays on Active Bids, so it is muted: still readable, but
        // it must not scan as live work in a list of live work.
        // On the schedule each row is several lines tall - one per engineer -
        // so the rule between rows is drawn heavier than the one between
        // engineers inside a row. Without that the two kinds of line look
        // alike and a stack of names reads as a stack of projects.
        return '<tr class="' + d.row +
          (cal.length ? ' sched-row' : '') +
          (decided(b) ? ' row-decided' : '') + '">' +
          cols.map(function (c) {
            var s = sticky(run, c.key, false);
            var open = c.key === 'project';
            return '<td class="' + d.cell + ' col-' + c.align + s.cls + nameClass(c) +
              (open ? ' cell-open cursor-pointer' : '') +
              (cal.length ? ' align-top' : '') + '"' + s.style +
              (open
                ? ' onclick="Project.open(' + b.id + ')"' +
                  ' onkeydown="BidGrid.openOnKey(event,' + b.id + ')"' +
                  ' role="link" tabindex="0"' +
                  ' title="Open ' + U.escAttr(b.project || 'this project') + '"'
                : '') + '>' +
              (cal.length && c.key === 'team' ? engineerStack(b) : c.render(b, i)) + '</td>';
        }).join('') +
        cal.map(function (p) { return periodCell(b, p, idx, cal); }).join('') +
        '</tr>';
      }).join('')
        // The schedule no longer drops rows, so an empty table means an empty
        // list here as much as anywhere else - one message serves all three
        // views again.
        : '<tr><td colspan="' + (cols.length + cal.length) + '" class="px-3 py-12 text-center">' +
          '<i class="fas fa-inbox text-3xl text-faint mb-2 block"></i>' +
          '<span class="text-muted text-sm">No bids match the current filters</span>' +
          (filterCount() ? '<button onclick="BidGrid.clearFilters()" class="block mx-auto mt-2 text-brand hover:text-brand-ink text-xs font-medium">Clear all filters</button>' : '') +
          '</td></tr>') +
      (cal.length && rows.length ? totalsRow(rows, cols, cal, run, idx) : '') +
      '</tbody></table></div>' +
      '<div class="px-4 py-2 bg-raised border-t border-line text-xs text-muted flex items-center justify-between gap-3">' +
        '<span>' + rows.length + ' of ' + list.length + ' bids' +
          (schedule ? ' &middot; ' + U.qty(bookedTotal(cal, idx)) + ' hrs in view' : '') +
        '</span>' +
        '<span class="flex items-center gap-2">' +
          densityToggle() +
        '</span>' +
      '</div></div>';
  }

  /* ---- the Employee view's own cells ------------------------------------- */

  /* THE LINES A ROW HAS, ANSWERED ONCE.

     A schedule row is one line per engineer, in the frozen block and in every
     calendar cell, and the two only line up if they agree on how many lines
     there are and what each one means. They used to work it out separately -
     the name column from Assign.engineerList, the cells from the same call plus
     a special case - and they disagreed:

       a row booked to NOBODY had its hours counted in the totals and shown
       nowhere. The cell drew one line hardcoded to zero, so five hours on a
       nameless row read as a dot above a total of thirteen.

     Now both render from this, so the alignment is by construction. `key` is
     what the hours are looked up by, and the empty string is a real key - the
     one work booked to a row with no engineer on it is filed under. */
  /* A LINE IS ONE ASSIGNMENT ROW, NOT ONE PERSON.
   *
   * It used to be one line per distinct engineer, and that could not answer the
   * question the office actually asks: AJP holding both the take-off and the
   * estimating appeared once, with his two bookings summed into a single figure
   * that said neither which task the hours were against nor whether either of
   * them was finished. Hours are STORED per assignment row, so a line per row
   * is the shape the data already has - and it is what lets the Task column
   * beside it name a task and a status per line.
   *
   * So an engineer with two tasks appears twice. That repetition is the point.
   */
  function allLines(bid) {
    var lines = root.Assign.rows(bid).map(function (r) {
      return {
        key: r.id,
        label: String(r.engineer || '').trim(),
        taskType: r.taskType || '',
        status: root.Assign.statusOf(r),
        completedAt: r.completedAt || '',
        named: !!String(r.engineer || '').trim()
      };
    });
    // Work booked to no row at all - there is none today, but a hand-edited or
    // part-synced record can still produce it, and a bid with nothing on it
    // needs a line or the row has no height and the calendar sits wrong.
    if (!lines.length) {
      lines.push({ key: '', label: 'unassigned', taskType: '', status: 'todo',
                   completedAt: '', named: false });
    }
    return lines;
  }

  /* FILTERING BY A PERSON SHOULD GIVE YOU THAT PERSON'S WORK.
   *
   * The Engineer filter narrowed which BIDS were listed and then left every row
   * stacking all of its people - so asking for SSJ's work got you the right
   * seven projects and made you hunt down each one for SSJ's line.
   *
   * Engineer and Task are both facts about an ASSIGNMENT ROW rather than about
   * the bid, so filtering on either narrows the lines as well as the list. It
   * is done here, in the one function all three per-person renderers read, so
   * the Engineer stack, the Task column and the calendar figures narrow
   * together and stay aligned line-for-line by construction.
   *
   * WHAT DOES NOT NARROW: the hours columns, the load wash under each cell and
   * the Booked/Free totals. Those are the bid's and the shop's real figures,
   * and quietly reducing them to one person's share would mean a bid that says
   * 4.5 hrs when it has 18 booked against it. The note under the chip bar says
   * so - see lineFilterNote.
   */
  var LINE_FILTERS = {
    team: function (l) { return l.label; },
    task: function (l) { return l.taskType; }
  };

  function lineFilterValues() {
    var g = cfg();
    var out = null;
    Object.keys(LINE_FILTERS).forEach(function (key) {
      var f = g.filters[key];
      if (!f || !f.values || !f.values.length) return;
      if (!out) out = {};
      out[key] = f.values;
    });
    return out;
  }

  function scheduleLines(bid) {
    var want = lineFilterValues();
    var lines = allLines(bid);
    if (!want) return lines;

    var kept = lines.filter(function (l) {
      return Object.keys(want).every(function (key) {
        return want[key].indexOf(LINE_FILTERS[key](l)) >= 0;
      });
    });

    /* A ROW CAN NARROW TO NOTHING, and it must not narrow to no lines.
       With Engineer=SSJ and Task=Estimating, a bid passes the row filter when
       it has an SSJ row and an Estimating row - they need not be the same row.
       Zero lines would leave the row with no height and throw every calendar
       cell beside it out of step with the names, so the placeholder holds the
       line open and says why it is empty. */
    if (!kept.length) {
      return [{ key: '', label: '', taskType: '', status: 'todo',
                completedAt: '', named: false, unmatched: true }];
    }
    return kept;
  }

  /* The initials the lines have been narrowed to, or null when they have not
     been. Read by the Engineer column on Comfortable and Compact, which is
     drawn by Bids.teamCell rather than from the lines. */
  function lineFilterInitials() {
    var want = lineFilterValues();
    return (want && want.team) || null;
  }

  /* How many PEOPLE are on the bid, which is not how many lines it has. Used
     for capacity: a person holding two tasks must not double the bid's
     apparent ability to absorb hours. */
  function schedulePeople(bid) {
    return root.Assign.engineerList(bid);
  }

  /* The name column. Each person's initials sit on their own colour with a bar
     under them - the label the same colour picks out their hours with, three
     columns to the right and thirty columns after that. The line stays exactly
     one line tall: the frozen block and the calendar only line up because both
     are told the same height (see .sched-line), so the bar is an inset shadow
     rather than anything that adds to it. */
  function engineerStack(bid) {
    return scheduleLines(bid).map(function (l) {
      if (l.unmatched) {
        return '<span class="sched-line text-xs text-faint italic" ' +
          'title="This bid matches the filters, but no single task on it matches all of them">' +
          'no matching task</span>';
      }
      if (!l.named) {
        return '<span class="sched-line text-xs text-faint">' +
          U.esc(l.label || 'unassigned') + '</span>';
      }
      return '<span class="sched-line text-xs">' +
        root.Bids.personChip(l.label, {
          cls: 'text-2xs',
          // The chip's tick means "this task is done", not "this person is
          // done" - there is a line per task now, so it can finally say the
          // narrower thing it always looked like it was saying.
          done: l.status === 'done',
          title: l.label + (l.taskType ? ' - ' + l.taskType : '') +
                 ' - ' + root.Assign.STATUS[l.status].label.toLowerCase()
        }) + '</span>';
    }).join('');
  }

  /* WHAT EACH PERSON ON THE ROW IS ACTUALLY DOING, and whether it is finished.
     One line per assignment row, lining up with the Engineer stack beside it
     and with the figures in the calendar to the right - all three render from
     scheduleLines, so the alignment is by construction rather than by three
     functions agreeing to count the same way. */
  function taskStack(bid) {
    return scheduleLines(bid).map(function (l) {
      var s = root.Assign.STATUS[l.status] || root.Assign.STATUS.todo;
      if (l.unmatched) {
        return '<span class="sched-line text-xs text-faint italic">&mdash;</span>';
      }
      if (!l.taskType) {
        return '<span class="sched-line text-xs text-faint">&mdash;</span>';
      }
      return '<span class="sched-line text-xs flex items-center gap-1.5 min-w-0" title="' +
          U.escAttr((l.label ? l.label + ' - ' : '') + l.taskType + ' - ' + s.label +
            (l.status === 'done' && l.completedAt ? ' ' + U.date(l.completedAt) : '')) + '">' +
        '<span class="truncate text-ink">' + U.esc(l.taskType) + '</span>' +
        '<span class="shrink-0 px-1 py-px rounded text-3xs font-semibold ' + s.cls + '">' +
          U.esc(s.label) + '</span>' +
      '</span>';
    }).join('');
  }

  /* The Engineer column, where the record stops and the calendar begins. A
     fixed width so a stack of initials does not reflow as the table is resized,
     and an edge so the join reads as a join rather than as one more column. */
  /* The frozen block's right-hand edge, where the record stops and the calendar
     begins. It belongs to whichever of the two placed columns is last, so the
     join still reads as a join now that Task sits between Engineer and the
     dates. Both get a fixed width so a stack of chips does not reflow as the
     table is resized. */
  function nameClass(c) {
    if (!isSchedule()) return '';
    if (c.key === 'task') return ' sched-task sched-name';
    if (c.key === 'team') return ' sched-team';
    return '';
  }

  /* The classes every calendar cell shares: the weekend wash, the marker on
     today, and a rule down each Monday so a month of thirty-one columns still
     reads as weeks. */
  function periodClass(p) {
    return (p.isWeekend ? ' sched-weekend' : '') +
      (p.isWeekStart ? ' sched-wkstart' : '') +
      (p.isNow ? ' sched-now' : '');
  }

  /* `due` is how many of the rows on screen are due on this day - a dot under
     the date, so a day three projects are due on is visible without reading
     down every row to find them. */
  function periodHead(p, due) {
    return '<th class="sched-col' + periodClass(p) + '">' +
      '<span class="block text-3xs uppercase tracking-wider text-muted leading-tight">' +
        U.esc(p.label) + '</span>' +
      '<span class="block text-2xs text-faint leading-tight">' + U.esc(p.sub) + '</span>' +
      (due
        ? '<span class="block mt-0.5 text-3xs text-danger leading-none" title="' +
          due + ' project' + (due === 1 ? '' : 's') + ' due">' +
          '<i class="fas fa-flag-checkered"></i>' +
          (due > 1 ? '<span class="ml-0.5 font-bold">' + due + '</span>' : '') + '</span>'
        : '') +
    '</th>';
  }

  /* How many of the visible bids are due on each day of the window. */
  function dueCounts(rows, cal) {
    var by = {};
    rows.forEach(function (b) {
      var d = root.Bids.effectiveDueDate(b);
      if (d) by[d] = (by[d] || 0) + 1;
    });
    return cal.map(function (p) { return by[p.start] || 0; });
  }

  /* WHEN THE WORK IS DUE, on the calendar with the work.

     A row of hours means nothing without the date it is working towards, and
     the schedule was drawing one and not the other. The marker is the bid's
     EFFECTIVE due date - the revised one where the client has moved it, which
     is the date the project is actually working to (see Bids.effectiveDueDate).

     Coloured by how close it is, because "due Thursday" and "overdue since
     Thursday" are not the same news. */
  function dueMark(bid, p) {
    var due = root.Bids.effectiveDueDate(bid);
    if (!due || due < p.start || due >= p.end) return '';
    var today = root.Schedule.today();
    var days = Math.round(
      (U.parseDate(due) - U.parseDate(today)) / 86400000);
    var tone = days < 0 ? 'due-over' : days <= 3 ? 'due-soon' : 'due-ahead';
    var when = days < 0 ? 'overdue since ' : 'due ';
    return '<span class="sched-due ' + tone + '" title="' +
      U.escAttr(U.esc(bid.project || 'This project') + ' ' + when + U.date(due)) + '">' +
      '<i class="fas fa-flag-checkered"></i></span>';
  }

  /* A due date the window does not reach. Shown on the edge it lies past, so a
     deadline just off screen is not silently absent. */
  function dueOffscreen(bid, p, cal) {
    var due = root.Bids.effectiveDueDate(bid);
    if (!due || !cal.length) return '';
    var first = cal[0], last = cal[cal.length - 1];
    if (due < first.start && p.key === first.key) {
      return '<span class="sched-due-off" title="' + U.escAttr('Was due ' + U.date(due)) +
        '">&lsaquo;</span>';
    }
    if (due >= last.end && p.key === last.key) {
      return '<span class="sched-due-off" title="' + U.escAttr('Due ' + U.date(due)) +
        '">&rsaquo;</span>';
    }
    return '';
  }

  /* One line's hours per line, matching the stack in the frozen block. Nothing
     booked reads as a dot rather than a zero - a column of noughts is harder to
     scan than a column of gaps. */
  function periodCell(bid, p, idx, cal) {
    var lines = scheduleLines(bid);
    // Capacity is measured against the PEOPLE on the bid, not the lines: one
    // person holding two tasks is one person's worth of day, and counting the
    // lines would report an overbooked bid as comfortable.
    var level = root.Schedule.loadLevel(idx.bidHours(bid, p), p, schedulePeople(bid));
    var due = dueMark(bid, p) || dueOffscreen(bid, p, cal);

    return '<td class="sched-col sched-cell load-' + level + periodClass(p) +
      (due ? ' has-due' : '') + '">' + due +
      // Hours in the colour of the person they belong to, but only where there
      // are any: an empty day left clear is what keeps the load wash under the
      // cell - how hard the whole shop is booked that day - readable.
      //
      // Looked up per ROW, matching the line it is drawn on. Reading them per
      // person would put one engineer's two tasks' hours on both of their
      // lines, so a 4 and a 5 would show as 9 twice.
      lines.map(function (l) {
        var hrs = l.key ? idx.rowHours(bid, l.key, p) : 0;
        if (!hrs) return '<span class="sched-line font-mono text-xs text-faint">&middot;</span>';
        return '<span class="sched-line is-booked font-mono text-xs ' +
          (l.named ? root.Bids.colorClass(l.label) : 'pal-none') + '">' +
          U.qty(hrs) + '</span>';
      }).join('') +
    '</td>';
  }

  /* Hours inside the window, not on the bids - the fortnight either side of a
     visible booking must not land in a figure captioned "in view". */
  function bookedTotal(cal, idx) {
    return cal.reduce(function (s, p) { return s + idx.total(p); }, 0);
  }

  /* ---- the schedule's own toolbar ---------------------------------------- */

  /* Above the table rather than in the footer with the density toggle, because
     these two controls are the ones you reach for constantly on this view and
     the window they describe is the first thing you need to read. */
  function scheduleBar(zoom, rows) {
    var a = anchorNow();
    var here = root.Schedule.isNowWindow(zoom, a);
    var z = root.Schedule.ZOOMS[zoom] || root.Schedule.ZOOMS.day;
    var booked = rows.filter(function (b) {
      return root.Schedule.hasWorkIn(b, zoom, a);
    }).length;

    function arrow(dir, icon, title) {
      return '<button onclick="BidGrid.stepWindow(' + dir + ')" title="' + U.escAttr(title) + '" ' +
        'class="w-7 h-7 rounded-lg text-muted hover:text-ink hover:bg-raised flex items-center justify-center">' +
        '<i class="fas ' + icon + ' text-xs"></i></button>';
    }

    return '<div class="flex items-center justify-between gap-3 mb-3 flex-wrap">' +
      '<div class="flex items-center gap-1">' +
        arrow(-1, 'fa-chevron-left', 'Back ' + z.step) +
        '<span class="px-2 text-sm font-bold text-ink-strong whitespace-nowrap">' +
          U.esc(root.Schedule.windowLabel(zoom, a)) + '</span>' +
        arrow(1, 'fa-chevron-right', 'Forward ' + z.step) +
        // Only offered when it would do something. A control that is already
        // where it would take you is noise.
        (here ? '' :
          '<button onclick="BidGrid.goToday()" ' +
            'class="ml-2 px-2.5 py-1 rounded-lg bg-brand-soft text-brand-ink text-xs font-semibold hover:bg-brand-soft/70">' +
            'Today</button>') +
      '</div>' +
      '<div class="flex items-center gap-2">' +
        // How many of the rows below have anybody on them in these dates. The
        // list is not narrowed to them - this is the reading, not the filter.
        '<span class="text-xs text-muted hidden sm:inline">' + booked + ' of ' +
          rows.length + ' booked</span>' +
        zoomToggle() +
      '</div>' +
    '</div>';
  }

  /* The shop's load per period, under the whole table. This is the row the view
     exists for: it is where a week being overcommitted is visible without
     adding anything up by hand. */
  function totalsRow(rows, cols, cal, run, idx) {
    var people = root.Bids.baseList().reduce(function (set, b) {
      root.Assign.engineerList(b).forEach(function (e) { set[e] = true; });
      return set;
    }, {});
    // The names, not a count: capacity sums what these particular people work,
    // so a shop with a part-timer in it is not measured as though everybody
    // does a full day. See Schedule.capacityOf.
    var roster = Object.keys(people);

    /* The label sits in the last cell before the calendar, so it reads as the
       heading of the row of figures it is actually labelling. */
    function label(text, cls) {
      return cols.map(function (c, i) {
        var s = sticky(run, c.key, false);
        return '<td class="px-3 py-2 col-' + c.align + s.cls + nameClass(c) + '"' + s.style + '>' +
          (i === cols.length - 1
            ? '<span class="text-3xs font-bold uppercase tracking-wider ' + cls + '">' +
              text + '</span>'
            : '') + '</td>';
      }).join('');
    }

    return '<tr class="sched-totals">' +
      label('Booked', 'text-muted') +
      cal.map(function (p) {
        var hrs = idx.total(p);
        var level = root.Schedule.loadLevel(hrs, p, roster);
        return '<td class="sched-col sched-cell load-' + level + periodClass(p) + '">' +
          '<span class="font-mono text-xs font-bold ' +
            (hrs ? 'text-ink-strong' : 'text-faint') + '">' +
            (hrs ? U.qty(hrs) : '&middot;') + '</span></td>';
      }).join('') +
    '</tr>' +
    /* AND WHAT IS LEFT OF IT. Booked says how hard the shop is working; this
       says whether it can take any more, which is the question somebody
       scheduling has actually come here with. Weekends show nothing rather
       than a full day free - nobody is rostered, so "45 free" would be an
       invitation to book work on a Saturday. */
    '<tr class="sched-totals sched-free">' +
      label('Free', 'text-muted') +
      cal.map(function (p) {
        var cap = root.Schedule.capacityOf(p, roster);
        var free = cap - idx.total(p);
        var none = !cap;
        return '<td class="sched-col sched-cell' + periodClass(p) + '">' +
          '<span class="font-mono text-xs font-semibold ' +
            (none ? 'text-faint' : free < 0 ? 'text-danger' : free === 0 ? 'text-faint' : 'text-ok-ink') +
            '" title="' + U.escAttr(none
              ? 'Nobody is rostered on this day'
              : U.qty(cap) + ' hrs across ' + roster.length + ' ' +
                (roster.length === 1 ? 'person' : 'people') + ', ' +
                U.qty(idx.total(p)) + ' booked') + '">' +
            (none ? '&middot;' : free < 0 ? '+' + U.qty(-free) + ' over' : U.qty(free)) +
          '</span></td>';
      }).join('') +
    '</tr>';
  }

  /* Day / Week / Month - how much calendar is on screen at once: today, this
     week, this month. The columns are days at every setting; the zoom changes
     how many of them there are, not what one of them means. */
  function zoomToggle() {
    var on = cfg().zoom || 'day';
    return '<span class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-line/60 text-xs">' +
      Object.keys(root.Schedule.ZOOMS).map(function (key) {
        var z = root.Schedule.ZOOMS[key];
        return '<button onclick="BidGrid.setZoom(\'' + key + '\')" title="' + z.label + '" ' +
          'class="px-2 py-0.5 rounded flex items-center gap-1.5 transition ' +
          (on === key ? 'bg-surface text-ink shadow-card font-semibold' : 'text-muted hover:text-ink') + '">' +
          '<i class="fas ' + z.icon + ' text-3xs"></i>' + z.label + '</button>';
      }).join('') +
    '</span>';
  }

  /* Comfortable or compact. It sits in the table's own footer rather than the
     page toolbar because it is a property of this table, and it is remembered
     per view alongside the columns and filters - so it travels with the rest of
     the layout, including through Auth.resetLayout(). */
  function densityToggle() {
    var on = cfg().density === 'compact' ? 'compact' : 'comfortable';
    function opt(key, icon, label) {
      return '<button onclick="BidGrid.setDensity(\'' + key + '\')" title="' + label + '" ' +
        'class="px-2 py-0.5 rounded flex items-center gap-1.5 transition ' +
        (on === key ? 'bg-surface text-ink shadow-card font-semibold' : 'text-muted hover:text-ink') + '">' +
        '<i class="fas ' + icon + ' text-3xs"></i>' + label + '</button>';
    }
    return '<span class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-line/60 text-xs">' +
      opt('comfortable', 'fa-bars', 'Comfortable') +
      opt('compact', 'fa-grip-lines', 'Compact') +
      // Only on Active Bids: a schedule of work nobody has picked up, or of
      // jobs already finished, is not a schedule of anything.
      (root.Bids.currentView() === 'active'
        ? opt('employee', 'fa-user-clock', 'Employee') : '') +
    '</span>';
  }

  function headerCell(c, g, run) {
    var sorted = g.sort && g.sort.key === c.key ? g.sort.dir : null;
    var f = g.filters[c.key];
    var filtered = !!(f && (f.contains || (f.values && f.values.length)));
    var sortable = c.type !== 'none';
    var s = sticky(run, c.key, true);

    return '<th class="px-3 py-2.5 col-' + c.align + ' ' + (c.width || '') + s.cls +
      nameClass(c) + '"' + s.style + '>' +
      '<div class="flex items-center gap-1 ' +
        (c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : '') + '">' +
        (sortable
          ? '<button onclick="BidGrid.toggleSort(\'' + c.key + '\')" ' +
            'class="font-semibold text-muted uppercase text-xs tracking-wider hover:text-brand-ink flex items-center gap-1" ' +
            'title="Sort by ' + U.escAttr(c.label) + '">' + U.esc(c.label) +
            '<i class="fas ' + (sorted === 'asc' ? 'fa-sort-up text-brand'
              : sorted === 'desc' ? 'fa-sort-down text-brand' : 'fa-sort text-faint') + ' text-3xs"></i></button>'
          : '<span class="font-semibold text-muted uppercase text-xs tracking-wider">' + U.esc(c.label) + '</span>') +
        (c.type !== 'none'
          ? '<button onclick="BidGrid.openFilter(event,\'' + c.key + '\')" title="Filter ' + U.escAttr(panelName(c)) + '" ' +
            'class="text-3xs ' + (filtered ? 'text-brand' : 'text-faint hover:text-muted') + '">' +
            '<i class="fas fa-filter"></i></button>'
          : '') +
      '</div>' + resizeHandle(c) + '</th>';
  }

  /* The grip on a column's right edge.

     mousedown rather than a click handler, and it stops the event: the same
     corner of the same cell is the sort button's neighbour, and a drag that
     also sorted the table would be maddening. Sizing is live - see beginResize
     - but only the final width is written to the database, so a drag is one
     save rather than one per pixel. */
  function resizeHandle(c) {
    return '<span onmousedown="BidGrid.beginResize(event,\'' + c.key + '\')" ' +
      'ondblclick="BidGrid.resetWidth(event,\'' + c.key + '\')" ' +
      'title="Drag to resize' + (cfg().widths[c.key] ? ' - double-click to reset' : '') + '" ' +
      'class="col-resize"></span>';
  }

  /* Active filters as removable chips, so a narrowed table never looks empty
     for no visible reason. */
  function chipBar() {
    var g = cfg();
    var chips = [];
    Object.keys(g.filters).forEach(function (k) {
      var f = g.filters[k], c = col(k);
      if (!c || !f) return;
      if (f.contains) chips.push([k, panelName(c) + ' contains "' + f.contains + '"']);
      if (f.values && f.values.length) {
        chips.push([k, panelName(c) + ': ' + f.values.map(function (v) { return v === '' ? '(none)' : v; })
          .slice(0, 3).join(', ') + (f.values.length > 3 ? ' +' + (f.values.length - 3) : '')]);
      }
    });
    if (!chips.length) return '';
    return '<div class="mb-3">' +
      '<div class="flex flex-wrap items-center gap-2">' +
        chips.map(function (ch) {
          return '<span class="inline-flex items-center gap-1 px-2 py-1 bg-brand-soft text-brand-ink rounded text-xs">' +
            U.esc(ch[1]) +
            '<button onclick="BidGrid.clearFilter(\'' + ch[0] + '\')" class="hover:text-danger leading-none">&times;</button></span>';
        }).join('') +
        '<button onclick="BidGrid.clearFilters()" class="text-xs text-muted hover:text-danger underline">Clear all</button>' +
      '</div>' +
      lineFilterNote() +
    '</div>';
  }

  /* THE ONE PLACE SOMEBODY COULD MISREAD THE NARROWED VIEW.
     Filtering to a person hides everybody else's lines but deliberately leaves
     the hours columns and the Booked/Free totals reporting the bid and the
     shop in full - so a row can show one line and eighteen hours. Said here,
     once, rather than annotating every figure it applies to. */
  function lineFilterNote() {
    var want = lineFilterValues();
    if (!want) return '';
    var who = want.team ? want.team.join(', ') : '';
    var what = want.task ? want.task.join(', ') : '';
    var subject = who && what ? who + ' on ' + what
      : who ? who
      : what;
    return '<p class="mt-1.5 text-2xs text-muted flex items-center gap-1.5">' +
      '<i class="fas fa-user-check text-faint"></i>' +
      'Showing ' + U.esc(subject) + '&rsquo;s rows only &mdash; ' +
      'the hours columns and the totals are still the whole bid&rsquo;s.</p>';
  }

  /* ---- popovers -------------------------------------------------------- */

  /* One at a time, on document.body, positioned fixed.

     Fixed rather than absolute because the table body is a scroll container:
     an absolutely positioned menu inside it is clipped the moment it reaches
     the edge, which is exactly where the Actions column is. Body-mounted also
     means one popover can never end up behind another cell's stacking context. */
  var popover = null;

  function closePopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  /* Anchored under the control that opened it, nudged back inside the window on
     both axes - a menu on the last row used to open below the fold. */
  function place(anchor, width, height) {
    var r = anchor.getBoundingClientRect();
    var w = width || popover.offsetWidth || 240;
    var h = height || popover.offsetHeight || 200;
    var left = Math.min(r.left, window.innerWidth - w - 8);
    var top = r.bottom + 4;
    // Not enough room below: flip above the control rather than off the screen.
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    popover.style.left = Math.max(8, left) + 'px';
    popover.style.top = top + 'px';
  }

  /* A menu anchored to a control in a row. The caller supplies the items; this
     owns the shell, the placement and the dismissal. */
  function openMenu(ev, html) {
    ev.stopPropagation();
    closePopover();
    popover = document.createElement('div');
    popover.className = 'fixed z-50 bg-surface border border-line rounded-lg ' +
      'shadow-pop py-1 w-52 text-left';
    popover.onclick = function (e) { e.stopPropagation(); };
    popover.innerHTML = html;
    document.body.appendChild(popover);
    place(ev.currentTarget);
  }

  /* Copying without the clipboard API: a hidden textarea, selected, and
     document.execCommand. Needed because the office reaches this app over
     http://<machine>:port, where navigator.clipboard is not available at all. */
  function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (ok) done();
    else U.toast('Could not copy - select the address and copy it by hand.', 'warn');
  }

  /* One row in such a menu. Used by js/bids.js for the row overflow menu. */
  function menuItem(o) {
    return '<button onclick="BidGrid.closePopover();' + o.onclick + '" ' +
      'class="w-full text-left px-3 py-2 text-xs flex items-center gap-2.5 transition ' +
      (o.tone === 'danger' ? 'text-danger hover:bg-danger-soft'
        : o.tone === 'ok' ? 'text-ok-ink hover:bg-ok-soft'
        : o.tone === 'warn' ? 'text-warn-ink hover:bg-warn-soft'
        : 'text-ink hover:bg-raised') + '">' +
      '<i class="fas ' + o.icon + ' w-4 text-center opacity-70"></i>' + U.esc(o.label) + '</button>';
  }

  function menuLink(o) {
    return '<a href="' + U.escAttr(o.href) + '" target="_blank" rel="noopener" ' +
      'onclick="BidGrid.closePopover()" ' +
      'class="w-full text-left px-3 py-2 text-xs flex items-center gap-2.5 text-ink hover:bg-raised">' +
      '<i class="fas ' + o.icon + ' w-4 text-center opacity-70"></i>' + U.esc(o.label) + '</a>';
  }

  function menuSeparator() {
    return '<div class="border-t border-line my-1"></div>';
  }

  function openFilter(ev, key) {
    ev.stopPropagation();
    closePopover();
    var c = col(key);
    var g = cfg();
    var f = g.filters[key] || {};

    popover = document.createElement('div');
    popover.className = 'fixed z-50 bg-surface border border-line-strong rounded-lg shadow-2xl p-3 text-xs w-64';
    popover.onclick = function (e) { e.stopPropagation(); };

    var body;
    if (c.type === 'enum' || c.type === 'multi') {
      var opts = distinct(key);
      body = '<input placeholder="Search values..." oninput="BidGrid.filterOptionSearch(this)" ' +
        'class="w-full px-2 py-1 mb-2 bg-raised border border-line rounded outline-none focus:border-brand">' +
        '<div class="max-h-56 overflow-y-auto space-y-0.5" id="filterOptions">' +
        opts.map(function (o) {
          var checked = f.values && f.values.indexOf(o.value) >= 0;
          return '<label class="flex items-center gap-2 px-1 py-0.5 hover:bg-raised rounded cursor-pointer" ' +
            'data-label="' + U.escAttr((o.value || 'none').toLowerCase()) + '">' +
            '<input type="checkbox" value="' + U.escAttr(o.value) + '" ' + (checked ? 'checked' : '') + '>' +
            '<span class="flex-1 truncate">' + (o.value === ''
              ? '<em class="text-faint">(none)</em>' : U.esc(o.value)) + '</span>' +
            '<span class="text-faint">' + o.count + '</span></label>';
        }).join('') + '</div>';
    } else {
      body = '<input value="' + U.escAttr(f.contains || '') + '" placeholder="Contains..." ' +
        'onkeydown="if(event.key===\'Enter\')BidGrid.applyFilter(\'' + key + '\')" ' +
        'id="filterContains" class="w-full px-2 py-1 bg-raised border border-line rounded outline-none focus:border-brand">';
    }

    popover.innerHTML =
      '<div class="font-semibold text-ink mb-2">Filter: ' + U.esc(panelName(c)) + '</div>' +
      body +
      '<div class="flex gap-2 mt-3 pt-2 border-t border-line">' +
        '<button onclick="BidGrid.applyFilter(\'' + key + '\')" class="flex-1 px-2 py-1 bg-brand hover:bg-brand-hover text-white rounded font-semibold">Apply</button>' +
        '<button onclick="BidGrid.clearFilter(\'' + key + '\')" class="px-2 py-1 text-muted hover:text-danger">Clear</button>' +
      '</div>';

    document.body.appendChild(popover);
    place(ev.currentTarget);
    var first = popover.querySelector('input');
    if (first) first.focus();
  }

  /* ---- column selector ------------------------------------------------- */

  function renderColumnPanel() {
    var g = cfg();
    return '<div class="p-3 w-72">' +
      '<div class="flex items-center justify-between mb-2 gap-3">' +
        '<span class="font-semibold text-ink text-xs uppercase tracking-wider">Columns</span>' +
        '<span class="flex items-center gap-2">' +
          // Two resets, because they undo different things: one puts the
          // columns back, the other puts their widths back. Somebody who has
          // spent a while arranging columns should not lose that to fix a
          // column they dragged too narrow.
          (Object.keys(g.widths).length
            ? '<button onclick="BidGrid.resetWidths()" class="text-2xs text-brand hover:text-brand-ink">Reset widths</button>'
            : '') +
          '<button onclick="BidGrid.resetColumns()" class="text-2xs text-brand hover:text-brand-ink">Reset all</button>' +
        '</span></div>' +
      '<div class="space-y-0.5 max-h-72 overflow-y-auto">' +
      g.order.map(function (k, i) {
        var c = col(k);
        var on = g.visible.indexOf(k) >= 0;
        // On the Employee view Engineer is placed for you, at the calendar's
        // edge - so the panel says so rather than offering arrows that would
        // appear to do nothing. Ticking and moving it still work, and both
        // apply on Comfortable and Compact where it is an ordinary column.
        var pinned = isSchedule() && k === 'team';
        return '<div class="flex items-center gap-2 px-1 py-1 hover:bg-raised rounded text-xs">' +
          '<input type="checkbox" ' + (on || pinned ? 'checked ' : '') +
            (c.locked || pinned ? 'disabled ' : '') +
            'onchange="BidGrid.toggleColumn(\'' + k + '\')" class="cursor-pointer">' +
          '<span class="flex-1 ' + (c.locked || pinned ? 'text-faint' : 'text-ink') + '">' +
            U.esc(panelName(c)) +
            (c.locked ? ' <span class="text-3xs">(always shown)</span>'
              : pinned ? ' <span class="text-3xs">(beside the calendar)</span>' : '') + '</span>' +
          '<button onclick="BidGrid.moveColumn(\'' + k + '\',-1)" ' + (i === 0 ? 'disabled' : '') +
            ' class="text-faint hover:text-ink disabled:opacity-30"><i class="fas fa-chevron-up text-3xs"></i></button>' +
          '<button onclick="BidGrid.moveColumn(\'' + k + '\',1)" ' + (i === g.order.length - 1 ? 'disabled' : '') +
            ' class="text-faint hover:text-ink disabled:opacity-30"><i class="fas fa-chevron-down text-3xs"></i></button>' +
        '</div>';
      }).join('') + '</div></div>';
  }

  /* The column panel repaints itself after each change. It can legitimately be
     absent - the panel may have been dismissed, or these can be driven directly
     - so never assume it is on screen. */
  function refreshColumnPanel() {
    if (popover) popover.innerHTML = renderColumnPanel();
  }

  /* ---- public API ------------------------------------------------------ */

  root.BidGrid = {
    COLUMNS: COLUMNS,
    render: render,
    cfg: cfg,

    /* The project cell is a link, so it answers to a keyboard the way one
       does: it is in the tab order and Enter or Space follows it. Without
       this, moving the click off the row would have taken the table away from
       anybody not using a mouse. */
    openOnKey: function (ev, id) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();
      root.Project.open(id);
    },
    activeColumns: activeColumns,
    filterCount: filterCount,

    toggleSort: function (key) {
      var g = cfg();
      if (!g.sort || g.sort.key !== key) g.sort = { key: key, dir: 'asc' };
      else if (g.sort.dir === 'asc') g.sort.dir = 'desc';
      else g.sort = null;                 // third click clears the sort
      root.Store.save();
      root.Bids.filterTable();
    },

    /* Used by js/bids.js to hang the row's overflow menu off the table's own
       popover, so there is one thing on screen at a time and one dismissal
       rule for all of them. */
    openMenu: openMenu,

    /* The site address, under the Region cell it hangs off. Through the same
       openMenu as every other popover on this table, so it is placed, dismissed
       and stacked by the one set of rules rather than a second tooltip nobody
       can close. */
    openLocation: function (ev, bidId) {
      var b = root.Store.db.bids.filter(function (x) { return x.id === bidId; })[0];
      if (!b || !b.location) return;
      var maps = U.mapsUrl(b.location);
      openMenu(ev,
        '<div class="px-3 py-2 border-b border-line">' +
          '<div class="text-3xs font-bold text-faint uppercase tracking-wider mb-1">Location</div>' +
          '<div class="text-xs text-ink leading-snug">' + U.esc(b.location) + '</div>' +
        '</div>' +
        menuItem({ icon: 'fa-copy', label: 'Copy address',
                   onclick: 'BidGrid.copyLocation(' + b.id + ')' }) +
        (maps ? menuLink({ icon: 'fa-map-location-dot', label: 'Open in Maps', href: maps }) : '') +
        (root.Auth.can('bid.edit')
          ? menuItem({ icon: 'fa-pen', label: 'Edit bid', onclick: 'Bids.edit(' + b.id + ')' })
          : ''));
    },

    copyLocation: function (bidId) {
      var b = root.Store.db.bids.filter(function (x) { return x.id === bidId; })[0];
      if (!b || !b.location) return;
      closePopover();
      /* navigator.clipboard is unavailable on a plain-http LAN address, which
         is exactly how this app is served in the office - so the textarea
         fallback is the path that actually runs there, not a legacy branch. */
      var done = function () { U.toast('Address copied.', 'ok'); };
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(b.location).then(done, function () { legacyCopy(b.location, done); });
      } else {
        legacyCopy(b.location, done);
      }
    },
    /* Which lines a per-person filter has narrowed each row to. Exported for
       the Engineer column on Comfortable/Compact, which Bids.teamCell draws,
       and for the tests that pin the narrowing. */
    scheduleLines: scheduleLines,
    allLines: allLines,
    lineFilterInitials: lineFilterInitials,

    /* What the XLSX export reads, so the workbook is the table you are looking
       at rather than a second opinion about it. cfg is already exported above.
       isSchedule and anchor let it tell whether the Employee calendar is on
       screen and, if so, which window it is showing - the export mirrors that
       window rather than picking one of its own. */
    visibleRows: visibleRows,
    cellText: textOf,
    column: col,
    isSchedule: isSchedule,

    menuItem: menuItem,
    menuLink: menuLink,
    menuSeparator: menuSeparator,

    /* The frozen columns only cast their shadow once there is something behind
       them to cast it onto. */
    onScroll: function (el) {
      el.classList.toggle('grid-scrolled', el.scrollLeft > 0);
    },

    /* ---- resizing ------------------------------------------------------- */

    /* Drag to size a column.

       The width is applied straight to the DOM while the mouse is down and only
       written to the database on mouseup: re-rendering the table on every
       mousemove would be a repaint of every row per pixel, and a save per pixel
       on top of it. The frozen block is the exception - its left offsets are
       arithmetic over the widths to its left, so those do need a re-render, and
       they get one when the drag ends. */
    beginResize: function (ev, key) {
      ev.preventDefault();
      ev.stopPropagation();
      var th = ev.target.closest('th');
      if (!th) return;

      var startX = ev.clientX;
      var startW = th.getBoundingClientRect().width;
      var table = th.closest('table');
      var index = Array.prototype.indexOf.call(th.parentNode.children, th);
      var next = null;

      document.body.classList.add('col-resizing');

      function widthNow(e) {
        return Math.max(MIN_WIDTH, Math.round(startW + (e.clientX - startX)));
      }

      function onMove(e) {
        var w = widthNow(e);
        th.style.width = w + 'px';
        th.style.minWidth = w + 'px';
        th.style.maxWidth = w + 'px';
        // The body cells have to follow, or the header and its column disagree
        // until the drag ends.
        if (!next) {
          next = Array.prototype.map.call(
            table.querySelectorAll('tbody tr'),
            function (tr) { return tr.children[index]; }).filter(Boolean);
        }
        next.forEach(function (td) {
          td.style.width = w + 'px';
          td.style.maxWidth = w + 'px';
        });
      }

      function onUp(e) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('col-resizing');
        cfg().widths[key] = widthNow(e);
        root.Store.save();
        // Re-render rather than leave the inline styles: the frozen block's
        // offsets are computed from these widths and are now stale.
        root.Bids.filterTable();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    /* Double-clicking the grip puts one column back to its default. */
    resetWidth: function (ev, key) {
      ev.preventDefault();
      ev.stopPropagation();
      delete cfg().widths[key];
      root.Store.save();
      root.Bids.filterTable();
    },

    resetWidths: function () {
      cfg().widths = {};
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },

    setDensity: function (mode) {
      cfg().density = DENSITY[mode] ? mode : 'comfortable';
      root.Store.save();
      root.Bids.filterTable();
    },

    /* Day / Week / Month on the Employee view's calendar. The anchor is left
       where it is, so switching from a week you have paged to shows the month
       around it rather than snapping back to now. */
    setZoom: function (zoom) {
      cfg().zoom = root.Schedule.ZOOMS[zoom] ? zoom : 'day';
      root.Store.save();
      root.Bids.filterTable();
    },

    /* Paging the calendar. Not saved - see `anchor` - so this is a re-render
       and nothing else. */
    stepWindow: function (dir) {
      anchor = root.Schedule.step(cfg().zoom || 'day', anchorNow(), dir);
      root.Bids.filterTable();
    },
    goToday: function () {
      anchor = null;
      root.Bids.filterTable();
    },
    /* Point the calendar at a given day - the arrows and Today are the two ways
       the page does it, and this is the one underneath them. */
    setAnchor: function (iso) {
      anchor = root.Schedule.anchorOf(iso);
      root.Bids.filterTable();
    },
    anchor: function () { return anchorNow(); },

    openFilter: openFilter,
    filterOptionSearch: function (input) {
      var q = input.value.toLowerCase();
      var host = popover.querySelector('#filterOptions');
      Array.prototype.forEach.call(host.children, function (el) {
        el.style.display = el.getAttribute('data-label').indexOf(q) >= 0 ? '' : 'none';
      });
    },
    /* Set a column's filter without going through the popover. The popover is
       where a person does it; this is the same write for everything else -
       a shortcut elsewhere in the app, or a test pinning the behaviour - so
       there is one place that knows an empty list means "no filter" rather
       than "match nothing". */
    setFilterValues: function (key, values) {
      var g = cfg();
      if (values && values.length) g.filters[key] = { values: values.slice() };
      else delete g.filters[key];
      root.Store.save();
      root.Bids.filterTable();
    },

    applyFilter: function (key) {
      var g = cfg();
      var c = col(key);
      if (c.type === 'enum' || c.type === 'multi') {
        var picked = [];
        Array.prototype.forEach.call(popover.querySelectorAll('#filterOptions input:checked'),
          function (cb) { picked.push(cb.value); });
        closePopover();
        root.BidGrid.setFilterValues(key, picked);
        return;
      }
      var v = popover.querySelector('#filterContains').value.trim();
      if (v) g.filters[key] = { contains: v };
      else delete g.filters[key];
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },
    clearFilter: function (key) {
      delete cfg().filters[key];
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },
    clearFilters: function () {
      cfg().filters = {};
      closePopover();
      root.Store.save();
      root.Bids.filterTable();
    },

    openColumns: function (ev) {
      ev.stopPropagation();
      closePopover();
      popover = document.createElement('div');
      popover.className = 'fixed z-50 bg-surface border border-line-strong rounded-lg shadow-2xl';
      popover.onclick = function (e) { e.stopPropagation(); };
      popover.innerHTML = renderColumnPanel();
      document.body.appendChild(popover);
      place(ev.currentTarget);
    },
    toggleColumn: function (key) {
      var g = cfg();
      var c = col(key);
      if (c.locked) return;
      var i = g.visible.indexOf(key);
      if (i >= 0) g.visible.splice(i, 1); else g.visible.push(key);
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    moveColumn: function (key, dir) {
      var g = cfg();
      var i = g.order.indexOf(key);
      var j = i + dir;
      if (i < 0 || j < 0 || j >= g.order.length) return;
      var tmp = g.order[i]; g.order[i] = g.order[j]; g.order[j] = tmp;
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    resetColumns: function () {
      var view = root.Bids.currentView();
      db().ui.grids[view] = defaults(view);
      root.Store.save();
      refreshColumnPanel();
      root.Bids.filterTable();
    },
    closePopover: closePopover
  };

  /* A popover is anchored to a point on the screen, so it has to go when the
     page moves under it. But this listener is on the capture phase - it has to
     be, or a scroll inside the table body would never reach it - and that means
     it also fires for scrolls INSIDE the popover. Both the column list and the
     filter value list are scrollable, so reaching for their scrollbar dismissed
     the thing you were reaching into.

     Scrolling a popover is somebody reading it. Only scrolling something else
     is the page moving out from under it. */
  document.addEventListener('click', closePopover);
  window.addEventListener('scroll', function (e) {
    if (popover && e.target && e.target.nodeType === 1 && popover.contains(e.target)) return;
    closePopover();
  }, true);
})(window);
