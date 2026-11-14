# EdgeBoard

A personal NBA decision tool. It puts the stats, betting lines, line movement,
and injury news for each game on one screen, lets you log a prediction with
your reasoning, freezes a snapshot of everything you knew at that moment, then
grades the prediction after the game and prompts a retrospective so your
process improves over time.

EdgeBoard does not pretend to beat the closing line. It helps you synthesize
public information faster, and it keeps you honest about whether your reads
are working.

## Pages

- **Slate** (`/`): game cards for a date (yesterday, today, tomorrow, or
  `/?date=YYYYMMDD`). Each card shows the DraftKings line, total, moneylines,
  and any movement from open; team records, scoring averages, last-10 form and
  streak; rest days and back-to-backs; and both teams' injury reports. Games
  that have not tipped off carry a prediction form.
- **Review** (`/review`): every prediction with its outcome. On load, finished
  games are graded automatically. Graded predictions get a retrospective form
  with cause tags (in-game injury, untracked signal, variance, and so on) and
  notes. Each prediction keeps a frozen snapshot of its inputs, viewable
  inline.

## Data sources

All free, no API keys:

- `site.api.espn.com` — scoreboard, standings, injuries
- `sports.core.api.espn.com` — betting odds, including open vs. current lines

Rest days are computed from the previous four days of scoreboards. Odds are
enrichment: cards render fine before lines are posted.

Note: `stats.nba.com` (true net rating, pace) blocks datacenter IPs, so it is
not used yet. Adding it from a residential connection or a nightly job is a
planned enhancement.

## Storage

SQLite file at `data/edgeboard.db`, created on first use and gitignored. One
`predictions` table holds the pick, reasoning, frozen input snapshot (JSON),
reconciliation result, and retrospective. For Vercel deployment, port the
storage layer in `src/lib/db.ts` to Turso (libSQL) or Neon Postgres; the
schema carries over as is.

## Development

```bash
npm install
npm run dev
```

In a proxied environment (such as a Claude Code cloud container), Node's fetch
must be told to honor the proxy:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run dev
```

## Accessibility

WCAG 2.2 AA is the baseline. Current build passes axe-core (WCAG 2.0/2.1/2.2
A and AA rule tags) with zero violations on both pages in light and dark
schemes. Semantics worth preserving when editing: one `h1` per page, game
cards are `article` elements labelled by their heading, stat comparisons are
real tables with row and column headers, line movement is conveyed in text
rather than color alone, form status messages render inside persistent
`role="status"` live regions, and interactive targets are at least 44px tall.

Known trap documented in `src/app/actions.ts`: do not add `revalidatePath` to
the form actions. It re-renders the submitting page in the same response,
unmounting the form's live region before screen readers announce the result.
