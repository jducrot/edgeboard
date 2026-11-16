// Lineup history: every completed game from last season and this one
// (regular season, play-in, and playoffs), with who started, who played
// how many minutes, and the pregame spread. Stored permanently in
// data/history.db, separate from the predictions database so it can be
// rebuilt at any time without touching the owner's picks.
//
// Sources, all public ESPN endpoints:
// - one scoreboard call per month lists every game with teams and scores
// - one box score per game gives starters and minutes for both teams
// - one small odds call per game gives the pregame spread

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./paths.mjs";

const DB_PATH = path.join(DATA_DIR, "history.db");
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
// Regular season, playoffs, and play-in. Preseason and All-Star are excluded.
const SEASON_TYPES = new Set([2, 3, 5]);
const CONCURRENCY = 6;

let db = null;

export function historyDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      event_id TEXT PRIMARY KEY,
      season INTEGER NOT NULL,          -- ending year: 2026 is 2025-26
      season_type INTEGER NOT NULL,     -- 2 regular, 3 playoffs, 5 play-in
      date_utc TEXT NOT NULL,
      home_id TEXT NOT NULL,
      away_id TEXT NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      home_line REAL,                   -- expected home margin; positive = home favored
      lineups_done INTEGER NOT NULL DEFAULT 0   -- 0 pending, 1 done, -1 not available from ESPN
    );
    CREATE TABLE IF NOT EXISTS appearances (
      event_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      name TEXT NOT NULL,
      started INTEGER NOT NULL,
      minutes REAL NOT NULL,
      PRIMARY KEY (event_id, athlete_id)
    );
    CREATE INDEX IF NOT EXISTS idx_app_team ON appearances (team_id);
    CREATE INDEX IF NOT EXISTS idx_games_date ON games (date_utc);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

/** NBA seasons are named by their ending year; a season starts in October. */
export function currentSeasonYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 8 ? y + 1 : y; // September onward belongs to next season
}

function monthsFor(season, now) {
  const months = [];
  for (let d = new Date(Date.UTC(season - 1, 9, 1)); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) {
    if (d >= new Date(Date.UTC(season, 6, 1))) break; // Season over by July.
    months.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const err = new Error(`ESPN ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function gate(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

/** Record the month's completed games; returns how many were new. */
async function syncMonth(yyyymm, final) {
  const d = historyDb();
  const metaKey = `month:${yyyymm}`;
  if (final && d.prepare("SELECT 1 FROM meta WHERE key = ?").get(metaKey)) return 0;
  const data = await getJson(`${SITE}/scoreboard?dates=${yyyymm}&limit=500`);
  const insert = d.prepare(`
    INSERT INTO games (event_id, season, season_type, date_utc, home_id, away_id, home_score, away_score)
    VALUES (@id, @season, @type, @date, @home, @away, @hs, @as)
    ON CONFLICT(event_id) DO NOTHING`);
  let added = 0;
  d.transaction(() => {
    for (const e of data.events ?? []) {
      const comp = e.competitions?.[0];
      if (comp?.status?.type?.state !== "post") continue;
      if (!SEASON_TYPES.has(e.season?.type)) continue;
      const home = comp.competitors?.find((c) => c.homeAway === "home");
      const away = comp.competitors?.find((c) => c.homeAway === "away");
      // The 30 franchises have ESPN ids 1 to 30; All-Star teams do not.
      const isTeam = (c) => Number(c?.team?.id) >= 1 && Number(c?.team?.id) <= 30;
      if (!isTeam(home) || !isTeam(away)) continue;
      const r = insert.run({
        id: String(e.id),
        season: e.season.year,
        type: e.season.type,
        date: e.date,
        home: String(home.team.id),
        away: String(away.team.id),
        hs: Number(home.score),
        as: Number(away.score),
      });
      added += r.changes;
    }
    if (final) d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(metaKey, "1");
  })();
  return added;
}

/** Starters, minutes, and the pregame spread for one game. */
async function syncGameDetails(eventId) {
  const [summary, odds] = await Promise.all([
    getJson(`${SITE}/summary?event=${eventId}`),
    getJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds`).catch(() => null),
  ]);
  const rows = [];
  for (const tb of summary.boxscore?.players ?? []) {
    const block = tb.statistics?.[0];
    const labels = block?.names ?? block?.labels ?? [];
    const iMin = labels.indexOf("MIN");
    for (const a of block?.athletes ?? []) {
      if (a.didNotPlay || !a.athlete?.id) continue;
      const min = iMin >= 0 ? Number(a.stats?.[iMin]) : NaN;
      rows.push({
        event: String(eventId),
        team: String(tb.team?.id),
        athlete: String(a.athlete.id),
        name: a.athlete.displayName ?? "Unknown",
        started: a.starter ? 1 : 0,
        minutes: Number.isFinite(min) ? min : 0,
      });
    }
  }
  // The pregame line, not the live in-game line ESPN also lists.
  const pregame = (odds?.items ?? []).find((i) => !/live/i.test(i.provider?.name ?? ""));
  // ESPN's spread is from the home side: -6.5 means home favored by 6.5.
  const homeLine = Number.isFinite(pregame?.spread) ? -pregame.spread : null;

  const d = historyDb();
  d.transaction(() => {
    const ins = d.prepare(`
      INSERT OR REPLACE INTO appearances (event_id, team_id, athlete_id, name, started, minutes)
      VALUES (@event, @team, @athlete, @name, @started, @minutes)`);
    for (const r of rows) ins.run(r);
    d.prepare("UPDATE games SET home_line = ?, lineups_done = 1 WHERE event_id = ?").run(homeLine, String(eventId));
  })();
}

let syncing = null;

/**
 * Bring the history up to date: last season once, then only new games.
 * Safe to call often; concurrent calls share one run.
 */
export function syncHistory({ log = () => {} } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const now = new Date();
    const season = currentSeasonYear(now);
    const thisMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    let newGames = 0;
    for (const s of [season - 1, season]) {
      for (const m of monthsFor(s, now)) {
        newGames += await syncMonth(m, m < thisMonth);
      }
    }
    const pending = historyDb()
      .prepare("SELECT event_id FROM games WHERE lineups_done = 0 ORDER BY date_utc")
      .all()
      .map((r) => r.event_id);
    if (pending.length > 0) log(`Lineup history: fetching ${pending.length} box scores.`);
    const run = gate(CONCURRENCY);
    let done = 0;
    let failed = 0;
    let unavailable = 0;
    await Promise.all(
      pending.map((id) =>
        run(async () => {
          try {
            await syncGameDetails(id);
            done++;
            if (done % 250 === 0) log(`Lineup history: ${done} of ${pending.length}`);
          } catch (e) {
            if (e.status === 404) {
              // ESPN has no box score for this game; do not retry forever.
              historyDb().prepare("UPDATE games SET lineups_done = -1 WHERE event_id = ?").run(id);
              unavailable++;
            } else {
              failed++; // Network or server trouble: retried on the next sync.
            }
          }
        }),
      ),
    );
    historyDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('synced_at', ?)").run(new Date().toISOString());
    if (unavailable > 0) log(`Lineup history: ${unavailable} games have no box score on ESPN and were skipped.`);
    return { newGames, fetched: done, failed, unavailable };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Changes whenever new lineup data lands, so caches know to refresh. */
export function historyVersion() {
  const r = historyDb()
    .prepare("SELECT COUNT(*) AS n, MAX(date_utc) AS last FROM games WHERE lineups_done = 1")
    .get();
  return `${r.n}:${r.last ?? ""}`;
}
