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

No runtime dependencies. SQLite is `node:sqlite`, built into Node 22; the web server and the
live updates are `node:http`. Needs **Node 22.5 or newer**.

### Changing how it looks

The stylesheet is built rather than fetched. `assets/tailwind.css` is compiled from the class
names used in the HTML and in `js/`, and it is **committed** — so a machine that has never run
`npm install` still serves a fully styled app.

```
npm run build:css     # after adding or changing a class name
npm run watch:css     # rebuild as you edit
```

If you add a class and the styling does not appear, that is the rebuild you missed. Only class
names the compiler can *see* get shipped, which means a class name has to appear in the source
as a complete string: `'bg-' + tone + '-600'` produces nothing, and `'bg-emerald-600'` written
out in full works. The existing code already follows this rule.

Colours are named for their job, not their shade — `bg-surface`, `text-muted`, `border-line`,
`bg-brand`. What each one resolves to, in both the light and the dark theme, is
`assets/tokens.css`. That is the only file in the app that names an actual colour.

Other ways to start it:

```
node serve.js 3000                 # a different port
node serve.js --db D:\data\bids.db # a different database file
```

`npm start` passes `--disable-warning=ExperimentalWarning`, which silences the one notice
Node prints about `node:sqlite`. Running `node serve.js` directly works too — you will just
see that notice. It goes away on Node 24, where `node:sqlite` is stable.

### Backing it up

`diverse.db` is the whole thing. Stop the server, copy the file, done. That *is* the backup —
there is no Save button any more, because a `.json` pulled through a browser was a copy that
went stale the moment a colleague typed.

### Moving your existing data onto the server

If you have been using the app on one machine, its data is in that browser, not in the
database. Move it across once:

1. On that machine, open the browser console and run
   `copy(JSON.stringify(Store.db))`, or use an older build's **Save** button if you still
   have one, to get the `.json` out.
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
- **The project number is unique in the database itself**, not only in the form that types it.
  A check in the browser can be raced by two machines; a constraint cannot.
- **Dropping the connection is cheap.** Every change has a sequence number, so a browser that
  reconnects asks for what it missed rather than reloading everything.
- **Your column layout is yours.** It is a preference, not a record, so it is saved against
  your account rather than shared — and because it is against the account and not the browser,
  it is waiting for you on whichever machine you sit at. **Reset my table layout** is in the
  menu under your name.
- **You can see who else is in a project.** The server already knew who was connected; it now
  also knows what each of them has open, because each window says so. A project somebody else
  is looking at is marked in the bids table and on the project's own header, with their
  initials — live, appearing and clearing as people come and go. Nobody is locked out and
  nothing is blocked: it is so you can ask before you both start, and the revision check above
  is still what actually prevents a lost edit.

## Accounts, roles and access

| Piece | What it does |
|---|---|
| `server/permissions.js` | every permission, and what each role starts with |
| `server/auth.js` | passwords, sessions, people, roles, the guard rails |
| `js/auth.js` | the sign-in screen, `Auth.can()`, the menu under your name |

Two roles exist from the start. **Admin** may do everything. **Employee** gets the whole of Bid
Management — add, edit, take-off, proposal, award, XLSX — and nothing that
administers the shop or the people in it. Both are editable, and you can add more roles:
**Settings › Roles & Access** is a tick-box per permission per role.

| | Employee | Admin |
|---|:--:|:--:|
| Dashboard, Bid Management | ✓ | ✓ |
| Production / Inventory / Report / Scheduler | | ✓ |
| Add, edit, take-off, proposal, award, XLSX | ✓ | ✓ |
| **Delete a bid** | | ✓ |
| Settings | | ✓ |
| **Reset the database to seed data** | | ✓ |
| People, Roles | | ✓ |

**Save and Load are gone.** They were a whole-database round trip through a `.json` file,
from when the app ran off one browser's storage. On a shared server Save handed you a copy
that was stale the moment a colleague typed, and Load wrote that copy over everyone's
afternoon. Backups are copies of `diverse.db`.

The two permission keys stay on the roles screen — dropping one would silently revoke it from
every saved role, which is a migration rather than a deletion. `project.load` kept the narrower
job it was already doing: it gates **Reset**, which wipes the database back to seed data and
has the same blast radius restoring a backup did. `project.save` now gates nothing.

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

### Where it opens, and the guide

**Opening the app and reloading it are different events, and they get opposite answers.** A new
tab or window lands on the **Dashboard** — the state of the office. Pressing F5 keeps you
exactly where you were, including which project and which of its tabs, because a reload is not
a decision to go somewhere else.

The page you were on is remembered *per tab*, so two windows on two projects each reload onto
their own. It used to be remembered per person, saved with your column layouts — which meant
leaving the app on a proposal reopened it inside that document every time, and on a shared
machine a brand-new account inherited the last page of whoever used the browser before them.

**The sign-in page welds the mark into place.** DiVerse fabricate and install miscellaneous
metals, so the logo is laid down rather than merely displayed: an arc travels across it with
sparks coming off the seam, the metal behind cools from white-hot to its own colour, sparks
that reach the floor bounce and skitter, and the company's own two lines — *Trust Through
Quality Work*, *Safety is our foundation* — come up as it finishes.

**The depth is real, not drawn.** The scene is a CSS `perspective` stage with the plate, the
drawing grid, the mark and the spark canvas at different `translateZ`, and the mark itself is
ten copies of the artwork stacked backwards in z, each a shade darker — so rotating the stage
shows the *side* of the letters, because there is one. Nothing here fakes dimension with a skew
and a drop shadow; the browser is doing the projection. On top of that: a slow idle float so it
is alive when nobody is touching it, pointer parallax that separates the planes as you move, a
specular sweep masked to the artwork so the highlight travels across the letters rather than
over the box they sit in, a laid-back reflection on the plate, and a hair of blur on the
backdrop.

The weld runs about two and a half seconds and then stops; clicking the mark runs it again, as
does **Replay**. After that only CSS animates — no JavaScript frame loop ticks while somebody
is typing a password. `prefers-reduced-motion: reduce` gets the finished mark with its depth
and no motion at all, a hidden tab paints nothing, and a browser with no canvas gets the plain
image. It is the same particle engine as the banner's hover sparks
([js/sparks.js](js/sparks.js)), not a second one — see [js/intro.js](js/intro.js).

**Signing in.** The password field has a reveal button, off by default: a password you cannot
see on a shop-floor machine is a password you mistype, and this app already cost somebody a
reset over it. Caps Lock is called out while the field has focus. A failed attempt keeps your
username and clears only the password. And the hint under the button says what the field
actually wants — your **username**, not your email address.

**The ? button in the header opens the user guide** — every part of the app, what it does and
how it is meant to be used. The sign-in screen carries the headline half of the same document,
so somebody without an account can still find out what this is. Both are written in one place
([js/guide.js](js/guide.js)); there is no second copy to go stale.

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
reach Active Bids.

**Bids that existed before this change were all marked active**, so that the tab would not
empty on upgrade — and that put the whole intake register on the working list, where ninety-odd
enquiries nobody had picked up sat beside the handful actually being worked. Since a bid is
issued its Proposal No. at the moment it is picked up, carrying a number is the test for having
been picked up, and anything active without one has now been put back where it belongs.
**Nothing was deleted**: those bids keep their team rows, hours, takeoffs and history, they are
still in All Bids, and *Add to Active bid* brings any of them back — with a number this time. A
bid with an outcome — Awarded, Lost, No Scope — is never moved by this, whatever its number.

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
| **Settings** | The gear button in the header |

The three lists are one table over three sets of bids, so sorting, per-column filters and the
column selector work on all three. Each keeps **its own** column layout — hiding a column on
Awarded does not take it off Active.

**Your layout is yours, and it follows your login.** The column order, which columns are
shown, the sort, the filters, the row density and the calendar zoom are all saved per view
against your account rather than against the browser — so they are waiting for you on
whichever machine you sit at, and a colleague rearranging their columns never moves yours.
**Reset my table layout**, in the menu under your name, puts every table back to its
defaults; it leaves your theme and the tab you are on alone, because resetting tables should
not turn the lights on or throw you to another page.

### Last Modified

A sortable **Last Modified** column, on by default on Active Bids and one tick away on the
other two. It answers "what moved today" from the list, instead of opening bids one at a
time to read their History cards.

```
LAST MODIFIED
   2h ago          hover: 09-22-2026 17:57 IST · ABH
    ABH
```

Shown as how long ago with the exact IST stamp on hover — an absolute timestamp is the right
thing when you are reconciling one record and the wrong thing in a column of forty, where it
has to be subtracted from today before it means anything. A bid nobody has edited since it
was entered reads as its arrival rather than as a blank.

It is written on every change the History card records, from that entry's own timestamp, so
the column and the top line of the card are the same fact and cannot drift apart.

### The project page

Clicking a bid opens it full screen: the app header, the module bar and the footer all get
out of the way, and the page carries its own bar with the project's name, number, region and
price, and a **← Bids** button back to the list you came from.

**What the page offers depends on the stage the bid is at**, which is the list you opened it
from:

| From | What you get |
|---|---|
| **All Bids** | The record card and one action — **Add to Active bid**. No project number, no estimate, no proposal: none of it exists yet, and picking the bid up is what issues the number. If the bid is already active the button reads **Open in Active Bids** and takes you across |
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
- **Proposal** — the client-facing document, generated from a takeoff and printed to PDF with
  Ctrl+P. Thirteen styles: the original nine from `Bid Proposal v3 1.html`, plus four typeset
  ones added later —

  | | | |
  |---|---|---|
  | **10 · Serif Letterhead** | serif throughout, generous leading | reads as a professional-services letter |
  | **11 · Engineering Document** | titleblock header, monospaced figures, ruled tables | familiar to anyone who reads shop drawings |
  | **12 · Modern Accent** | mostly white, wide margins, one accent colour | contemporary and quiet |
  | **13 · Lancaster** | a reproduction of the PDF the shop already sends | the default for new proposals |

  The original nine are **frozen** — proposals already sent to clients were printed under
  them, and changing one would change a document somebody has on file. The later four work by
  adding a single key the others do not have, so the nine render byte-identically.

  **13 · Lancaster** is Style 3 of the v3 app, which is what printed
  `Bid Proposal_Lancaster Township.pdf`. It is not an impression of that document: every size
  and weight was read back out of the v3 bundle's own class strings and cross-checked against
  the PDF's embedded fonts and point sizes, converted at the 1px = 0.75pt Chrome prints at.
  Its typography follows one rule, which is what keeps four levels of hierarchy on a page
  without it looking like a poster:

  | Face | Used for |
  |---|---|
  | **Inter** 800 | structure only — section headings and scope-item titles |
  | **Segoe UI** 400–900 | everything a person reads: the letterhead, the details grid, `BID PROPOSAL`, the slogan, all prose |
  | **Consolas** | money only — line prices and the total |

  Money is the one place a monospace earns its keep, because a column of figures lines up on
  the digit. A reference number or a project name is read once, not compared down a column,
  so it sits with the prose — which is why the proposal number and the project name beside it
  are now in the same face, and why the letterhead is one face rather than three.

Plus a **Rate Library** page, under Settings, holding the parts catalog and the labour/equipment rates.

### One number, for the project's life

**`DIS-26-0001` is issued the moment a bid is picked up** — All Bids → Active Bids — and it
never changes again. It is the Proposal No. printed on the document that goes to the client,
and it is still the number the job is known by after it is won. The sequence restarts each
January and a number is never reissued, not even if the bid it belonged to is deleted.

It used to be issued at award, as a separate Job No. That was too late to be any use: the
proposal that won the job had already gone out under whatever number somebody typed by hand.
There is no second number now, and no Job No. column.

The number is editable — sometimes it has to be made to match one already sent — and it is
unique across the register, on the screen and in the database.

### Dates and times

**Stored dates come in two kinds, and they are not interchangeable.**

- A **calendar date** — a due date, an award date — is stored `YYYY-MM-DD` and shown
  `MM-DD-YYYY`. The 22nd is the 22nd everywhere; it never goes through a timezone.
- A **moment** — when a bid was created, every history entry, a takeoff's last edit — is
  stored as a UTC timestamp and **always displayed in IST**, labelled, whatever the machine
  reading it is set to. The office is in India, and a timestamp in an audit log that quietly
  means something else on a laptop that has travelled is worse than no timestamp.

This was previously got wrong: every reader took the date off the front of the UTC string,
which is the **previous day** for anything between midnight and 05:30 IST. A bid entered at
02:00 showed as the day before, for five and a half hours out of every twenty-four.

`U.date` formats the first kind, `U.stamp` the second. Reach for the right one.

### The schedule — who is booked, and when

**Hours are booked against days.** Adding an engineer to a task on the **Team & Hours** card
gives a start date — the day the task was created — three working days to book against, and an
*Add day* button for longer tasks. The day boxes start empty: nobody has booked anything to
them yet, and a nought is not the same claim as a blank. Weekends are shown and shaded so the
strip reads as a real calendar; *Add day* steps over them, but hours can still be put on one.

A row that somehow arrives without a start date or any days — synced from a session running
older code, restored from a backup taken before this existed — is laid out with both when the
card draws it, rather than shown as a strip with nothing on it and no way in.

**Asgn Hrs is the sum of those days** and is no longer typed. Estm Hrs still is — it is the
estimate made up front, and the days are the booking made afterwards. Two different facts.
Moving the start date slides the whole booking, keeping the hours on the same working day of
the task: a job pushed back a week is the same plan, later.

**Active Bids has a third view, Employee**, beside Comfortable and Compact. Each bid is a row
with its engineers stacked, and a calendar to the right showing each person's hours per day.
Actions, Sr. No. and Project hold still while everything else scrolls.

**Engineer sits last, hard against the calendar** — after Status, immediately before the first
date. Reading a figure back to the name it belongs to is what you do all day on this view, so
the names are at the edge the dates start at rather than four columns away. It is placed there
for you: the column chooser reorders everything else as usual, and Engineer's position on
Comfortable and Compact is left exactly where you put it.

- **Day, Week or Month** is how much calendar is on screen: today, this week, or this whole
  month. The columns are always single days — a day is what hours are booked in, and the
  question the view gets opened for is which day somebody is on. Zooming out shows more days,
  not bigger buckets.
- **Arrows page back and forward** by one of whatever is on screen, and *Today* returns.
  The window is named above the calendar, year included, so a schedule you have paged three
  months forward cannot mislead you about when it is. Where you paged to is not saved — the
  zoom is a preference, but the view always opens on today.
- **Every active bid is listed**, booked or not — the same list as the other two views, with a
  calendar beside it. A bid nobody is on next week is exactly what you want to see when you are
  deciding who to put on it. The bar says how many of them have anybody booked in the window,
  and the footer how many hours that is.
- **Hours booked to a row with no engineer** on it get a line of their own, marked
  *unassigned*, so the figures in a cell always add up to the total underneath it.
- **Every column you have arranged is here**, the same as on Comfortable and Compact — turn
  them on and off in the column chooser as usual. Engineer is the exception, shown and placed
  whatever the chooser says, because every calendar cell is a line per engineer and that column
  is what says whose line is whose. The chooser marks it *(beside the calendar)* so it is clear
  it is being placed rather than ignored. The schedule never writes to your saved layout.
- **A heavy rule between projects, a hairline between people.** A row is several engineers
  tall, so the two boundaries are drawn differently — read down the calendar and the heavy
  rules are the projects.
- **Cells tint by load** — deepening past three-quarters of capacity, and red over it — so an
  overbooked day is visible without reading the figures. Capacity is eight hours per person
  per working day.
- **A totals row** carries the shop's booked hours per day. This is the row worth opening the
  view for: it is where next week being overcommitted is visible at a glance.
- **A rule down each Monday**, so a month of thirty-one columns still reads as weeks.
- **The deadline is marked on the calendar** — a chequered flag on the day the project is due,
  coloured for how close it is: overdue in red, within three days in amber, otherwise brand.
  It follows the revised due date where the client has moved it, since that is the date the
  project actually works to. The column heading counts how many projects are due that day, and
  a deadline that falls outside the window shows as a ‹ or › on the edge it lies past rather
  than not appearing at all.
- **Filter the Engineer column to one person** and you have every project they are on, with
  their hours across the calendar.

### What else a bid now records

- **When it arrived.** Every bid is stamped on entry with the date *and time*, in IST, and All
  Bids is read in that order — the Created column takes the slot the number used to have
  there, since nothing on that list has a number yet. Bids that predate the stamp show
  `~ 06-10-2026` with no time: the tilde means the date was inferred, and there is no hour to
  claim for a guess.
- **The newest bid is at the top.** All three tabs rest in arrival order, newest first, with
  the inferred backlog below the bids that were genuinely entered. Sorting by a column
  overrides it; the third click on a header comes back here rather than dropping into the
  order the records happen to be stored in.
- **A revised due date**, optional, beside the original. Once set it is the date the project
  works to *everywhere* — the grid, the sort, the month it is filed under, "due within 7 days"
  on the dashboard, the XLSX export and the flag on the Employee schedule. One function decides
  it, `Bids.effectiveDueDate`, so nothing can disagree about which date is in force.

  **Due within 7 days** lists every bid it counts — the panel scrolls rather than showing the
  first four under a count of eight — and it leaves out anything marked **Completed**. Completed
  sits in the open bucket, because the work is done but the bid has not been won or lost, which
  used to leave finished jobs reporting themselves overdue all week. *Submitted to review* still
  appears: it is out there, and its deadline is still real.

  **Both dates are shown, and neither is struck through.** The Due Date field shows the due
  date; the Revised Due field shows the revision, marked *in force*. They used to be merged —
  the Due Date box showed whichever was in force with the original crossed out beside it, which
  put a value in that field that was not `bid.dueDate` and said the original had been cancelled.
  It has not been: it is the date on the record, and the reason the revision is worth knowing
  about. In the bids table the date in force leads and the original sits under it, labelled
  `orig`.
- **Everything that happens to it.** The **History** card is a full audit trail. It **starts
  collapsed** — it is reference material, and open by default it was the tallest thing on the
  page, pushing the estimate and the proposal below the fold. Shut, it still says when the bid
  last moved and who moved it; click the header to open it.

  ```
  ▸  History  9              Last change 2h ago · ABH        [Back to All Bids]
  ```

  Opening it is a one-off for that bid: another project opens collapsed again. It stays open
  while you work on the one you opened it for, so editing an hours box does not snap it shut.

  What it records: the bid being
  created, every field that changes and what it changed from, every change to the team or the
  products, and every move between stages — each with who did it and when, in IST.

  Any stage move can be undone with a note — an award rescinded, a bid picked up by mistake —
  and the reversal is logged too. Reversing restores the status the bid actually had, because
  the log recorded it. **The project number never moves**, whatever the stage does: it is on
  paper already.

  Two edits to the same field by the same person within two minutes are merged into one entry,
  so correcting a price twice does not bury the change that mattered — and an edit undone
  inside that window leaves no entry at all, because nothing happened. Deleting an entry needs
  **bid.history.delete** and is itself recorded.

  **The takeoff and the proposal are in it too.** They are where the work is and where all of
  the money is, and until recently neither left a trace — a price that moved by forty thousand
  between Tuesday and Thursday was unattributable. What is recorded is a *digest*, not a diff
  of the document: a takeoff is thousands of cells, so the log keeps what somebody reading back
  actually asks — how many products, the base, the tax and misc rates, the freight, and the
  total. For a proposal, the number, the dates, the scope lines and what they come to. Sending
  one is recorded too: an export is what the client actually saw, even though nothing on the
  record moved.

  Filter chips on the card narrow it to **Bid**, **TakeOff** or **Proposal**, because on a
  worked job the document entries outnumber everything else.
- **Products with their materials.** A project is usually several products, each in its own
  material — handrail in one, bollards in another. They are rows on the **Products &
  Materials** card now, one product per row carrying its own materials, instead of a list of
  products beside a single material select that could not say which was which. Materials are
  a managed list under **Settings › Materials**.

Deleting a history entry needs the new **bid.history.delete** permission (Admin only by
default), and the deletion is itself recorded — the trail can be pruned, visibly, but not
quietly emptied.

#### How the log stays small enough to keep

`bid.history` lives inside the bid record, and that record has a ceiling that is not disk:
past **32KB** the server stops sending it in the change log and every open browser has to
re-fetch it instead. A takeoff under active editing writes constantly, so a naive log would
cross that line and quietly turn live sync into polling. (This has bitten the app once
already — a change log that reached 98MB of a 107MB database. See schema step 4.)

Four rules keep it inside a 16KB budget — half the ceiling, deliberately:

1. **Compact entries.** Field key, from, to. The label is looked up when it is drawn rather
   than stored on every entry.
2. **Values capped** at 80 characters. *Which* forty products is a question for the takeoff.
3. **A sitting is one entry.** Edits by the same person to the same document inside fifteen
   minutes merge, keeping the **earliest** from and the **latest** to — so an afternoon reads
   "the total moved from X to Y", which is the only thing anybody asks it afterwards. A figure
   typed and then put back leaves nothing at all.
4. **Yesterday is rolled up by day**, then the oldest fold into a running summary if the
   budget is still exceeded. Today keeps full detail: the log is most precise exactly when
   somebody is looking at it.

**Nothing is ever silently dropped.** The rollup changes the *resolution* of old entries, not
their existence, and a fold leaves a visible line saying what it stands for:

> **TakeOff** · 43 edits, 08-12-2026 – 09-30-2026, by AJP and SSJ
> Takeoff total *empty* → **$412,300** · Products **0** → **6**

Stage moves and bid edits are never folded — they are the record the office is answerable to;
only the document chatter is compressible. In practice 400 document entries compact to about
7KB, leaving the whole bid around 9KB.

For review outside the app, the XLSX export carries a **History** sheet: one row per change
per bid, with who, when, which document, and what moved from what to what — sortable and
pivotable across every bid at once, and written from whatever is on the record at export time.

### Editing

**Click any field on the project page** to change it where you are reading it — a single click,
or Enter from the keyboard; the pencil beside the label is always faintly there so you can see
which fields take an edit without having to try. Enter commits, Escape reverts, **Tab saves and
opens the next field**, and there are ✓ and ✕ buttons for the mouse. A date opens the calendar.

The same rules the full form applies apply here: a duplicate project number is refused, a date
that cannot exist is refused, and changing a due date re-files the bid under the right month.
**A refused value now keeps the editor open and says why**, rather than being dropped when the
field lost focus — which is what used to happen, silently, with the old value simply reappearing.

Fields the app works out for itself — the hours, the products, the linear feet from the
takeoff — are deliberately not editable, because the next recalculation would throw the edit
away.

### On the takeoff

**Add other charge** now takes a quantity, a unit and a unit price, so a line reads as
`2 Wks × $1,000` instead of a bare `2000` with the reasoning lost. A charge with just an
amount still works exactly as before. The **U/M** on the standard Cost & Labour rows is
editable too — supervision quoted by the week, a truck by the load — and only the exceptions
are stored, so a row left alone keeps its default.

### Looking at it

- **Light or dark.** The sun/moon button in the header cycles light → dark → match the
  system. It is your setting, stored with the rest of your layout, and it applies before the
  page paints so a dark app never flashes white on the way in. The printed proposal is
  deliberately exempt: it is paper, and it stays white under both themes and on the printer.
- **The project name stays put.** The first columns of the bids table are frozen, so
  scrolling right to reach Status no longer leaves you looking at a table of anonymous
  figures. Every row is the same height, whatever is in it.
- **One button per row, and it leads.** The Actions column is first now and frozen with the
  project name, so reaching it no longer means scrolling the name off the screen. Everything
  — the takeoff, the proposal, editing, awarding, moving a bid back, the portal link, delete
  — is behind the **⋮** menu, named in words rather than guessed from an icon.
- **Drag a column edge to resize it.** Double-click the grip to put one column back;
  **Reset widths** in the Columns panel puts them all back. Widths are yours alone, saved
  with your columns and filters.
- **Comfortable or compact**, bottom right of the table. Remembered per tab, alongside your
  columns and filters, and cleared by *Reset my table layout* like everything else.
- **The dashboard leads with what is urgent**: bids due within seven days, and submitted
  bids whose proposal was never generated. The twelve month cards became one strip of bars,
  which is still the month filter — click one to narrow All Bids.

## Everyday flow

1. **Active Bids** → click a row to open the project, then its **TakeOff** tab. (The
   calculator icon in the Actions column goes straight there.)
2. **Add Product Type** → the standard component groups come with it. The drawing grid starts
   empty: a column is created per thing you are actually measuring.
3. **Materials** → start typing in *Vendor Part No* or *Description*; pick a suggestion and the
   vendor, grade, U/M and unit cost fill themselves in. Every field stays editable.
4. **Cost & Labour** → set *Total linear feet*; engineering, fabrication, installation hours and
   the finish quantity fill from the formulas. Type over any of them and it turns amber and stops
   following the formula — the ↺ button puts it back.
5. **Drawing Takeoff** → name what you are measuring, pick the unit it is measured in, then
   enter quantities per drawing reference. Each column that ends up with a quantity becomes a
   material row under its own name.
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

Two, each doing one job.

### Sr. No. — where the row is

The second column, after the actions. It counts the rows on screen, 1, 2, 3, and is **not
stored on the bid**. That is deliberate: the ordinal it replaced was a saved value, so every
deletion left a hole in it (1, 3, 4, 5…). A counter cannot fall out of sequence — it *is* the
position, so it renumbers itself after a deletion and follows a re-sort. It is on all three
tabs.

Because it is positional it is not a name for anything. The number that identifies a project
is the Proposal No.

### Proposal No. — the project, for its whole life

`DIS-26-0001`. **Issued automatically the moment the bid is picked up**, All Bids → Active
Bids, and never changed again.

- `26` is the year, and the sequence restarts each January — the first project of 2027 is
  `DIS-27-0001`.
- Allocated as *highest existing for that year + 1*. Deleting a project does not free its
  number for reuse, because a number that has been on paper must never turn up on a second
  one. Numbers issued under the old job-number scheme are counted too, so one of those can
  never be handed out again either.
- **Permanent through every stage.** Awarding confirms it rather than replacing it. Moving a
  bid back to Active, or all the way back to All Bids, keeps it — it is on the proposal that
  was sent.

It is **unique across the whole register**: saving a bid whose Proposal No. is already on
another is refused, with a message naming the bid that holds it, both in the form and when
edited in place on the project page. The match ignores case and surrounding spaces, so
`dis-26-0001` and `DIS-26-0001 ` count as the same number rather than sneaking past as two.
The database enforces it as well as the form.

It follows the project outward — a takeoff started on the bid picks it up, the generated
proposal prints it, and changing it on the bid updates both rather than leaving a stale
number on a document that has already gone out. **One project, one number, everywhere it
appears.**

It is editable, because occasionally a number has to be made to match one already sent.

### There is no Job No.

There used to be a second number, `DIS-26-0001`, issued at award. It is gone. That numbering
*is* the Proposal No. now, issued earlier — at award the project simply keeps the number it
already has. A bid that carried an old job number had it moved across on upgrade, since that
is the number it was already known by.

| Tab | Numbers shown |
|---|---|
| **All Bids** | Sr. No., **Created** — nothing here has been picked up, so nothing has a number |
| **Active Bids** | Sr. No., Proposal No. |
| **Awarded Bids** | Sr. No., Proposal No. |

## Awarding, and losing

**Award ▾** on the project page (and the 🏆 button in the Actions column) offers the two ways
a bid stops being worked:

- **Award** — moves the bid to Awarded Bids, under the number it already has.
- **Mark Lost** — the project keeps its number too: it is on the proposal that lost.

Both ask first, and the award names the number the job is being won under.

Either can be undone. **Move back to Active Bids** appears in the row menu and on the
project page once a bid is decided; it asks for a note, restores the status the bid actually
had before the decision, and is recorded in the bid history along with everything else.

Awarded and Lost are **not** on the Add/Edit Bid form's status list. They are the outcome of
this decision, which is also what issues the number, so they are not values you type. A bid
that already holds one keeps it when you edit — opening an awarded job and pressing Save
never demotes it.

The statuses you *can* set are **Not Started**, **In Progress**, **Submitted to review**,
**Completed** and **No Scope**.

The Awarded tab is awarded jobs only, so a lost bid is never hidden there — it stays on
Active Bids. Adding a No Scope or Awarded bid back to Active Bids reopens it at Not Started;
adding a Lost one back leaves its status alone, because Lost is a state Active Bids can hold.

## Re-opening a job the client brings back

A job marked **Completed** or **No Scope** that comes back gets a **Re-open** button, on the
project page and in the row menu. It does *not* edit the finished bid — that record is what
was quoted the first time, and the question asked about every re-bid is "what did we quote
before, and what has changed".

So it opens **a second entry** beside it, dated today:

| | First entry | Re-opened |
|---|---|---|
| Number | `DIS-26-0042` | `DIS-26-0042-R01` |
| Revision | *(none — it was just the job)* | `Rev01` |
| Status | stays **Completed** | **ReOpen**, on Active Bids |
| Team & task types | | carried across |
| Task statuses, booked hours | | cleared |
| Price, takeoff, proposal | untouched | none — it is a re-bid |

Finish the `-R01` entry and re-open *it* and you get `-R02`, not `-R01-R01`: the suffix is
stripped before the next one is worked out. Revision numbers are scanned off the records
rather than counted from a stored sequence, so deleting an entry never frees a number up
again — the same rule the project number follows.

Both records link to each other at the top of the project page, because which one you are
looking at decides whether the price on screen is what was quoted or what is being worked
out now.

Two things it will not do. A job can only be re-opened **once** — twice would make two
parallel `Rev01`s with equal claim to the number. And a re-opened job can no longer be moved
back a stage, because its revision points at it and was numbered from it.

`ReOpen` is not on the status dropdown for the same reason Awarded and Lost are not: reaching
it does bookkeeping, so it is the outcome of an action rather than a word you type.

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

The XLSX export carries both stages, plus a **Team & Hours** sheet with one row per engineer
per task, and a **Bookings** sheet with one row per engineer per day — see
[Exporting the bid list](#exporting-the-bid-list).

### Who is free, and for how long

Each day box on the Team & Hours card says how much of that person's day is **left**:

```
        FRI
        25
      ┌──────┐
      │  9   │   hours booked on THIS bid
      └──────┘
       0 left    9 hr day, minus everything they have that day, everywhere
```

The figure counts **every bid in the database**, not the one on screen — the hours that fill
somebody's Friday are usually on a project you are not looking at, and a figure that counted
only this bid would be confidently wrong. Hover it for the arithmetic: *"AJP on 09-25-2026:
9 hr day, 9 booked across 2 projects, 0 left."* Past the end of the day it goes red and reads
`+2 over`.

A working day is **9 hours**, under **Settings → Engineers**. One person working something
else — a part-timer on 4.5 — gets their own figure in the same list; blank means "whatever the
shop is set to". Every capacity reading on the schedule uses these, so a shop of four on nine
hours and one on four and a half has a capacity of 40.5, not 45.

The Employee view carries the same idea across the bottom: **Booked** says how hard the shop
is working that day, **Free** says whether it can take any more.

### What each person is actually doing

The **Task** column sits beside Engineer on Active Bids and Awarded, and on the Employee view
it sits hard against the calendar so the row reads *who → what they're on → their hours*:

```
ENGINEER   TASK                     MON  TUE  WED
AJP        Drawing Take-off  Done    ·    ·    ·
AJP        Estimating   In progress  4.5  ·    ·
SSJ        Estimating   In progress  ·    4.5  ·
```

**A line is a task, not a person.** An engineer holding both the take-off and the estimating
appears twice, because their hours are booked per task — summing them into one line could say
neither which task the hours were against nor whether either was finished. Capacity still
counts people rather than lines, so a two-task engineer does not double the bid's apparent
room.

### Filtering to one person

Filtering the **Engineer** column narrows the *lines* as well as the list, so asking for one
person's work gives you their work rather than the projects it is somewhere inside:

```
[Engineer: SSJ ×]  [Clear all]
👤 Showing SSJ's rows only — the hours columns and the totals are still the whole bid's.

PROJECT                        ENGINEER  TASK                    ASGN   TUE  WED
Johnstown Elevator Addition    SSJ       Estimating In progress  10.5    4.5   ·
```

The **Task** filter does the same thing, and the two combine — *SSJ's open Estimating work*
is two filters, not a hunt.

**The hours do not narrow, and the note says so.** Estm/Asgn Hrs, the load shading and the
Booked/Free rows keep reporting the bid and the shop in full. A person's share is not the
bid's effort, and quietly reducing those figures would leave a row reading 4.5 against 18
hours actually booked to it.

A bid can match on one filter and have no single task matching *all* of them — it has an SSJ
row and an Estimating row, but they are different rows. That line reads `no matching task`
rather than going blank, which would collapse the row and pull the calendar beside it out of
alignment.

## Exporting the bid list

**XLSX** on the Bids toolbar exports **the tab you are on, as you are looking at it** — the
same columns, the same order, the same filters and the same sort. Narrow the table to one
engineer and the workbook holds their bids and says so on its first page.

Six sheets:

| Sheet | One row per | |
|---|---|---|
| **Summary** | — | Who exported it and when, which filters were on, and the headline counts: bids by status, total value, hours, due this week, overdue |
| **Bids** | bid | The register, mirroring the screen |
| **Team & Hours** | engineer × task | Pivot by person or by task type |
| **Bookings** | engineer × day | The workload pivot — hours by person by week |
| **Estimate Lines** | product × bid | The cost roll-up beside each bid |
| **History** | change | The full log, across every exported bid |

The Bids sheet freezes its header and the identity columns, carries an autofilter, and ends
in a totals row of **live `SUM` formulas** — so it still adds up after the recipient deletes
the rows they do not care about. Statuses are in the app's own colours and an overdue due
date is red.

**Cells are typed, not formatted text.** A price is a number and a due date is a real date,
so the recipient can sort, filter, subtract and chart them. A workbook full of `"$7,520"` and
`"09-16-2026"` looks the same and can do none of that.

> **If you have seen `Worksheet with name ... already exists!`** — that was this export
> naming a sheet after each project. Two projects whose names matched for 28 characters
> collided, which a re-opened job guarantees, since a revision keeps its original's name.
> No sheet is named after a project any more.

For the full estimate — every material line, the formulas, the lookup sheets and the shop's
own formatting — use **Export to Excel** on the takeoff itself, below.

## Exporting a takeoff to Excel

**Export to Excel** under the Project Cost Summary writes the estimate into **the shop's own
workbook** — its fonts, its colours, its borders and its column widths, not a bare grid of
numbers. The sheets are:

| | |
|---|---|
| **References** | the lookup lists, hidden as the template hides them |
| **Project Cost Summary** | the same rollup the rail shows, down to Total Bid Cost |
| one per product | materials, cost and labour lines, and the drawing grid the quantities came from |
| **Weight Calculator** | hidden; the pipe and bar weight sheet |
| **Factors** | the hours-per-LF and material-selection tables |

Each product's ⋮ menu exports that product on its own, and still brings the lookup sheets
and the summary with it — a sheet with nothing behind it can't be worked on.

**The figures are live formulas, not a snapshot.** Line totals are `=Qty*Unit Cost`, Material
Cost sums the column, the labour hours are the run length times the shop's factor, and the
Project Cost Summary points at each product sheet's own Total Cost. Change a unit cost three
sheets away and the bid total moves. The workbook is marked to recalculate when it opens, so
nothing depends on the cached numbers being trusted.

One exception, on purpose: a **material quantity** is a formula only where the estimator
wrote one. A quantity typed into the takeoff comes out as the number that was typed. Putting
a formula there would mean shipping a cell that silently disagrees with what somebody meant.

The materials table has no **Options** column. It held an abbreviated restatement of the
Description — `8" SCH 40` beside `Carbon Steel 8 SCH 40 PIPE A-500 GR B 8.625" OD .322 Thk.` —
which meant typing the specification twice and gave the proposal the shorter of the two to
print. The Description is what the client should read, so it is the one kept, and the
proposal's spec bullets now read **feature — description**. The exported sheets are the
template's columns with that one removed, so everything from Vendor rightwards sits one
column to the left of where the old workbook had it.

### Changing how the export looks

Nothing about the formatting lives in the code. `js/estimate.template.js` is generated from
the shop's workbook and carries its `styles.xml` verbatim, plus a map of which style belongs
on which kind of row. To restyle the export, restyle the workbook and rebuild:

```
npm run build:xlsx-template          # reads Estimation_....xlsx, rewrites js/estimate.template.js
npm run test:xlsx                    # unzips a fresh export and checks every formula
```

The test also rebuilds the generated file in memory and compares, so one that has fallen
behind its source fails rather than quietly shipping last month's formatting.

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

**What the logo sits on is a choice of three** — none, white, or black — in the proposal
generator's **Company** tab. It depends on how the logo file itself was drawn and not on
taste: a logo with a white background needs the white card on a dark style, or it prints as a
white rectangle in the corner; one drawn in white on transparent needs the black card on a
light style, or it vanishes. The choice is kept with the company details, so it is the default
for the next proposal as well. Documents saved before this carried a `frameLogo` boolean and
still open framed in white, and templates written here still carry it — so a file moved to or
from the v3 app behaves the same as it always did.

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
cannot override it. Type `09152026` and the dashes appear as you go. A date that does not exist
(`02-30-2026`) turns the field red and blocks the save rather than being silently discarded.

**The calendar behind the icon is the app's own** ([js/datepicker.js](js/datepicker.js)) and
reads the same way round as the field it fills in. It used to be a hidden native date input,
opened purely to borrow the browser's popup — so the field said MM-DD-YYYY and the calendar it
opened said dd-mm-yyyy, on the same screen, for the same date. There is now no
`input[type=date]` left anywhere in the app.

- Arrows move a day, PageUp/PageDown a month, Enter picks, Escape closes.
- **Today** and **Clear** are on the bottom row; today is ringed and the chosen day filled.
- Weeks start **Sunday** — this is a wall calendar. The Employee schedule starts Monday because
  that is a working week, which is a different question.
- Opening the **Revised Due** calendar flags the original due date on the grid and starts on
  that month, since the new date is chosen by moving the old one.

Stored values stay ISO `YYYY-MM-DD`, so sorting and existing `.json` backups are unaffected.

## Your data

Written to the shared `diverse.db` as you type, and on every other open browser a moment
later. Nothing is saved by hand — the footer says when it last went out, and Ctrl+S flushes
anything still queued rather than opening the browser's own Save-page dialog.

Backing the office up is copying `diverse.db`; restoring one is putting that file back.
Without a server the app falls back to that one browser's storage, and clearing it loses
the lot.

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
| `js/store.js` | state, the server/IndexedDB backends, schema migrations |
| `js/ratespanel.js` | the Labour/Equipment/Markup grid, shared by Rate Library and each project |
| `js/rates.js` | rate defaults, hour formulas, product templates |
| `js/catalog.js` | rate library: fuzzy suggest, auto-learning, price history |
| `js/catalog.seed.js` | 60 parts extracted from the workbook |
| `js/takeoff.model.js` | cost maths and the `fx` quantity evaluator (no `eval`) |
| `js/takeoff.js` | Takeoff tab UI |
| `js/xlsx.zip.js` | writes a zip container, and the XML primitives both workbook writers share |
| `js/report.xlsx.js` | the bid report's writer: its own stylesheet, sheet builder and container |
| `js/bids.report.js` | what goes in those sheets — the six sheets of the bid export |
| `js/history.js` | the audit trail: bid fields, takeoff and proposal digests, and the compaction that keeps them inside the record's size budget |
| `js/schedule.js` | the calendar behind the Employee view; working-day lengths and the cross-bid "hours left" index |
| `js/proposal.js` | proposal document, editor, print |
| `js/proposal.paginate.js` | measures the document and deals it into numbered pages |
| `js/proposal.styles.js` | the 9 styles, lifted verbatim from v3 |
| `js/proposal.defaults.js` | terms / payment / inclusions boilerplate from v3 |
| `js/bids.js` | the bid tracker: statuses, the three stages, promotion and the award/lost decision |
| `js/assignments.js` | the Team & Hours rows and their totals |
| `js/sparks.js` | the banner's welding sparks, on hover |
| `js/guide.js` | the user guide, in one place — the sign-in page shows its headline half |
| `js/intro.js` | the sign-in page's welded logo, on the spark engine below |
| `js/datepicker.js` | the calendar behind every date field |
| `js/presence.js` | who else has a project open, from the live stream |
| `js/project.js` | the full-screen project page and its three stages |
| `js/settings.js` | the Settings page: rail, Regions, Engineers, Company, People, Roles |
| `js/ratelib.js` | Rate Library page |
| `js/seed.js` | first-run bid and region data |
