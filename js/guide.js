/* guide.js - what this app does, in one place.
 *
 * There are two audiences and they want the same facts at different lengths:
 * somebody at the sign-in screen who wants to know what they are looking at,
 * and somebody inside who wants to know how a particular part works. Writing
 * those as two documents means two documents to keep true, and the short one
 * would be the one that quietly went stale.
 *
 * So there is one list of sections here. Guide.landing() renders the headline
 * half of it onto the sign-in page; Guide.open() renders all of it into a panel
 * behind the Help button. Adding a feature means editing one entry.
 *
 * IT ONLY DESCRIBES WHAT IS BUILT. The last section says plainly which modules
 * are not, because a guide that implies otherwise is worse than no guide - and
 * the placeholders in the app already say so themselves.
 */
(function (root) {
  'use strict';

  var U = root.U;

  /* `lead` marks the sections the sign-in page shows. They are the ones that
     answer "what is this and what would I use it for"; the rest answer "how
     does this bit work", which is a question you only have once you are in. */
  var SECTIONS = [
    {
      key: 'what', icon: 'fa-compass', lead: true,
      title: 'One place for the whole bid',
      blurb: 'Every enquiry the shop receives, from the day it arrives to the day it is ' +
             'won or lost - the estimate, the proposal that goes to the client, the hours ' +
             'booked against it and a record of everything that changed on the way.',
      points: [
        'One shared database for the office. Everyone sees the same register, and ' +
          'changes appear on other screens as they are made.',
        'Nothing is filed twice: the takeoff prices the bid, the bid names the proposal, ' +
          'and the proposal carries the project number it was issued.'
      ]
    },
    {
      key: 'stages', icon: 'fa-layer-group', lead: true,
      title: 'Three lists, three stages',
      blurb: 'The tabs are stages of a bid\'s life rather than filters over one field.',
      points: [
        '<b>All Bids</b> is the intake register - everything received, in the order it arrived.',
        '<b>Active Bids</b> is what somebody has picked up and is working on. A bid gets ' +
          'there by being added to it, from the row menu or the project page.',
        '<b>Awarded Bids</b> is the job register.',
        'A bid leaves Active when it is Awarded or marked No Scope. A <b>Lost</b> bid stays, ' +
          'greyed - the work went into it, and hiding it hides that.',
        'Every move can be reversed, with a comment, and both the move and the reversal are ' +
          'kept in the project\'s history.'
      ]
    },
    {
      key: 'numbers', icon: 'fa-hashtag',
      title: 'One number, for the project\'s life',
      blurb: 'A project is issued its Proposal No. - DIS-26-0001 - at the moment somebody ' +
             'picks it up, and keeps it through the proposal and the award.',
      points: [
        'Bids on All Bids have no number yet, because nobody has committed to them. That ' +
          'list shows the date and time each one arrived instead.',
        'Sr. No. is only the row\'s position in the list you are looking at - it is not ' +
          'stored on the bid and it does not follow it around.',
        'Two bids may share a project name - a rebid, a second package - so picking up a ' +
          'name already on file stops to ask rather than refusing.'
      ]
    },
    {
      key: 'project', icon: 'fa-diagram-project', lead: true,
      title: 'The project page',
      blurb: 'Click any row to open one project full screen, with its Overview, TakeOff and ' +
             'Proposal on three tabs.',
      points: [
        'Double-click any detail on the Overview to edit it in place.',
        '<b>Products &amp; Materials</b>: each product on the job carries its own materials.',
        '<b>Team &amp; Hours</b>: a row per engineer per task, with the hours booked against ' +
          'particular days.',
        'Files, comments, the award decision and the full history all live here.'
      ]
    },
    {
      key: 'takeoff', icon: 'fa-calculator',
      title: 'The takeoff',
      blurb: 'The estimating sheet: what the job is made of, what it costs, and the price ' +
             'that comes back onto the bid.',
      points: [
        'Products, their components, and the parts in each - drawn from the rate library so ' +
          'the same part costs the same on every job.',
        'Cost &amp; Labour rows for everything that is not a part - engineering, fabrication, ' +
          'installation, transport - each with its own quantity and unit.',
        'The rollup carries the markup and the rounding, and writes the price back to the ' +
          'bid unless you have locked it.',
        'Export the whole sheet to Excel.'
      ]
    },
    {
      key: 'rates', icon: 'fa-warehouse',
      title: 'Rates and the parts catalogue',
      blurb: 'Shop-wide rates in one library, and a catalogue that fills itself in.',
      points: [
        'Every part used on a takeoff is remembered, so the next person typing the same ' +
          'description is offered it with its price.',
        'Rates can be set for the shop and overridden on a single project where a job ' +
          'genuinely differs.',
        'Import a price list from CSV.'
      ]
    },
    {
      key: 'proposal', icon: 'fa-file-contract', lead: true,
      title: 'The proposal the client sees',
      blurb: 'Generated from the takeoff, then edited: the scope, the terms, the company ' +
             'details and the covering wording.',
      points: [
        'Twelve document styles, from a plain serif letterhead to a dark executive one.',
        'Your logo, with a white, black or no background behind it - whichever suits how ' +
          'the logo itself was drawn.',
        'Export to PDF, and save a proposal as a template to start the next one from.',
        'It says when the takeoff has changed underneath it, so a stale proposal cannot go ' +
          'out without you being told.'
      ]
    },
    {
      key: 'hours', icon: 'fa-user-clock',
      title: 'Hours, and who is booked when',
      blurb: 'Estimated hours are what the job was expected to take; assigned hours are what ' +
             'has actually been booked to it, day by day.',
      points: [
        'Adding an engineer to a task opens three working days to book against, with more ' +
          'on request. Weekends are shown but stepped over.',
        'The <b>Employee</b> view on Active Bids is the shop\'s calendar: every project, its ' +
          'engineers stacked, and the hours each has per day.',
        'Day, Week or Month decides how much calendar is on screen; the arrows page through it.',
        'Cells deepen in colour as a day fills up, and the row along the bottom is the whole ' +
          'shop\'s load - which is where an overcommitted week is visible at a glance.'
      ]
    },
    {
      key: 'history', icon: 'fa-clock-rotate-left',
      title: 'What happened to this bid',
      blurb: 'Every project keeps its own record: created, edited, moved, decided - each with ' +
             'the person who did it and when.',
      points: [
        'Times are shown in IST, whatever the machine reading them is set to.',
        'Edits name the field, with the value before and after.',
        'An administrator can delete an entry, and the deletion is itself recorded.'
      ]
    },
    {
      key: 'dashboard', icon: 'fa-gauge-high',
      title: 'The dashboard',
      blurb: 'Where the office stands, without reading the table.',
      points: [
        'Totals and win rate, bids by month, and what is due soon or overdue.',
        'Charts by status, region and product.',
        'Clicking a month takes you to that month\'s bids.'
      ]
    },
    {
      key: 'together', icon: 'fa-users', lead: true,
      title: 'Working at the same time',
      blurb: 'The database is shared, so two people are always looking at the same register.',
      points: [
        'Changes made by somebody else appear on your screen as they happen, and say who ' +
          'made them.',
        'If you are typing when one arrives, your edit is kept and you are told rather than ' +
          'having the field pulled out from under you.',
        'A project somebody else currently has open is marked, in the list and on the ' +
          'project itself - so you can ask before you both start.'
      ]
    },
    {
      key: 'accounts', icon: 'fa-user-shield',
      title: 'Accounts and access',
      blurb: 'Everyone signs in as themselves, and what they can see and do follows their role.',
      points: [
        'Roles are edited in Settings, permission by permission.',
        'Administrators create accounts and set passwords; there is no shared login and no ' +
          'default password anywhere in the app.',
        'What a role may not do is hidden from the screen and refused by the server, not ' +
          'just hidden.'
      ]
    },
    {
      key: 'yours', icon: 'fa-table-columns',
      title: 'Making the tables yours',
      blurb: 'Every list is arranged per person - your layout follows your account to ' +
             'whichever machine you sit at, and changing it moves nobody else\'s.',
      points: [
        'Show, hide, reorder and resize columns; each of the three lists remembers its own.',
        'Filter and sort any column; the filters you have on are shown as chips you can drop.',
        'Comfortable or compact rows, and a dark theme that follows the machine if you let it.',
        'Open a TakeOff or Proposal in its own window with Ctrl+click, for a second screen.'
      ]
    },
    {
      key: 'saving', icon: 'fa-floppy-disk',
      title: 'Saving, backups and exports',
      blurb: 'Nothing has to be saved by hand - the footer says when it last was.',
      points: [
        'Save downloads a full backup as a .json file. An administrator can load one back, ' +
          'which replaces the shared database for everyone.',
        'The bids table exports to Excel, as does a takeoff.',
        'Proposals export to PDF.'
      ]
    },
    {
      key: 'soon', icon: 'fa-road-barrier',
      title: 'What is not built yet',
      blurb: 'Bid Management is the module in use. Four others are named in the bar and are ' +
             'honest placeholders rather than mock-ups.',
      points: [
        'Production Manager, Inventory Manager, Report Manager and Scheduler are planned for ' +
          'later phases.',
        'Opening one says so rather than showing a screen that does nothing.'
      ]
    }
  ];

  /* ---- the sign-in page's half ------------------------------------------- */

  /* Blurbs only, and only the lead sections: somebody who has not signed in yet
     wants to know what the app is for, not how the takeoff rollup works. */
  function landing() {
    return SECTIONS.filter(function (s) { return s.lead; }).map(function (s) {
      return '<div class="flex gap-3.5">' +
        '<span class="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0 mt-0.5">' +
          '<i class="fas ' + s.icon + ' text-white/80 text-sm"></i></span>' +
        '<div class="min-w-0">' +
          '<div class="text-sm font-semibold text-white">' + U.esc(s.title) + '</div>' +
          '<p class="text-xs text-white/60 leading-relaxed mt-0.5">' + s.blurb + '</p>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ---- the full guide ---------------------------------------------------- */

  function section(s) {
    return '<section id="guide-' + s.key + '" class="scroll-mt-4">' +
      '<h3 class="text-base font-bold text-ink-strong flex items-center gap-2.5">' +
        '<i class="fas ' + s.icon + ' text-brand text-sm"></i>' + U.esc(s.title) + '</h3>' +
      '<p class="text-sm text-muted mt-1.5 leading-relaxed">' + s.blurb + '</p>' +
      '<ul class="mt-2.5 space-y-1.5">' +
        s.points.map(function (p) {
          return '<li class="text-sm text-ink flex gap-2.5 leading-relaxed">' +
            '<i class="fas fa-circle text-[4px] text-faint mt-2 shrink-0"></i>' +
            '<span>' + p + '</span></li>';
        }).join('') +
      '</ul>' +
    '</section>';
  }

  function panel() {
    return '<div class="bg-surface rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] ' +
        'flex flex-col animate-fade-in overflow-hidden">' +
      '<div class="px-6 py-4 border-b border-line flex items-center justify-between gap-4">' +
        '<div>' +
          '<h2 class="text-lg font-bold text-ink-strong">User guide</h2>' +
          '<p class="text-xs text-muted">What the app does, and how each part of it works.</p>' +
        '</div>' +
        '<button onclick="Guide.close()" title="Close" ' +
          'class="w-8 h-8 rounded-full hover:bg-raised flex items-center justify-center transition">' +
          '<i class="fas fa-times text-muted"></i></button>' +
      '</div>' +
      '<div class="flex min-h-0 flex-1">' +
        // The rail is a table of contents, not navigation - the guide is one
        // scrolling document, so nothing is ever hidden behind a tab you did
        // not think to click.
        '<nav class="hidden md:block w-56 shrink-0 border-r border-line overflow-y-auto py-3">' +
          SECTIONS.map(function (s) {
            return '<a href="#guide-' + s.key + '" ' +
              'class="flex items-center gap-2.5 px-4 py-1.5 text-xs text-muted hover:text-ink hover:bg-raised">' +
              '<i class="fas ' + s.icon + ' w-4 text-center text-3xs text-faint"></i>' +
              U.esc(s.title) + '</a>';
          }).join('') +
        '</nav>' +
        '<div class="flex-1 overflow-y-auto px-6 py-5 space-y-7">' +
          SECTIONS.map(section).join('') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  root.Guide = {
    SECTIONS: SECTIONS,
    landing: landing,

    open: function () {
      var el = U.$('guideModal');
      if (!el) return;
      el.innerHTML = panel();
      el.classList.remove('hidden');
    },
    close: function () {
      var el = U.$('guideModal');
      if (!el) return;
      el.classList.add('hidden');
      el.classList.remove('z-[210]');
    },

    /* The sign-in page's link. The guide needs the app's own markup to live in,
       which the overlay is covering - so before anybody is signed in it opens
       over the top of it, and closes back to the sign-in form. */
    openFromGate: function () {
      root.Guide.open();
      var el = U.$('guideModal');
      if (el) el.classList.add('z-[210]');   // above #bootOverlay's z-[200]
    }
  };
})(window);
