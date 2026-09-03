/* permissions.js - what a role is allowed to do, in one table.
 *
 * The same one-array-is-the-truth shape BidGrid.COLUMNS and Nav.MENU already
 * use. The server reads it to decide whether a request is allowed; the client
 * reads the same list (served to it at login) to decide which buttons to draw.
 * Adding a permission is one entry here, not four edits that drift apart.
 *
 * The order matters twice over: it is the order the Roles screen lists them in,
 * and `group` is what it puts them under.
 *
 * Hiding a button and refusing a request are different jobs. Hiding stops an
 * honest mistake; the check in requiredFor() below is the one that actually
 * protects the data, because it runs even if the request never came from our
 * own screen.
 */
'use strict';

const PERMISSIONS = [
  /* Which of the six modules appear in the module bar. */
  { key: 'module.dashboard', group: 'Pages', label: 'Dashboard' },
  { key: 'module.bids', group: 'Pages', label: 'Bid Management' },
  { key: 'module.production', group: 'Pages', label: 'Production Manager' },
  { key: 'module.inventory', group: 'Pages', label: 'Inventory Manager' },
  { key: 'module.report', group: 'Pages', label: 'Report Manager' },
  { key: 'module.scheduler', group: 'Pages', label: 'Scheduler' },

  { key: 'bid.create', group: 'Bids', label: 'Add a bid' },
  { key: 'bid.edit', group: 'Bids', label: 'Edit a bid' },
  { key: 'bid.award', group: 'Bids', label: 'Award a bid, or mark it lost' },
  { key: 'bid.delete', group: 'Bids', label: 'Delete a bid' },
  { key: 'bid.export', group: 'Bids', label: 'Export the table to XLSX' },
  { key: 'takeoff.edit', group: 'Bids', label: 'Edit take-offs' },
  { key: 'proposal.edit', group: 'Bids', label: 'Edit proposals' },
  /* Deliberately separate from settings.edit. Somebody working a bid types a
     new engineer's initials or a task type that is not on the list yet, and the
     app adds it. That is not "administering the shop-wide lists" - and without
     its own permission an estimator's whole save would be refused for it, since
     a batch is all-or-nothing. See requiredFor(). */
  { key: 'list.extend', group: 'Bids', label: 'Add an engineer or task type while working a bid' },

  { key: 'settings.view', group: 'Settings', label: 'Open Settings' },
  { key: 'settings.edit', group: 'Settings', label: 'Change rates, regions, references, company' },

  { key: 'project.save', group: 'Whole database', label: 'Download a backup' },
  /* Load replaces everything, for everyone. See the note in serve-side
     enforcement below and in the README. */
  { key: 'project.load', group: 'Whole database', label: 'Restore a backup over everything' },

  { key: 'admin.users', group: 'Administration', label: 'Create and manage people' },
  { key: 'admin.roles', group: 'Administration', label: 'Create roles and change what they may do' }
];

const ALL = PERMISSIONS.map(p => p.key);

/* The two roles the first run creates. Employee is the access level marked on
   the screenshots: every page and action of Bid Management, nothing that
   administers the shop or the people in it. */
const ROLE_DEFAULTS = {
  Admin: ALL.slice(),
  Employee: [
    'module.dashboard', 'module.bids',
    'bid.create', 'bid.edit', 'bid.award', 'bid.export',
    'takeoff.edit', 'proposal.edit', 'list.extend',
    'project.save'
  ]
};

function isPermission(key) { return ALL.indexOf(key) >= 0; }

/* Only keys that exist, de-duplicated, in catalogue order - so a role saved by
   an older build, or a hand-posted request, cannot introduce a permission the
   app has never heard of. */
function clean(list) {
  const want = new Set(Array.isArray(list) ? list : []);
  return ALL.filter(k => want.has(k));
}

/* ---- what a single write needs ----------------------------------------- */

/* True when `next` only adds to `prev` - nothing removed, nothing renamed.
   This is what separates "I typed a task type that was not on the list" from
   "I reorganised the shop's list". */
function onlyAdditions(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  const have = new Set(next.map(String));
  return prev.every(v => have.has(String(v)));
}

/* The permission a change item requires, given what the database currently
   holds for that record (`existing` is the parsed json, or null for a create).
   Returns a permission key, or null when nothing is required.

   This is the enforcement point. Every mutating request goes through it, so a
   forged POST is refused on exactly the same rule as a hidden button. */
function requiredFor(item, existing) {
  const op = item.op || 'put';

  switch (item.kind) {
    case 'bid':
      if (op === 'delete') return 'bid.delete';
      if (!existing) return 'bid.create';
      // A decision is not an ordinary edit: it issues a job number and moves
      // the bid out of estimating.
      if ((item.json.awardNo || null) !== (existing.awardNo || null)) return 'bid.award';
      if (isDecision(item.json.status) !== isDecision(existing.status)) return 'bid.award';
      return 'bid.edit';

    case 'takeoff': return 'takeoff.edit';
    case 'proposal': return 'proposal.edit';

    case 'engineer':
      // Naming somebody new while entering a bid is ordinary work; editing or
      // removing an entry in the register is administering it.
      return (op === 'put' && !existing) ? 'list.extend' : 'settings.edit';

    case 'setting':
      if (op === 'delete') return 'settings.edit';
      if ((item.id === 'taskTypes' || item.id === 'regions') &&
          existing && onlyAdditions(existing, item.json)) {
        return 'list.extend';
      }
      return 'settings.edit';

    case 'catalog': return 'settings.edit';
    default: return 'settings.edit';
  }
}

function isDecision(status) { return status === 'Awarded' || status === 'Lost'; }

module.exports = {
  PERMISSIONS, ALL, ROLE_DEFAULTS,
  isPermission, clean, requiredFor, onlyAdditions
};
