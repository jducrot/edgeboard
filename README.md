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
  writes to SQLite, and rebuilds the site when data changes. It also
  rebuilds every 5 minutes so lines and injury news stay fresh.
- SQLite (better-sqlite3) stores predictions at `data/edgeboard.db`,
  created on first use and gitignored. Your picks never leave your machine.

## Pages

- **Slate** (`/`, redirects to `/slate/YYYYMMDD/`): game cards for
  yesterday, today, and tomorrow. Each card shows the DraftKings line,
  total, moneylines, and movement from open; records, scoring averages,
  last-10 form and streaks; rest days and back-to-backs; and both teams'
  injury reports. Games that have not tipped off carry a prediction form.
- **Review** (`/review/`): every prediction with its outcome. Finished games
  are graded automatically at build time. Graded predictions get a
  retrospective form with cause tags (in-game injury, untracked signal,
  variance, and so on). Each prediction keeps a frozen snapshot of its
  inputs, viewable inline.

## Data sources

All free, no API keys:

- `site.api.espn.com` — scoreboard, standings, injuries
- `sports.core.api.espn.com` — betting odds, including open vs. current lines

Responses are cached on disk (`.cache/`) by `@11ty/eleventy-fetch`: odds and
scoreboards for 2 minutes, injuries for 10, standings for 30. Rest days are
computed from the previous four days of scoreboards. Odds are enrichment:
cards render fine before lines are posted.

Note: `stats.nba.com` (true net rating, pace) blocks datacenter IPs, so it is
not used yet.

## Running it

Requires Node 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The site builds once on startup, rebuilds
every 5 minutes, after every saved prediction or retrospective, and on the
"Refresh data now" button in the footer.

In a proxied environment (such as a Claude Code cloud container), Node's
fetch must be told to honor the proxy:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run dev
```

## Accessibility

WCAG 2.2 AA is the baseline. The current build passes axe-core (WCAG
2.0/2.1/2.2 A and AA rule tags) with zero violations on both pages in light
and dark schemes. Because there is no client JavaScript, every interaction is
a native form submission with a full page response, so there are no live
regions, hydration gaps, or client state to announce.

Semantics worth preserving when editing: one `h1` per page, game cards are
`article` elements labelled by their heading, stat comparisons are real
tables with row and column headers, line movement is conveyed in text rather
than color alone, form feedback arrives as a navigated page (the review page
after a save, a descriptive error page with a way back on invalid input), and
interactive targets are at least 44px tall.
