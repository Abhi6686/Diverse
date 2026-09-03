# DiverSe Project Management

## Running it

```
npm start
```

then open **http://localhost:9000**. The console also prints the address other machines on the
office network use — that is the one to give the team.

**The first person to open it creates the first administrator.** There is no default password
anywhere in this app: the setup screen appears once, on a database with no accounts, and asks
for a name, a username and a password. Email is optional - it is not needed to sign in, and not
everyone in the office has one. Everyone else is created by an administrator from
**Settings › People**.

**Sign-in is by username, not email.** A username is 3-32 characters: letters, numbers, dots,
underscores or hyphens.

**Everyone shares one database.** The server keeps it in `diverse.db` beside the app; every
browser on the network is a window onto the same records, and an edit made on one machine
appears on the others without a refresh.

No dependencies. SQLite is `node:sqlite`, built into Node 22; the web server and the live
updates are `node:http`. Needs **Node 22.5 or newer**.

Other ways to start it:

```
node serve.js 3000                 # a different port
node serve.js --db D:\data\bids.db # a different database file
```

`npm start` passes `--disable-warning=ExperimentalWarning`, which silences the one notice
Node prints about `node:sqlite`. Running `node serve.js` directly works too — you will just
see that notice. It goes away on Node 24, where `node:sqlite` is stable.

### Backing it up

`diverse.db` is the whole thing. Stop the server, copy the file, done. The **Save** button
still downloads a `.json` of everything, which is a second belt-and-braces copy.

### Moving your existing data onto the server

If you have been using the app on one machine, its data is in that browser, not in the
database. Move it across once:

1. Open the app on that machine as you always have, and press **Save** to download the `.json`.
2. `npm run import -- that-file.json`

The importer runs the file through the app's own migration chain, so a backup from any older
version is accepted.

### Without a server

Double-clicking `Bid_Proposal_Manager_2026.html` still works, and still keeps its data in that
one browser. That is the single-user mode the app started as — useful on a laptop offline, but
nothing is shared. Firefox and Safari refuse IndexedDB on `file://` URLs and drop to a smaller
localStorage fallback; the app says so in an amber bar.

When the server goes away mid-session, the app says so rather than pretending: the footer shows
**Offline** and edits stop being accepted until it reconnects, so two people can never drift
apart and overwrite each other.

The original `Bid_Proposal_Manager_2026 (1).html` is left untouched as a reference copy.

## How the shared database works

| Piece | What it does |
|---|---|
| `server/schema.js` | the tables, as numbered migration steps |
| `server/db.js` | opens SQLite, reads and writes records, enforces uniqueness |
| `server/api.js` | `/api/bootstrap`, `/api/changes`, `/api/stream` |
| `server/sync.js` | who is connected, and pushing changes at them |
| `js/remote.js` | the browser end: fetch, diff, push, listen |
| `js/store.js` | unchanged contract — the rest of the app still just reads `Store.db` |

A few things worth knowing:

- **Only what changed is sent.** On save the client compares each record against the copy the
  server last confirmed and sends the difference. Sending the whole database would make the
  last person to type the winner.
- **Two people editing one bid do not silently overwrite each other.** Every record carries a
  revision; the second save is refused, the server's version is shown, and the app says so.
- **Proposal No. and Job No. are unique in the database itself**, not only in the form that
  types them. A check in the browser can be raced by two machines; a constraint cannot.
- **Dropping the connection is cheap.** Every change has a sequence number, so a browser that
  reconnects asks for what it missed rather than reloading everything.
- **Your column layout is yours.** It is a preference, not a record, so it is saved against
  your account rather than shared — and because it is against the account and not the browser,
  it is waiting for you on whichever machine you sit at. **Reset my table layout** is in the
  menu under your name.

## Accounts, roles and access

| Piece | What it does |
|---|---|
| `server/permissions.js` | every permission, and what each role starts with |
| `server/auth.js` | passwords, sessions, people, roles, the guard rails |
| `js/auth.js` | the sign-in screen, `Auth.can()`, the menu under your name |

Two roles exist from the start. **Admin** may do everything. **Employee** gets the whole of Bid
Management — add, edit, take-off, proposal, award, XLSX, download a backup — and nothing that
administers the shop or the people in it. Both are editable, and you can add more roles:
**Settings › Roles & Access** is a tick-box per permission per role.

| | Employee | Admin |
|---|:--:|:--:|
| Dashboard, Bid Management | ✓ | ✓ |
| Production / Inventory / Report / Scheduler | | ✓ |
| Add, edit, take-off, proposal, award, XLSX | ✓ | ✓ |
| **Delete a bid** | | ✓ |
| Settings | | ✓ |
| Save (download a backup) | ✓ | ✓ |
| **Load (restore over everything)** | | ✓ |
| People, Roles | | ✓ |

**Load is Admin-only, deliberately.** It was drawn as available to everyone back when the app
was single-user and it replaced your own data. On a shared server it replaces *everyone's* —
including work a colleague did five minutes ago. It now asks for confirmation that says so.
Move it back by ticking `project.load` for Employee if you disagree. **Save** is unchanged and
open to all.

Things worth knowing:

- **Every check is enforced on the server, not just hidden on the screen.** Hiding the delete
  button stops an honest mistake; the check in `server/api.js` is what actually protects the
  data, and it runs whether or not the request came from our own page. The test suite proves
  this by forging the request an Employee has no button for.
- **Permissions apply immediately.** They are read from the role on every request, so moving
  somebody to a different role takes effect at once — they reload the page to see the buttons
  change, but the server has already changed its mind.
- **One person is one account is one engineer.** Creating somebody with initials attaches them
  to the Engineers register, matching an existing entry where there is one, so the bids they
  have already worked show their name rather than a duplicate appearing beside it. Those
  entries are marked **account** in Settings › Engineers.
- **The last administrator cannot be locked out.** They cannot be deleted, deactivated or moved
  out of Admin, and Admin cannot have its own administration rights unticked, while they are
  the only one left.
- **Deactivating is usually what you want, not deleting.** It signs them out everywhere at
  once, stops them signing back in, and leaves their name on every bid they worked.
- **Passwords** are hashed with scrypt and a per-user salt — Node's own crypto, deliberately
  slow, so a copied `diverse.db` is not a list of everyone's passwords. Changing a password
  signs that person out of every other machine.
- **Sessions** are a random token with a row in the database, in an `HttpOnly` cookie. Signing
  out genuinely revokes; it does not just forget.

One thing to be honest about: this runs over plain HTTP on the office LAN, so the cookie is not
marked `Secure` — it could not be sent if it were. That is the right trade for a machine behind
the office firewall, and the wrong one for anything reachable from the internet. Do not port
forward this without putting HTTPS in front of it.

## The banner

`assets/diverse-logo.png` is the white-on-dark DiVerse lockup, copied from `qt=q_95.png`.
Note that the file named `Diverse_logo_white.png` is the **dark** version — a black wordmark
on transparency — so it is the wrong one for the slate header and is not used.

Hovering the banner throws welding sparks from behind the mark (`js/sparks.js`, plain canvas,
no dependency). It is decoration held to three rules: nothing animates unless the pointer is
on the banner, the loop stops itself once the last spark dies, and
`prefers-reduced-motion: reduce` turns it off entirely. A tap does one burst on touch devices.

## Navigation

Six top-level modules, of which one is built:

| Module | State |
|---|---|
| **Dashboard** | Month overview, KPI cards and the four charts |
| **Bid Management** | The working module: All Bids, Active Bids, Awarded Bids |
| Production Manager, Inventory Manager, Report Manager, Scheduler | Placeholders — each says so plainly rather than showing a mock-up |

### The three bid tabs are three stages, not three filters

| Tab | What is in it |
|---|---|
| **All Bids** | Every bid received. The intake register |
| **Active Bids** | The ones somebody has picked up and is still working |
| **Awarded Bids** | The job register — awarded only |

A bid reaches Active Bids by being **added** to it, from the project page or the ⚡ button in
the All Bids row. Until then it is a record you can read and edit, but not estimate: there is
no takeoff, no proposal and no award decision on a bid nobody has committed to.

**Picking up a bid whose project name is already on file stops to ask.** Rebids and second
packages genuinely share a name, so this warns rather than refuses: it names the bids already
on file, which list each is in and what number each carries. Say **no** and nothing happens at
all. Say **yes** and it goes on as a separate project needing its own Proposal No. The check
runs on both routes in, so neither can skip it. The seeded data has six such pairs in it.

The number on each tab is what that tab holds, ignoring the search box and the column
filters — it counts the list, not the view you have narrowed it to.

That means a bid you enter with **Add Bid** starts in All Bids and takes one more click to
reach Active Bids. Bids that existed before this change were all marked active, so nothing
moved on upgrade.

A bid leaves Active Bids when it is **Awarded** (it becomes a job) or marked **No Scope**
(that verdict is reached at intake, so it should never have been picked up). A **Lost** bid
**stays**, greyed, with its status showing — the work went into it, and hiding it hides that
from the list the estimators actually read. It can still be awarded from there if the job
comes back.

Two more pages are not in the module bar because they are not peers of the six — you reach
them by doing something rather than by picking a module:

| Page | How you get there |
|---|---|
| **Project** | Click any row in a bid list |
| **Settings** | The gear button in the header, beside Save and Load |

The three lists are one table over three sets of bids, so sorting, per-column filters and the
column selector work on all three. Each keeps **its own** column layout — hiding a column on
Awarded does not take it off Active.

### The project page

Clicking a bid opens it full screen: the app header, the module bar and the footer all get
out of the way, and the page carries its own bar with the project's name, number, region and
price, and a **← Bids** button back to the list you came from.

**What the page offers depends on the stage the bid is at**, which is the list you opened it
from:

| From | What you get |
|---|---|
| **All Bids** | The record card and one action — **Add to Active bid**. No job number, no estimate, no proposal: none of it exists yet. If the bid is already active the button reads **Open in Active Bids** and takes you across |
| **Active / Awarded Bids** | The workspace: **Overview**, **TakeOff**, **Proposal**, and the **Award ▾** decision |

TakeOff and Proposal used to be tabs in Bid Management, which meant nothing on screen said
which project you were estimating. They belong to a project, so that is where they live now.

Back returns you to the list you opened the project from — open a job from Awarded Bids and
Back takes you to Awarded Bids, not Active.

### Settings

The gear button collects everything that is shop-wide rather than about one bid:

**Rate Library**, **References**, **Regions**, **Engineers**, **Task Types** and **Company**
(the letterhead every proposal is printed under). Regions and Engineers used to be modals on the Bid
Management toolbar; they are full panels now, and Settings reopens on whichever panel you
left it on.

Two more sit below them for administrators: **People**, where accounts are created,
deactivated and given a role, and **Roles & Access**, which is a tick-box per permission per
role. They are the only panels here that are not part of `Store.db` — accounts live on the
server and are never sent to a browser that has no business holding them.

Settings only appears at all if at least one panel inside it admits you, so a role given
**People** but not the shop's reference data still reaches it, and lands on People.

### Pop-out windows

Every page reachable from a tab strip can be opened in its own window: hover the tab and click the
⧉ icon, or **Ctrl/Cmd+click** the tab. Useful for keeping a takeoff on one monitor and its
proposal on the other.

Both windows share one database, and edits in one refresh the other. If you are typing in a
field when the other window saves, you get a "changed in another window" bar instead of
having the value replaced under you.

Popping out the same page twice focuses the window you already have rather than opening a
second copy. A popped-out window never overwrites where the main window reopens.

The pop-out control is hidden when the app is running on the localStorage fallback, since
two windows would then hold two divergent copies of the data. Use `node serve.js`.

## What's new

Two tabs were added alongside the bid tracker:

- **TakeOff** — the estimating workbook as a form. Pick a product type (Steel Guardrail,
  Wall Mount Handrail, Bollard, Galvanized Platform, Stair, or a custom one), fill the
  material bill, the cost/labour block and the drawing-reference grid. A tree on the left
  shows every product, its component groups and its rolled-up cost, ending in the project's
  Total Bid Cost.
- **Proposal** — the client-facing document in all 9 styles from `Bid Proposal v3 1.html`,
  generated from a takeoff and printed to PDF with Ctrl+P.

Plus a **Rate Library** page, under Settings, holding the parts catalog and the labour/equipment rates.

## Everyday flow

1. **Active Bids** → click a row to open the project, then its **TakeOff** tab. (The
   calculator icon in the Actions column goes straight there.)
2. **Add Product Type** → the standard component groups and drawing-grid columns come with it.
3. **Materials** → start typing in *Vendor Part No* or *Description*; pick a suggestion and the
   vendor, grade, U/M and unit cost fill themselves in. Every field stays editable.
4. **Cost & Labour** → set *Total linear feet*; engineering, fabrication, installation hours and
   the finish quantity fill from the formulas. Type over any of them and it turns amber and stops
   following the formula — the ↺ button puts it back.
5. **Drawing Takeoff** → enter quantities per drawing reference. *use as total* copies a column's
   subtotal into Total LF.
6. **Save takeoff** → the total flows back to the bid's Bid Price and LF, and any part the rate
   library hasn't seen is added to it.
7. **Proposal** → generates one scope item per product type, each carrying that product's
   Total Linear Feet. Ctrl+P → Save as PDF.

## The rate library grows on its own

Every material row you save is folded into the catalog:

- A part it hasn't seen is added, tagged with the product type you used it on.
- A part it knows whose price changed gets the new price plus a dated history entry;
  the row shows a ▲/▼ chip against the old price.
- Suggestions are ranked by whether the part has been used on this product type, how often
  you use it, and how recently — so the list stays useful as it grows.
- Identity is vendor + part number, falling back to the description when there's no part
  number. Near-duplicates surface as a "review" prompt on the Rate Library page rather than
  being merged silently.

## The numbers on a bid

Three, each doing one job.

### Sr. No. — where the row is

The first column. It counts the rows on screen, 1, 2, 3, and is **not stored on the bid**.
That is deliberate: the ordinal it replaced was a saved value, so every deletion left a hole in
it (1, 3, 4, 5…). A counter cannot fall out of sequence — it *is* the position, so it
renumbers itself after a deletion and follows a re-sort. It is on all three tabs.

Because it is positional it is not a name for anything. The number that identifies a project
is the Proposal No.

### Proposal No. — which project this is

**Only asked for once the bid is active.** A bid that has just arrived is identified by its
name and its place in the list, so the Add New Bid form does not have the field at all — and
neither does editing a bid still sitting in All Bids. It appears, under **Active stage**,
the moment the bid is picked up. (A number already on a record is preserved while hidden, not
wiped.)

It is **unique across the whole register**: saving a bid whose
Proposal No. is already on another one is refused, with a message naming the bid that holds
it. The match ignores case and surrounding spaces, so `dis-p-1042` and `DIS-P-1042 ` count as
the same number rather than sneaking past as two.

It follows the project outward — a takeoff started on the bid picks it up, the generated
proposal prints it, and changing it on the bid updates both rather than leaving a stale number
on a document that has already gone out. One project, one number, everywhere it appears.

Blank is allowed: a bid that has just arrived need not have one yet, and several blanks are
not duplicates of each other.

### Job No. — which job this became

Issued when a bid is **awarded**, of the form `DIS-26-0001`:

- `26` is the year it was awarded, and the sequence restarts each year — the first award of
  2027 is `DIS-27-0001`.
- Allocated as *highest existing for that year + 1*. Deleting a job does not free its number
  for reuse, because a number that has been on paper must never turn up on a second job.
- **Permanent.** Moving a bid out of Awarded keeps it, and re-awarding does not renumber it.

| Tab | Numbers shown |
|---|---|
| **All Bids** | Sr. No., Proposal No. |
| **Active Bids** | Sr. No., Proposal No. |
| **Awarded Bids** | Sr. No., Job No., Proposal No. |

## Awarding, and losing

**Award ▾** on the project page (and the 🏆 button in the Actions column) offers the two ways
a bid stops being worked:

- **Award** — issues the job number and moves the bid to Awarded Bids.
- **Mark Lost** — issues nothing. Job numbers identify work we are actually doing.

Both ask first; the award names the number it is about to issue.

Awarded and Lost are **not** on the Add/Edit Bid form's status list. They are the outcome of
this decision, which is also what issues the number, so they are not values you type. A bid
that already holds one keeps it when you edit — opening an awarded job and pressing Save
never demotes it.

The statuses you *can* set are **Not Started**, **In Progress**, **Submitted to review**,
**Completed** and **No Scope**.

The Awarded tab is awarded jobs only, so a lost bid is never hidden there — it stays on
Active Bids. Adding a No Scope or Awarded bid back to Active Bids reopens it at Not Started;
adding a Lost one back leaves its status alone, because Lost is a state Active Bids can hold.

## Hours: two stages, and a team sheet

Hours are recorded **twice, for different things**, and the two never mix:

| Stage | What it records | Where you edit it |
|---|---|---|
| **Intake**, on All Bids | The first pass — one engineer's guess at what looking at this will take | The *First pass* block on the Add/Edit Bid form |
| **Team**, on Active Bids | What the job actually took, per engineer per task | The **Team & Hours** card on the project page |

A promoted bid starts with **no team hours**. It does not inherit the intake guess: a number
put on a bid before anyone picked it up is not the effort the job took, and letting one become
the other is exactly what this split exists to stop.

The Team & Hours card is a row per engineer per task:

```
ENGINEER   DESCRIPTION          ESTM HRS   ASGN HRS
AF         Shop drawings           12.0        4.0
MGJ        Submittal review         6.5        2.0
────────────────────────────────────────────────────
2 rows · 2 engineers                18.5        6.0
```

One engineer can have several rows — that is how you see where their time went. The bid's
**Estm Hrs** and **Asgn Hrs** columns on Active Bids are the sums of those rows, never typed,
so a total cannot drift from its parts. Both tabs head the columns the same way; each shows
its own stage's figures. The column selector distinguishes them as *(intake)* and *(team)*.

**Description** is the task type, from a list you keep under **Settings → Task Types**.
`+ Add new task type...` on the card adds to that same list. Renaming a type there carries
onto every row using it; deleting one warns if it is in use and leaves the value on those rows.

The XLSX export carries both stages, plus a **Team Hours** sheet with one row per engineer per
task so the hours can be pivoted by person or by task type.

## Exporting a takeoff to Excel

**Export to Excel** under the Project Cost Summary writes the whole estimate as one workbook:
a **Summary** sheet — the same rollup the rail shows, down to Total Bid Cost — then one
worksheet per product, each with its materials, its cost and labour lines, and the drawing
grid its quantities came from. Each product's ⋮ menu still exports that sheet on its own.

The materials table has no **Options** column. It held an abbreviated restatement of the
Description — `8" SCH 40` beside `Carbon Steel 8 SCH 40 PIPE A-500 GR B 8.625" OD .322 Thk.` —
which meant typing the specification twice and gave the proposal the shorter of the two to
print. The Description is what the client should read, so it is the one kept, and the
proposal's spec bullets now read **feature — description**.

## The Add / Edit Bid form

Renamed to match how the team talks about the work:

| Was | Now |
|---|---|
| Railing Type | **Product** |
| Scope Prep Hrs | **Assigned Hrs** |

Field order is Project / Portal / Region, then
Product / Material / Bid Price, then the **First pass** block — Engineer, Estimation Hrs,
Assigned Hrs — which is the intake stage only. Editing an active bid shows its team total
beside that block, so it is never mistaken for the project's hours.

Estimation Hrs and Assigned Hrs are **separate columns** in the bids table rather than one
combined Hrs figure, headed **Estm Hrs** and **Asgn Hrs** to keep them narrow.

**There is no Total Hrs anywhere, on purpose.** The two are the same work measured from
opposite sides — what the job was expected to take, and what was booked to it — so adding
them counts the job twice. Each column totals down its own rows and nothing totals across
them. Compare the two figures if you want to know whether an estimate held.

**Product** takes **more than one value** — a project that covers railing, bollards and
stairs records all three. Pick from the dropdown and each choice becomes a removable chip;
already-selected items drop out of the dropdown so you can't add the same one twice.

The list is seeded with Railing, Metal Platform, Bollard and Metal Stairs. Pick
**+ Add new product...** to add your own — it's saved to the list and available on every
bid from then on. Bids created before this change keep their old free-text description as
an amber chip, without adding clutter to everyone else's dropdown; you can leave it, remove
it, or add managed products alongside it.

Active Bids shows up to three products per row as chips, then `+N` with the full list on
hover. Search matches across all of them, and the XLSX export joins them with `;`.

Note this is a different list from the takeoff's product types (Steel Guardrail,
Wall Mount Handrail, and so on). This one categorises the *bid*; the takeoff one picks
which estimating *sheet* you're filling in.

**Engineer** was added — it autocompletes from names already on other bids (so
"J. Smith" and "J Smith" don't split one person in two) and shows as its own column
in Active Bids. It's searchable from the Active Bids search box.

**Total LF** and **Bid Doc Hrs** were removed from the form. LF now comes from the
takeoff automatically. Bid Doc hours stay untouched on bids that already had them.

## Rates: shop-wide, then per project

The **Rate Library** page, under Settings, holds the shop defaults. A single job that was priced at a different
rate sets its own on the takeoff's **Rates** page (the sliders icon beside the project name).

A project stores **only the fields you changed**, shown amber with a ↺ to drop back to the
shop default. Everything else keeps following the Rate Library, so a shop-wide rate rise
still reaches every project that never overrode that field.

An explicit project rate beats the workbook's per-product quirks. Setting Fabrication to
$135 for one job means $135 on every product in it, including Wall Mount Handrail, which the
workbook otherwise pins at $125.

Hour factors recalculate at once. Unit rates are stored on each product when it is added, so
changing one shows `2 products still bill Fabrication at $120/hr — Steel Guardrail, Stair`
with an Apply button. It names the products first because a rate typed on one product on
purpose is data, not drift.

## The Finish line

Every product's first Cost & Labour row begins with a fixed **`Finish - `** that cannot be
selected, deleted or typed over. You supply the rest:

```
Finish - Painted / For exterior: Powder coated
Finish - Anodized Exterior
Finish - Hot Dip Galvanized
```

The prefix carries through to the proposal bullets and the XLSX sheet export. Existing
takeoffs are migrated: a stored `Finish: Painted` becomes `Finish - Painted`, not
`Finish - Finish: Painted`.

## The printed proposal

The document is laid out to match the bid proposal the office sends: a logo card with the
contact block beside it, a centred **BID PROPOSAL** with the scope line beneath it, the five
identifying fields, then the scope as ruled entries — title left, price right, specification
bulleted underneath — a **TOTAL BID PRICE** panel, and the contract half behind a
`CONTRACT DETAILS & TERMS` divider: Terms, Inclusions, Payment, then the signature line.

**It is paginated into real letter-size pages,** each carrying the running header and its own
`Page 3`. On screen you see the same sheets that come out of the printer, broken in the same
places.

That is done in JavaScript ([js/proposal.paginate.js](js/proposal.paginate.js)) because a
browser cannot do it: `counter(page)` only exists inside `@page` margin boxes, which Chrome
does not implement, and a `position: fixed` header repeats on every sheet but has no idea
which sheet it is on. So the document is measured against the live stylesheet and dealt into
pages the way a typesetter would. A long list — Terms & Conditions — is broken between its
items and keeps its styling on the continuation; a heading is never left alone at the foot of
a page.

Two things worth knowing if you ever touch that file:

- **Blocks carry their spacing as padding, never margin.** Two adjacent margins collapse into
  one, so a block's height would depend on what preceded it and every measurement after a page
  break would be wrong.
- **Content is measured in a page that is free to grow, never in a real one.** `scrollHeight`
  never reports less than `clientHeight`, so inside a fixed-height page every block shorter
  than a full sheet measures as a whole sheet. This one cost an afternoon.

Nine style palettes are still available and the layout is shared by all of them — the styles
supply colour, not arrangement.

## Getting back to a proposal

The Actions column on a bid row has a document icon next to the calculator. It opens the
proposal already generated for that bid; if there is a takeoff but no proposal yet, it
generates one.

A proposal is a snapshot, so it can fall behind the estimate it came from. When the takeoff
has changed since, the proposal shows an amber strip and a **Regenerate** button. Scope items
you have locked (🔒) keep their wording through a regenerate.

## Miscellaneous costs on the proposal

The Miscellaneous line (welding consumables, tooling, packaging) is **never shown to the
client**. Its value is spread equally across the product lines instead — one product takes
the whole amount, four products take a quarter each.

The split is done in whole cents with the remainder handed out one penny at a time, so
`324.80` over three products becomes `108.27 / 108.27 / 108.26` and the Total Bid Price is
unchanged. It still reconciles exactly with the takeoff's Total Bid Cost.

Freight, tax and roundoff stay as their own lines. Untick **Show freight / tax / roundoff
as separate lines** on the Scope Items tab to fold those into the product prices too —
the total stays the same either way.

## Reference tables

The References page, under Settings, holds the estimating rules of thumb — engineering and installation hours
per LF, platform hours, shop painting rates, pipe schedules. Press **Edit tables** and every
table heading, column heading, row name and value becomes editable; changes save with the
project.

There is **no delete**. A reference row that looks wrong is nearly always a rate that needs
correcting rather than a line to remove, so the only ways to change a table are editing it or
**Restore defaults**, which puts one table back to the shipped values.

Values are free text, so ranges like `0.15 - 0.25` and sizes like `1.900" (48.3 mm)` keep
their form instead of being flattened by a number field.

## Dates

Everything reads and writes **MM-DD-YYYY** — the bid Due Date, the proposal's Submitted
Date and Approval Deadline, every table, and the printed proposal.

Date boxes are text fields rather than the browser's native date input, because that
control renders in whatever order the browser's locale wants (dd-mm-yyyy here) and a page
cannot override it. Type `09152026` and the dashes appear as you go; the calendar icon
still opens the native picker. A date that does not exist (`02-30-2026`) turns the field
red and blocks the save rather than being silently discarded.

Stored values stay ISO `YYYY-MM-DD`, so sorting and existing `.json` backups are unaffected.

## Your data

Auto-saved to browser localStorage on every change. **Save** in the header downloads a
`.json` of everything (bids, takeoffs, proposals, rate library); **Load** restores it.
Clearing browser data without a backup loses the lot.

`Save .json` on the Proposal tab writes the v3-compatible template format, so a proposal
still opens in `Bid Proposal v3 1.html` via its Load Template button, and templates saved
there load here.

## Two things found in the Lancaster workbook

Both are reproduced faithfully, but you should know they're there:

1. **The Galvanized Platform sheet uses different hour factors** from every other sheet —
   `LF×0.6+16` / `LF×1.8` / `LF×1`, against `LF×0.3+16` / `LF×0.6+24` / `LF×0.5` elsewhere.
   Modelled as a per-product-type override in `js/rates.js`.
2. **Three Platform rows have `+(1000*2)+(200*2)` hand-appended inside the formula**
   (`L44` installation, `L45` supervisor, `L47` truck) — $2,400 each, $7,200 total, invisible
   in the printed sheet because the Qty × Unit Price shown doesn't equal the Total shown.
   Here that money goes on explicit **Add other charge** rows so it appears in the total and
   on the proposal. Worth confirming it was intended.

## Tests

```
npm test                              # all four suites
```

or one at a time:

```
npm run test:costs   # cost maths vs the workbook, to the cent
npm run test:api     # 100 checks: schema, conflicts, uniqueness, the change log, accounts
npm run test:ui      # 521 checks driving the app in a real DOM
npm run test:sync    # 37 checks: two browsers, two people, one server, live
```

`test:ui` and `test:sync` need `npm install --no-save jsdom fake-indexeddb`. The other two
have no dependencies at all.

`verify-lancaster.js` reproduces all five product sheets and the Project Cost Summary,
ending at **Total Bid Cost $619,300.12**.

`sync.js` is the one that proves the shared part works: it starts a real server, opens two
browsers against it — one signing up through the setup screen as an Admin, the other logging in
as an Employee, each with its own cookie jar — and checks that an edit in one shows up in the
other, that a conflict is reported rather than lost, that the Employee's screen has no delete
button, that a delete forged past the screen is refused anyway, and that one person's column
layout does not move anybody else's.

`api.js` covers the same ground at the wire: what an Employee may and may not do when the
request is written by hand, that adding to a managed list while working a bid is allowed while
reorganising it is not, that the last administrator cannot be deleted, deactivated, demoted or
have their role's rights unticked, and that deactivating somebody kills their session on the
spot.

## Files

| File | Purpose |
|---|---|
| `Bid_Proposal_Manager_2026.html` | markup shell; open this |
| `js/nav.js` | the modules, their sub-menus, the page chrome and the pop-out windows |
| `serve.js` | the server: static files plus the /api routes |
| `server/schema.js` | database tables, as numbered migration steps |
| `server/db.js` | SQLite: reads, writes, revisions, uniqueness |
| `server/api.js` | bootstrap, changes, the live stream, sign-in, people and roles |
| `server/auth.js` | passwords, sessions, accounts, roles, the guard rails |
| `server/permissions.js` | every permission and what each role starts with |
| `server/sync.js` | connected clients and what to push at them |
| `tools/import-json.js` | moves an exported .json onto the server |
| `js/auth.js` | the sign-in screen, `Auth.can()`, the menu under your name |
| `js/remote.js` | the browser end of the shared database |
| `js/store.js` | state, the server/IndexedDB backends, project save/load, schema migrations |
| `js/ratespanel.js` | the Labour/Equipment/Markup grid, shared by Rate Library and each project |
| `js/rates.js` | rate defaults, hour formulas, product templates |
| `js/catalog.js` | rate library: fuzzy suggest, auto-learning, price history |
| `js/catalog.seed.js` | 60 parts extracted from the workbook |
| `js/takeoff.model.js` | cost maths and the `fx` quantity evaluator (no `eval`) |
| `js/takeoff.js` | Takeoff tab UI |
| `js/proposal.js` | proposal document, editor, print |
| `js/proposal.paginate.js` | measures the document and deals it into numbered pages |
| `js/proposal.styles.js` | the 9 styles, lifted verbatim from v3 |
| `js/proposal.defaults.js` | terms / payment / inclusions boilerplate from v3 |
| `js/bids.js` | the bid tracker: statuses, the three stages, promotion and the award/lost decision |
| `js/assignments.js` | the Team & Hours rows and their totals |
| `js/sparks.js` | the banner's welding sparks, on hover |
| `js/project.js` | the full-screen project page and its three stages |
| `js/settings.js` | the Settings page: rail, Regions, Engineers, Company, People, Roles |
| `js/ratelib.js` | Rate Library page |
| `js/seed.js` | first-run bid and region data |
