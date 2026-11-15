# EdgeBoard

A personal NBA decision tool. It puts the stats, betting lines, line movement,
and injury news for each game on one screen, lets you log a prediction with
your reasoning, freezes a snapshot of everything you knew at that moment, then
grades the prediction after the game and prompts a retrospective so your
process improves over time.

EdgeBoard does not pretend to beat the closing line. It helps you synthesize
public information faster, and it keeps you honest about whether your reads
are working.

## Stack

- [Eleventy](https://www.11ty.dev/) 3.x renders every page as static HTML
  with Nunjucks templates. No client-side JavaScript at all.
- A small dependency-free Node server (`server.mjs`) serves the built site,
  handles the three form endpoints (`/predict`, `/retro`, `/refresh`),
  writes to SQLite, and rebuilds the site when data changes. Pages also
  rebuild on visit once the last build is more than 5 minutes old, so an
  idle server makes no requests at all.
- SQLite (better-sqlite3) stores predictions at `data/edgeboard.db`,
  created on first use and gitignored. Your picks never leave your machine.

## Pages

- **Slate** (`/`, redirects to `/slate/YYYYMMDD/`): game cards for
  yesterday, today, and tomorrow. Each pregame card opens with a **Line
  check**: a transparent stats-only margin estimate (pace-scaled last-10
  net ratings when available, else season scoring margins; home court at
  +2.5; back-to-backs at -2; fresh key absences at -3 each capped at -6)
  compared against the spread, with every component named, a verdict
  (aligned, mild or strong disagreement), and a list of
  game-time-decision key players as unpriced uncertainty. Each card also
  shows the market's expected margin (the spread, phrased plainly), the
  total shown only with our own pace-and-efficiency projection beside it
  (over/under lean), and devigged win probabilities, as a bulleted list; records, a per-team matchup projection (opponent
  defense vs league average), last-10 form and streaks; rest days and
  back-to-backs; a **Last 10 analytics** table aggregated from each
  team's last ten box scores, opened by a **League rank** table placing
  each team 1st to 30th over its last 10 games in offense (points per 100),
  defense (points allowed per 100), rebounding (share of all boards), and
  3-point percentage, across every team in the league (possession-adjusted net/offensive/defensive
  ratings, pace, eFG% for and against, turnover battle, offensive
  rebound %, FT rate, and the three-point profile with opponent 3P% as a
  regression flag); and per-team disclosure widgets for the starting
  five and the injury list (labelled like "4 Pacers injuries"), collapsed
  by default. Each listed player gets
  an impact line (their recent production when playing) and an absence
  context line: a fresh absence whose production goes missing tonight, or
  one already reflected in the team's recent record, with the team's W-L
  in the games missed. Each team also shows a projected starting five,
  ranked from its last five games by starts weighted toward each player's
  own most recent appearances, so a rest night does not drop a regular
  starter while a starter moved to the bench loses his spot within two or
  three games. Players no longer on the roster are excluded. Starters
  listed Out are replaced by the next-ranked healthy players, marked as
  projected, so every lineup shows five. A starter who missed recent games
  with no injury listing gets a bolded "status unconfirmed" note, rotation
  players (20+ minutes) in the same situation are listed as "Also
  unaccounted for", and both feed the Line check's uncertainty bullet.
  Each starter has a hot/cold/steady scoring trend over their last five
  appearances against the five before, and a marker when a player entered
  the lineup within the last several games, which usually means injury
  cover. Above each lineup, "Starters O:, Starters DA:" gives the five's
  average indices (the average, not the sum, so 100 still means an average
  starter). Each starter also carries two normalized
  indices: an offense index (45% points per 36, 30% true shooting, 25%
  assists minus turnovers per 36) and a defensive activity index (40%
  steals, 40% blocks, 20% rebounds, per 36), z-scored across every
  tracked starter on the slates and mapped to mean 100 with 15 points
  per standard deviation. Defense is labelled "activity" deliberately:
  box scores cannot see positioning or rim protection, and true
  defensive ratings need stats.nba.com, which blocks cloud servers.
  Games that have not tipped off carry a prediction form. Saving a pick
  keeps you on the slate and returns you to that game's card, which then
  shows "Your pick: <team> by <margin> because <reasoning>" below the Line
  check and collapses the rest of the card behind a "View game details"
  button. Until tip-off, the details hold an update form (updating
  refreshes the frozen snapshot) and a "Changed since your pick" list
  comparing the snapshot with current data: line and win-probability
  moves, injury status changes, projected lineup changes, and games played
  in between. Changed items are also marked in place, in words, and the
  button label carries the count. Finished games swap the injury report for a "How it happened"
  section: a computed verdict against the pregame line (held up,
  overpriced favorite, or upset), the quarter where the game turned, the
  two or three box-score factors that decided it, top performers, and who
  was listed out for that game. It is rule-based text from the box score,
  labelled as such.
- **Cohesion** (on pregame cards): how long each team's projected
  starters have played together, from a lineup history of every game
  last season and this one, playoffs included: starts together for this
  exact five, the average starts together across the five's 10 pairs, and
  the share of this season's minutes from players who were on the team
  last season.
- **Insights** (`/insights/`): research results. First question: does the
  more cohesive team beat the spread? Every game is scored using only
  games played before it, results are shown by slice with 95% ranges, and
  the verdict states plainly when a result is indistinguishable from
  chance. Cohesion stays out of the Line check unless this test shows an
  edge.
- **Review** (`/review/`): every prediction with its outcome. Finished games
  are graded automatically at build time. Graded predictions get an automatically
  computed retrospective (your pick vs the market's pick vs the result,
  plus the box-score factors that decided the game) and a free-text
  notes box for your own takeaways. Each prediction keeps a frozen snapshot of its
  inputs, viewable inline.

## Data sources

All free, no API keys:

- `site.api.espn.com` — scoreboard, standings, injuries
- `sports.core.api.espn.com` — betting odds, including open vs. current lines

Lineup history lives in `data/history.db`, separate from your picks so it
can be deleted and rebuilt at any time. The server fills it in the
background on first start (about 1,500 games in under a minute; pages work
meanwhile) and then fetches only newly finished games, at most hourly. A
game ESPN has no box score for is skipped rather than retried forever.

Caching, fastest layer first:

1. An in-memory memo (60 seconds) merges identical requests, so one build
   reads each response once even with every game building in parallel.
2. `@11ty/eleventy-fetch` caches responses on disk in `.cache/`: odds and
   scoreboards for 2 minutes, injuries for 10, standings for 30, team
   schedules for 1 hour, player game logs for 3 hours. Schedules and game
   logs are large and only change when a game ends.
3. Finished-game summaries are stored permanently in `.cache/summaries/`,
   stripped to the fields the app reads (about 42 KB instead of 475 KB).

The server prunes `.cache/` at startup and then at most daily: fetch
responses unused for 2 days and summaries older than 45 days (last-10
analytics reach back about three weeks). Rest days are computed from the
previous four days of scoreboards. Odds are enrichment: cards render fine
before lines are posted.

Note: `stats.nba.com` (true net rating, pace) blocks datacenter IPs, so it is
not used yet.

## Running it

Requires Node 22 or newer. `npm run dev` checks this first and explains
how to fix it, because older versions can crash with "segmentation fault"
(the database driver does not support them), and `npm install` refuses to
run on them (`.npmrc` sets `engine-strict`). With nvm, `nvm use` picks the
right version from `.nvmrc`. After changing Node versions, delete
`node_modules` and run `npm install` again so the database driver is
rebuilt for the new version.

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The site builds once on startup (about 6
seconds cold, about 1 second warm), then rebuilds when you load a page more
than 5 minutes after the last build, after every saved prediction or note,
and on the "Refresh data now" button in the footer. To change the 5-minute
window, set `EDGEBOARD_STALE_MS` in milliseconds.

After pulling code changes, restart the server (Ctrl+C, then `npm run dev`
again). The running process keeps old code in Node's module cache, so a
refresh alone rebuilds with stale logic.

In a proxied environment (such as a Claude Code cloud container), Node's
fetch must be told to honor the proxy:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run dev
```

## Security and offline behavior

EdgeBoard is built for one person on one computer, and defends that:

- **Only this computer can reach it.** The server listens on 127.0.0.1
  (and ::1 where IPv6 exists), not on your network, so devices on the
  same Wi-Fi cannot see or change your picks, and Mac and Windows do not
  ask to allow incoming connections. To deliberately open it to your
  network, set `HOST=0.0.0.0` and list the addresses you will use in
  `EDGEBOARD_ALLOWED_HOSTS` (for example `192.168.1.20:3000`).
- **Only its own pages can change data.** Form submissions are accepted
  only when the browser marks them as coming from EdgeBoard itself
  (`Sec-Fetch-Site`, or a matching `Origin` or `Referer`), so another
  website cannot submit hidden forms to it.
- **Only requests addressed to it are answered.** Any other `Host` is
  refused, which blocks websites from reading it through a hostname trick
  (DNS rebinding).
- **Browsers are told to run no scripts at all**, never to show it inside
  another site's frame, and not to guess file types. The app uses no
  JavaScript, so this costs nothing and turns any future escaping mistake
  into a non-event.

**Offline:** if pages from an earlier run exist, the server starts
serving them immediately and refreshes in the background. When ESPN cannot
be reached, pages are rebuilt from data saved on this computer and every
page shows a notice saying when data was last really downloaded; it
retries at most once a minute. The cache is cleaned only after a
successful download, so time offline never deletes the data that keeps
the app working. A brand-new copy started offline shows a "No data yet"
page instead of crashing. Every network request has a deadline, so a
hanging connection cannot stall the app.

## Accessibility

WCAG 2.2 AA is the baseline. The current build passes axe-core (WCAG
2.0/2.1/2.2 A and AA rule tags) with zero violations on both pages in light
and dark schemes, and reflows without horizontal scrolling down to 320px
(Success Criterion 1.4.10). The layout uses the full window width: game
cards fill as many 32rem-minimum columns as fit, and in-card columns
respond to the card's width through container queries, not the window's. Because there is no client JavaScript, every interaction is
a native form submission with a full page response, so there are no live
regions, hydration gaps, or client state to announce.

Semantics worth preserving when editing: one `h1` per page, game cards are
`article` elements labelled by their heading, stat comparisons are real
tables with row and column headers, every signal is conveyed in text rather
than color alone, form feedback arrives as a navigated page (the review page
after a save, a descriptive error page with a way back on invalid input), and
interactive targets are at least 44px tall.
