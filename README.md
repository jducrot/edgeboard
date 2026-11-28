# EdgeBoard

A personal NBA decision tool. It puts the stats, betting lines, injury news,
and lineup data for each game on one screen and lets you log a prediction
with your reasoning. It freezes a snapshot of everything you knew at that
moment, then grades the prediction after the game and writes a
retrospective, so you can see which reads work and refine your approach.

EdgeBoard does not pretend to beat the closing line. It helps you take in
public information faster, and it keeps you honest about whether your reads
are working.

## Stack

- [Eleventy](https://www.11ty.dev/) 3.x renders every page as static HTML
  with Nunjucks templates. The pages run no JavaScript at all.
- A small Node server (`server.mjs`) serves the built pages, handles the
  forms (`/predict`, `/predict/update`, `/retro`, `/refresh`) and the
  `/export.csv` download, writes to SQLite, and rebuilds the pages when
  data changes. Pages also rebuild on visit once the last build is more
  than 5 minutes old, so an idle server makes no requests at all.
- SQLite (better-sqlite3) stores your picks in `data/edgeboard.db` and
  lineup history in `data/history.db`. Both are created on first use and
  never committed. Your picks stay on your computer unless you turn on
  syncing (see "Using EdgeBoard on two computers"), which copies them to a
  private GitHub repository of your own.

## Pages

**Slate** (`/` opens today's): game cards for yesterday, today, and
tomorrow.

Every game that has not started shows:

- **The market**, in plain terms: the expected margin (the spread) and win
  probabilities with the bookmaker's cut removed. No total: it says
  nothing about who wins.
- **Upset Potential**: the underdog's chance to win, as a number and a
  word, such as "CHA 40%, High", next to the market's own estimate from
  the moneylines. High is 40% or more, Moderate 25% to 40%, Low under 25%.
  It is fitted to past games: mostly the spread (three in four upsets come
  at spreads under 7 points), nudged by whether the Line check's stats
  pick the underdog and how many of the 13 stats favor it. "Why this
  number" lists each piece and says plainly that most upsets are decided
  by a shooting night no stat can see coming, so even High means the
  favorite usually wins.
- **Line check**, laid out for scanning:
  - An **Upset Alert** at the top when the stats pick the market's
    underdog to win, or when at least 7 of the card's 13 counted stats
    favor the underdog. Opening it gives each reason and how underdogs
    did in past games like it (from the Insights research), worded as
    "more than usual, but could be chance" where that is the honest read.
  - The market's margin and the stats margin side by side, then a
    one-line verdict.
  - Two columns, "Favors DAL" and "Favors CLE", each with a count out of
    the 13 stats and one- or two-word flags, strongest first by how well
    each picked winners in the research. Flags that picked winners less
    than 58% of the time with no lean toward upsets (today 3-point %,
    Rested, Turnovers, and Home court) are grouped after a "Weak:"
    label; the grouping follows the data as it grows. Each flag opens to
    show the numbers behind it, including league ranks and the cohesion
    gap where they apply, and a flag that backs the underdog also shows
    how that stat did at spotting upsets. Home court is shown but not
    counted.
  - "How the stats number is built" and any uncertain players, folded
    away until opened. The stats number uses last-10 net ratings scaled
    for pace (or season scoring margins early on), +2.5 for home court,
    -2 for a back-to-back, and points off for each team's minutes
    missing: the minutes a game that players listed Out tonight played
    over the last 10 games. A player out for a month costs nothing,
    because his minutes already left the last 10. A starter hurt in the
    last game costs his full share. The points per minute are learned
    from past games (about 0.5 points per 10 minutes so far).
    Questionable and doubtful players are not counted and are listed as
    uncertain instead. Before lineup history has downloaded, it falls
    back to -3 for each newly-out key player, capped at -6.
- **Full stats**, folded away until opened: the matchup table (records,
  each offense against the other team's defense, last 10 and streak,
  rest), league ranks over the last 10 games, the cohesion table, and the
  last-10 analytics (pace, ratings, shooting, turnovers, rebounding, free
  throw rate, and the 3-point profile). The Line check flags already carry
  the numbers that matter, so these are reference. Finished games keep
  their tables open.
- **Starters**, always shown: a projected five, ranked from the last five
  games with recent starts weighted most. Starters listed Out are replaced
  by the next healthy players, marked as projected, so every team shows
  five. Each starter has a scoring trend (hot, cold, or steady over the
  last five games) and two ratings where 100 is league average: O
  (offense) and DA (defensive activity, from steals, blocks, and rebounds,
  because box scores cannot see positioning). A starter who missed recent
  games with no injury listed is flagged in bold.
- **Injuries**, in a disclosure labelled like "4 Pacers injuries". Above
  it, one line says how many minutes a game from the last 10 games are
  out tonight, and how many of them are new since the last game. Each
  player shows their recent production and whether the absence is new or
  already reflected in the team's record.
- **A prediction form**: who wins, your confidence from 1 to 5, and your
  reasoning. Confidence has no default, so every pick records a deliberate
  choice (22 of the first 37 picks kept the old default of 3, which made
  confidence impossible to judge). There is no margin field. Saving keeps
  you on the slate and returns you to the game's card, which then shows
  "Your pick: [team] because [reasoning]" and folds the rest of the card behind a "View game details"
  button. Until tip-off you can update the pick there, and a "Changed since
  your pick" list shows what moved: the line, win probability, injuries,
  the projected lineup, and games played in between. Changed items are
  also marked in place, in words. Picks close at the game's scheduled
  start time, and a double-click saves only one pick.

Every finished game shows the final score in its heading, for example
"Dallas Mavericks 117 at Cleveland Cavaliers 127", with the winner in bold
orange and named as the winner for screen readers. If you
picked the game, a check mark or an X next to "Your pick" shows whether
your team won. Overtime games add a
"Final/OT" line. Each finished game also shows **How it happened** (the
turning point, the box-score factors that decided it, and key
performances) and **Was it predictable?**, which lists the signals that
pointed each way before the game. This text is computed from the box score
and the pregame line, and says so. When the underdog won, an "An upset"
line compares both teams' 3-point shooting with their own season averages
and says whether a shooting night decided it. A postponed or canceled game shows
ESPN's status (for example "Postponed") and is never treated as played.

**Review** (`/review/`): first, **Your track record**: how often you were
right compared with the market's favorite and the Line check's stats on
the same games, then by confidence level, favorite or underdog (with the
usual underdog rate at those spreads), home or road, and against the
spread. A **confidence chart** shows, for each confidence level, how often
you were right (bars, with the percentage and pick count under each) next
to what the level promises (a dashed line from a coin flip at 1 to a lock
at 5). A visible one-sentence summary names the chart for screen readers,
and the numbers are in a table under "Show the numbers". Levels with fewer
than 3 picks are listed but do not decide whether your record climbs with
your confidence. Below it, every prediction with its result. Finished games
are graded automatically, with the same check mark or X next to each
pick (a pick on a postponed game says "Not graded" instead), and each
graded pick gets a computed
retrospective as a bulleted list, plus a box for your own notes. Each pick
keeps its frozen snapshot, viewable inline. A link downloads every pick as
a spreadsheet.

**Insights** (`/insights/`): research on every game in lineup history,
each scored only from what its card would have shown before tip-off.

- **What flags an upset?** For each signal on the card (record, net
  rating, defense, rebounding, cohesion, rest, missing starters, the Line
  check, and more), how often the underdog won when that signal backed it.
  Each result is compared with how often underdogs usually win at the
  same spreads, fitted to the same games, because small spreads produce
  far more upsets and would otherwise flatter any signal that backs
  close-game underdogs. Results are labelled in words ("Clearly more than
  usual", "More than usual, but could be chance", "About the usual rate"),
  with tables for how many of the card's 13 stats backed the underdog and
  for upsets by spread size.
- **Anatomy of an upset.** What underdogs actually did in the games they
  won: how often they out-shot the favorite, rebounded and protected the
  ball better, how far their 3-point shooting ran above their own average
  (and the favorite's below), how close upsets were, and how many came at
  small spreads.
- **Watch list: ideas still being tested.** Popular betting ideas
  (fatigue from 3 games in 4 nights or 4 in 6, bouncing back from a
  15-point loss, rolling after a 15-point win, winning and losing streaks,
  recent record against the spread, home or road record, earlier meetings,
  playing above season level, home underdogs), each measured separately in
  the last two seasons. One earns a flag in the Line check only by beating
  the market in both seasons on its own: its cover rate's whole likely
  range above 50%, or its underdogs winning clearly more often than usual.
  Until then it is listed with plain words about where it stands.
- **Does the Line check's verdict beat the spread?** The side the stats
  leaned toward, against the spread, for each of the card's three
  verdicts.
- **How much do injuries cost?** Points per 10 minutes missing beyond
  what the last-10 stats show, how much of that the spread already moves,
  and a before-and-after table: the Line check with no injury
  adjustment, with the old 3-point rule, and with minutes missing, graded
  on the same games.
- **Does cohesion help?** What "average pair" and the cohesion gap mean,
  the cutoffs behind "large gap (top third)", a worked example, and the
  results by slice.
- **How often each signal picked the winner,** in a disclosure, with no
  conclusions drawn.

The findings are worded from the data at build time, so the text never
goes stale. Pregame cards use this research in three places: the Upset
Alert and its reasons, each Line check flag that backs the underdog, and
a line under the Cohesion table giving the gap's size and how the more
cohesive team did in past games with a gap that size. A Line check with no
alert ends with how underdogs did in past games where the stats backed the
favorite. On a phone, the research tables scroll sideways inside a named,
focusable box instead of breaking words.

## Data sources

All free, with no API keys:

- `site.api.espn.com`: scoreboards, game summaries (box scores and win
  probability), standings, injuries, team schedules and rosters, and
  player game logs
- `sports.core.api.espn.com`: betting odds

Lineup history lives in `data/history.db`, separate from your picks so it
can be deleted and rebuilt at any time. The server fills it in the
background on first start (about 1,500 games in under a minute, and pages
work meanwhile), then fetches only newly finished games, at most hourly. A
game ESPN has no box score for is skipped instead of retried forever. Each
game stores the starters, minutes, pregame spread, and both teams' box-score
totals (shots, 3-pointers, free throws, rebounds, turnovers), which the
Insights research uses. History saved before the totals were kept fills
them in once, in the background (about 1,500 games in under a minute). A
spread already saved is never downloaded again or erased.

Caching, fastest layer first:

1. A 60-second memory cache merges identical requests, so one build reads
   each response once even with every game building at the same time.
2. `@11ty/eleventy-fetch` caches responses on disk in `.cache/`: odds and
   scoreboards for 2 minutes, injuries for 10, standings for 30, team
   schedules for 1 hour, and player game logs for 3 hours. Schedules and
   game logs are stored with only the fields EdgeBoard reads, which keeps
   the whole cache near 17 MB instead of about 104 MB.
3. Finished-game summaries are stored permanently in `.cache/summaries/`,
   stripped to the fields EdgeBoard reads (about 42 KB each instead of
   475 KB).

The server cleans `.cache/` at most once a day, and only after a
successful download: responses unused for 2 days and summaries older than
45 days. Slate pages for dates that have left the three-day window are
deleted after each build, so an old date never shows stale data.

`stats.nba.com` (true net rating, pace) blocks cloud servers, so it is not
used.

## Running it

EdgeBoard needs Node 22 or newer. Any current release from
[nodejs.org](https://nodejs.org/) works. The database driver includes
ready-made builds for Mac (Apple silicon and Intel) and Windows (x64 and
Arm), so no compiler is needed. The project's `.npmrc` turns off
dependency install scripts (`ignore-scripts=true`): without that, npm tries
to compile the driver from source on a fresh install, which fails on
Windows unless Visual Studio is installed. Because that setting also skips
npm's "pre" scripts, the Node version check lives in the server itself and
in the `npm test` command.

### Where to put it

Keep the project in a plain folder in your home folder, such as
`~/Developer/edgeboard` on a Mac or `C:\Users\<you>\Developer\edgeboard` on
Windows. Avoid Documents and Desktop, which iCloud or OneDrive often sync:
syncing the live picks database while EdgeBoard has it open can corrupt
it. On Windows, also avoid `C:\Program Files`, where only administrators can
write.

### Mac

With [Homebrew](https://brew.sh/) (or use the nodejs.org installer):

```bash
brew install node git
```

Get the code:

```bash
mkdir -p ~/Developer && cd ~/Developer
```

```bash
git clone https://github.com/jducrot/edgeboard.git
```

Then, in the `edgeboard` folder:

```bash
npm install
```

```bash
npm run dev
```

### Windows

Install Node and Git with their installers from nodejs.org and
git-scm.com, or in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

```powershell
winget install Git.Git
```

Close and reopen PowerShell, then get the code:

```powershell
mkdir $HOME\Developer; cd $HOME\Developer
```

```powershell
git clone https://github.com/jducrot/edgeboard.git
```

Then, in the `edgeboard` folder:

```powershell
npm install
```

```powershell
npm run dev
```

Settings are written differently in PowerShell. Where this README shows
`NAME=value npm run dev`, PowerShell uses:

```powershell
$env:NAME="value"; npm run dev
```

A setting made that way lasts until you close the window. To clear it
sooner, run `Remove-Item Env:NAME`.

### Once it is running

`npm run dev` opens http://localhost:3000 in your default browser once the
server is ready (`npm start` does not). To turn that off, set
`EDGEBOARD_NO_OPEN=1`. The pages build on first start (about 10
seconds with an empty cache, about 1 second after that). Then they rebuild
when you load a page more than 5 minutes after the last build, after every
saved pick or note, and when you press "Refresh data now" in the footer.
EdgeBoard works the same from any folder you start it in.

To update: stop the server with Ctrl+C, run `git pull` and then
`npm install`, and start it again with `npm run dev`. A running server
keeps the old code in memory, so a restart is always needed.

### When something goes wrong

Startup problems end in a plain explanation and the fix, never a wall of
red error text:

- **Node is too old.** EdgeBoard stops before loading anything and says
  which version to install. Older versions can crash with "segmentation
  fault" because the database driver does not support them, and
  `npm install` refuses to run on them (`.npmrc` sets `engine-strict`).
  After changing Node versions, reinstall the packages:
  - Mac: `rm -rf node_modules`, then `npm install`
  - Windows (PowerShell): `Remove-Item -Recurse -Force node_modules`, then
    `npm install`
- **EdgeBoard is already running.** A second copy stops at once and says
  how to use another port, instead of building over the first copy's
  pages.
- **`PORT` is mistyped.** EdgeBoard stops and shows the value it got.
- **`npm install` fails with "node-gyp" or "Visual Studio" errors.** Your
  copy predates the `.npmrc` fix. Pull the latest code, delete
  `node_modules` (on Windows: `Remove-Item -Recurse -Force node_modules`),
  and run `npm install` again. If Windows says a file in `node_modules`
  cannot be removed, close any editor that has the folder open and try
  again.
- **`git pull` says "You have unstaged changes" in `package-lock.json`.**
  `npm install` rewrote that file slightly. Run `git status --short`: if
  `package-lock.json` is the only file listed, discard the change with
  `git checkout -- package-lock.json`, then pull and run `npm install`
  again. If any other file is listed, look at it before discarding
  anything.
- **No internet on a brand-new copy.** EdgeBoard keeps running, shows a
  "No data yet" page, and tries again when you load a page.
- **A refresh fails.** One line explains why, and the last pages built
  stay up.

Set `EDGEBOARD_DEBUG=1` to also print full technical details.

### Settings

All optional.

| Setting | What it does | Default |
| --- | --- | --- |
| `PORT` | The port to serve on | `3000` |
| `EDGEBOARD_STALE_MS` | How old pages can get before a visit rebuilds them, in milliseconds | `300000` (5 minutes) |
| `EDGEBOARD_BACKUP_DIR` | Where daily backups go | `data/backups` |
| `EDGEBOARD_DEBUG` | Set to `1` to print full error details | off |
| `EDGEBOARD_NO_OPEN` | Set to `1` so `npm run dev` does not open a browser tab | off |
| `HOST` and `EDGEBOARD_ALLOWED_HOSTS` | Open EdgeBoard to your network (see Security) | this computer only |
| `EDGEBOARD_DATA_DIR`, `EDGEBOARD_OUT_DIR`, `EDGEBOARD_CACHE_DIR` | Move the data, built pages, and download cache | `data`, `_site`, `.cache` |
| `EDGEBOARD_NO_HISTORY_SYNC` | Set to `1` to skip the lineup history download | off |

In a proxied environment such as a Claude Code cloud container, Node must
be told to use the proxy:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run dev
```

## Using EdgeBoard on two computers

Your picks can follow you between computers through a private GitHub
repository of your own (for example `edgeboard-picks`). The live database
is never shared. Each pick is also kept as one small file in a copy of that
repository at `data/sync`. Every time EdgeBoard refreshes, it pulls picks
from your other computer, adds them, writes out any picks saved or changed
here, and pushes them. Results are not synced: each computer grades picks
from ESPN by itself, so a pick made on the Mac shows up graded on the PC.

**Set up each computer once,** starting with the one that already has your
picks. In the `edgeboard` folder:

```bash
git clone https://github.com/jducrot/edgeboard-picks.git data/sync
```

Then restart EdgeBoard. On the first refresh it gives every existing pick
a permanent id and pushes them all.

The clone asks you to sign in to GitHub the first time. On Windows, Git for
Windows opens a browser sign-in. On a Mac, install Git Credential Manager
first so it can do the same:

```bash
brew install --cask git-credential-manager
```

How it behaves:

- **Each pick is its own file,** named by its id, so the two computers
  almost never edit the same file.
- **The newest version of a pick wins,** whether the change was an update
  or added notes.
- **If both computers picked the same game before syncing,** the pick
  saved first is kept on both, and the Review page shows a "Sync note"
  describing the other one. Nothing disappears silently: the other pick's
  file stays in the repository's history.
- **Offline is fine.** Picks save locally and go out on the next refresh
  with internet. If GitHub cannot be reached or needs you to sign in
  again, the terminal says so once, in plain words.
- **Without `data/sync`, nothing changes.** Sync is off until you clone.
- Commits are made as "EdgeBoard", so your email never lands in the
  history.

## Backups and export

- **Daily backups.** Each day EdgeBoard first runs, it copies your picks to
  `data/backups/edgeboard-picks-YYYY-MM-DD.db` and keeps the newest 14.
  The copy uses SQLite's online backup, so it is complete even while the
  app is writing. To keep backups somewhere safer, set
  `EDGEBOARD_BACKUP_DIR` to a synced folder such as iCloud Drive or
  OneDrive. That is safe for these finished copies, but never point the
  live `data/` folder at a synced folder, because syncing a database while
  it is open can corrupt it. Lineup history is not backed up because it
  can always be downloaded again.
- **To restore a backup:** stop EdgeBoard, delete `data/edgeboard.db` and
  its `-wal` and `-shm` files, copy the backup to `data/edgeboard.db`, and
  start EdgeBoard.
- **Spreadsheet export.** The Review page links to `/export.csv`, which
  has every pick. Text that a spreadsheet would run as a formula is
  neutralized.

## Testing

Install the test browser (about 150 MB) once on a new computer, and again
after each Playwright update, because each version needs its own browser
build. If it is missing, the browser tests fail with this same command in
the message.

```bash
npx playwright install chromium
```

To use a browser that is already installed instead, set
`EDGEBOARD_CHROMIUM_PATH` to its path (a Claude Code cloud container
uses `/opt/pw-browsers/chromium`).

Then:

```bash
npm test
```

The tests take about a minute and run against throwaway copies of the
data, so your real picks are never touched. They cover:

- Security: only this computer can connect, forged forms and foreign
  addresses are refused, safety headers are sent, and typed text is never
  run as code.
- The pick flow in a real browser: save in place, update, and changes
  since your pick.
- WCAG 2.2 A and AA with axe in light and dark schemes, and reflow at
  320px.
- Upset Potential: the fitted model recovers a known rule, the word
  matches the number shown, and every pregame card with a spread shows it
  with its reasons. The anatomy counts battles and judges shooting nights
  against each team's own average.
- The pick form: no confidence is chosen for you, the browser and the
  server both refuse a pick without one, and there is no margin field.
- Your track record: you against the market and the stats on the same
  games, by confidence, side, and spread.
- The confidence chart: bars and the promise line match the record, labels
  never sit where marks can cross them, the visible summary names the
  chart, the numbers are in a table, the marks measure 3:1 or better in
  light and dark, and they stay visible in Windows High Contrast mode.
- Streamlined cards: pregame stat tables sit inside "Full stats", no
  total is shown, flags run strongest first, and weak flags follow a
  "Weak:" label, with the grouping taken from the research.
- The Line check: flags land on the side they favor (lower is better for
  defense and starters missing), home court is not counted, the Upset
  Alert fires on either rule and not otherwise, flags open from the
  keyboard, and research history is added only to flags backing the
  underdog.
- Finished games: both scores in the heading, the winner in bold orange
  large enough to pass contrast, named in words, and a check or an X beside your picks on the cards
  and the Review page.
- Saving picks: a double-click saves one pick, a pick still saves when
  part of ESPN is down, and picks close at the scheduled start.
- Offline behavior, for a brand-new copy and for a restart.
- Startup problems: old Node, a second copy, and a mistyped port.
- ESPN data: postponed games are never treated as played, one odd entry
  cannot break a day, and slate dates survive daylight-saving changes.
- Lineups: a box score that failed to load is not counted as a missed
  game, and a lineup built from failed downloads is not reused.
- Injuries by minutes: a player out for weeks costs nothing, a player
  hurt in the last game costs his full share, only players listed Out
  count, the injury rate is learned only from earlier games, and the
  Line check takes the points off and says so.
- The Insights research: every game is scored only from earlier games,
  back-to-backs are judged on Eastern dates, the Line check replay follows
  the card's rules, upsets are compared with the usual rate at the same
  spread (a signal that only backs close-game underdogs gets no credit),
  findings name an edge only past the chance bar, box-score totals are
  stored without losing a saved spread, and the page's tables are labelled
  and scroll in a keyboard-reachable box on a phone.
- The watch list: its measures use earlier games only, fatigue is judged
  on Eastern dates, an idea reaches the cards only after beating the market
  in both seasons, and only earned ideas show as card flags.
- Syncing picks: two copies of EdgeBoard share a stand-in repository, a
  pick saved on one appears on the other, an update flows back, newer
  edits win, and a game picked on both keeps the earlier pick with a note.
- Backups, the spreadsheet export, old slate pages being removed, saves
  made during a refresh, the wordmark, installs that need no compiler,
  and `npm run dev` opening the browser on each kind of computer.

The tests need internet for live ESPN data. The offline tests simulate
having none.

## Security and offline behavior

EdgeBoard is built for one person on one computer, and defends that:

- **Only this computer can reach it.** The server listens on 127.0.0.1
  (and ::1 where IPv6 exists), not on your network. Devices on the same
  Wi-Fi cannot see or change your picks, and Mac and Windows do not ask to
  allow incoming connections. To deliberately open it to your network,
  set `HOST=0.0.0.0` and list the addresses you will use in
  `EDGEBOARD_ALLOWED_HOSTS` (for example `192.168.1.20:3000`). There is
  no password, so anyone on your network could then read and change your
  picks. Only do this on a network you trust.
- **Only its own pages can change data.** Form submissions are accepted
  only when the browser marks them as coming from EdgeBoard itself
  (`Sec-Fetch-Site`, or a matching `Origin` or `Referer`), so another
  website cannot submit hidden forms to it.
- **Only requests addressed to it are answered.** Any other `Host` is
  refused, which stops websites from reading it through a hostname trick
  (DNS rebinding).
- **Dependencies cannot run code while installing.** `.npmrc` sets
  `ignore-scripts=true`, so a compromised package update cannot run
  anything on your computer during `npm install`.
- **Only page and style files are served**, and Windows device names
  such as `CON` or `NUL.html` are refused, because opening one can hang
  a Windows computer.
- **Browsers are told to run no scripts at all**, never to show it inside
  another site's frame, and not to guess file types. EdgeBoard uses no
  JavaScript in its pages, so this costs nothing and turns any future
  escaping mistake into a non-event.

**Offline:** if pages from an earlier run exist, EdgeBoard serves them
immediately and refreshes in the background. When ESPN cannot be reached,
pages are rebuilt from data saved on this computer, and every page says
when data was last really downloaded. It retries at most once a minute.
The cache is cleaned only after a successful download, so time offline
never deletes the data that keeps the app working. Every network request
has a deadline, so a hanging connection cannot stall the app.

## Accessibility

WCAG 2.2 A and AA are the baseline for every change. Every page passes
axe-core (WCAG 2.0, 2.1, and 2.2 A and AA rules) with zero violations in
light and dark schemes, and reflows without sideways scrolling at 320px
(Success Criterion 1.4.10). The layout uses the full window: game cards
fill as many columns as fit (at least 32rem each), and the columns inside
a card respond to the card's width, not the window's. With no JavaScript,
every interaction is a normal form submission that loads a new page, so
there is no hidden state for assistive technology to miss.

Things to preserve when editing:

- One `h1` per page. Game cards are `article` elements labelled by their
  heading.
- Stat comparisons are real tables with row and column headers.
- Every signal is conveyed in words, never by color or weight alone. The
  winner of a finished game is bold orange text and also named as the
  winner in text. The heading is 20px, so the bold winner counts as large
  text and needs 3:1: #ea580c is 3.56:1 on the light card and #f97316 is
  6.32:1 on the dark one. Do not shrink that heading below 18.66px without
  darkening the orange. In Windows High Contrast mode the winner gets an
  outline.
- Charts are plain SVG drawn at build time (no JavaScript), named by a
  visible summary through `aria-labelledby`, with their marks hidden from
  assistive technology and the same numbers in a table. Meaning never
  rests on color: bars and a dashed line differ in shape, and every value
  is printed.
- A check or an X beside a graded pick is a shape, not a color, and
  screen readers hear "Correct" or "Incorrect".
- The Upset Alert is words plus a warning shape, not color alone, and its
  red is 6.5:1 or better in both schemes. Line check flags and the alert
  are native disclosures (`details` and `summary`), so they open from the
  keyboard and announce their state with no JavaScript.
- After saving a pick, the page returns to the pick summary on the same
  card. Invalid input gets a page that explains the problem and links
  back.
- Every target meets WCAG 2.5.8 Target Size (Minimum). Buttons, date
  links, and navigation links are 44px tall, and each radio button sits
  in a 44px-tall label that can be clicked anywhere.
