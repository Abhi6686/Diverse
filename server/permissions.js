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
  /* Moving a bid BACK a stage is ordinary work covered by bid.edit - an award
     gets rescinded, a bid gets picked up by mistake. Erasing the record that it
     happened is not: the history is what the office is answerable to. */
  { key: 'bid.history.delete', group: 'Bids', label: 'Delete an entry from a bid history' },
  { key: 'bid.export', group: 'Bids', label: 'Export the table to XLSX' },
  { key: 'takeoff.edit', group: 'Bids', label: 'Edit take-offs' },
  { key: 'proposal.edit', group: 'Bids', label: 'Edit proposals' },
  /* Deliberately separate from settings.edit. Somebody working a bid types a
     new engineer's initials or a task type that is not on the list yet, and the
     app adds it. That is not "administering the shop-wide lists" - and without
     its own permission an estimator's whole save would be refused for it, since
     a batch is all-or-nothing. See requiredFor(). */
  { key: 'list.extend', group: 'Bids', label: 'Add an engineer or task type while working a bid' },
  /* Save takeoff teaches the Rate Library: parts it has not seen are added,
     a changed price is versioned, and every part used has its count bumped.
     That is estimating work, not administering the library - and while it sat
     under settings.edit, an Employee's every Save takeoff was refused whole,
     takeoff and all. Editing or removing parts on the Rate Library page stays
     settings.edit. See learnOnly(). */
  { key: 'catalog.learn', group: 'Bids', label: 'Teach the Rate Library from a takeoff (new parts, prices, usage)' },

  /* Production Manager. Taking an awarded job into production and assigning
     engineering work are decisions; raising a request, writing up a job
     order and reporting progress on the floor are the work itself. */
  { key: 'so.edit', group: 'Production', label: 'Create and edit sales orders (Add to Production Manager)' },
  { key: 'engreq.create', group: 'Production', label: 'Raise engineering requests and post in their conversations' },
  { key: 'engreq.manage', group: 'Production', label: 'Assign engineering requests - engineer, due date, hours' },
  { key: 'jo.edit', group: 'Production', label: 'Create and edit job orders - routing, bill of material, drawings' },
  { key: 'shopfloor.update', group: 'Production', label: 'Report operation status and quantities from the shop floor' },

  /* Inventory Manager. */
  { key: 'inventory.edit', group: 'Inventory', label: 'Add and edit parts, and receive stock' },

  { key: 'settings.view', group: 'Settings', label: 'Open Settings' },
  { key: 'settings.edit', group: 'Settings', label: 'Change rates, regions, references, company' },

  /* Both of these gated the Save and Load buttons, which are gone: the database
     is a shared file that is written as you type, so there is no backup to
     download through the browser and nothing to restore through it either.

     THE KEYS STAY. Dropping one from this list would silently revoke it from
     every saved role - clean() keeps only keys it recognises - and that is a
     migration, not a deletion. project.load kept a real job on the way past: it
     is what gates Reset, which wipes the database back to seed data and has the
     same blast radius restoring a backup did. project.save now gates nothing
     and is granted to nobody; it is left here so an old role row carrying it
     stays readable rather than being quietly rewritten. */
  { key: 'project.save', group: 'Whole database', label: 'Unused - was: download a backup' },
  { key: 'project.load', group: 'Whole database', label: 'Reset the database to seed data' },

  { key: 'admin.users', group: 'Administration', label: 'Create and manage people' },
  { key: 'admin.roles', group: 'Administration', label: 'Create roles and change what they may do' }
];

const ALL = PERMISSIONS.map(p => p.key);

/* The shop-wide lists somebody working a bid may add to without being an
   administrator. See requiredFor(). */
const EXTENDABLE_LISTS = ['taskTypes', 'regions', 'productTypes', 'materials'];

/* The two roles the first run creates. Employee is the access level marked on
   the screenshots: every page and action of Bid Management, nothing that
   administers the shop or the people in it. */
const ROLE_DEFAULTS = {
  Admin: ALL.slice(),
  Employee: [
    'module.dashboard', 'module.bids',
    'bid.create', 'bid.edit', 'bid.award', 'bid.export',
    'takeoff.edit', 'proposal.edit', 'list.extend', 'catalog.learn',
    // Production and Inventory - see schema step 9 for existing databases.
    'module.production', 'module.inventory', 'engreq.create', 'jo.edit',
    'shopfloor.update', 'inventory.edit'
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

/* True when `next` differs from the Rate Library part `prev` only in the ways
   Catalog.learn (js/catalog.js) changes one: usage counted, a price versioned,
   a stock size learned, a product type tagged, an empty description filled in.
   Anything else - a renamed part, a changed vendor, a removed tag, an
   overwritten description - is editing the library, and needs settings.edit. */
const LEARN_FREE = ['useCount', 'lastUsedAt', 'unitCost', 'priceHistory', 'packQty'];
const LEARN_FILL = ['description', 'feature', 'option', 'material', 'grade', 'um', 'packUm'];

function learnOnly(prev, next) {
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return false;
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const keys = new Set(Object.keys(prev).concat(Object.keys(next)));
  for (const k of keys) {
    if (LEARN_FREE.indexOf(k) >= 0) continue;
    if (k === 'sowTags') {
      if (!same(prev.sowTags, next.sowTags) && !onlyAdditions(prev.sowTags || [], next.sowTags)) return false;
      continue;
    }
    if (LEARN_FILL.indexOf(k) >= 0) {
      if (!same(prev[k], next[k]) && prev[k]) return false;    // only an empty one may be filled
      continue;
    }
    if (!same(prev[k], next[k])) return false;
  }
  return true;
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
      // The lists an estimator legitimately extends mid-bid: a task type on the
      // Team & Hours card, a region on the bid form, a product or material on
      // the Products & Materials card. Adding to one is ordinary work;
      // reordering or removing entries is administering the shop's lists.
      if (EXTENDABLE_LISTS.indexOf(item.id) >= 0 &&
          existing && onlyAdditions(existing, item.json)) {
        return 'list.extend';
      }
      return 'settings.edit';

    case 'catalog':
      if (op === 'delete') return 'settings.edit';
      if (!existing) return 'catalog.learn';
      return learnOnly(existing, item.json) ? 'catalog.learn' : 'settings.edit';

    // Production and Inventory. Finer rules (who may move a request to which
    // step, what the shop floor may change on a job order) arrive with the
    // pages that make those changes.
    case 'salesorder': return 'so.edit';
    case 'engrequest': return op === 'delete' ? 'engreq.manage' : 'engreq.create';
    case 'joborder': return 'jo.edit';
    case 'part': return 'inventory.edit';
    default: return 'settings.edit';
  }
}

function isDecision(status) { return status === 'Awarded' || status === 'Lost'; }

module.exports = {
  PERMISSIONS, ALL, ROLE_DEFAULTS,
  isPermission, clean, requiredFor, onlyAdditions, learnOnly
};
