// ESPN public API fetchers. No key required. Shared by the Eleventy data
// cascade (build time) and the form server (prediction snapshots).
//
// Three cache layers, fastest first:
// 1. An in-memory memo (60 s) that also merges concurrent identical
//    requests, so one build parses each response once.
// 2. @11ty/eleventy-fetch's disk cache, with per-endpoint durations.
// 3. A permanent disk store for finished-game summaries, stripped to the
//    fields the app reads (they never change once a game is final).

import EleventyFetch from "@11ty/eleventy-fetch";
import fs from "node:fs/promises";
import path from "node:path";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const SITE_V2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";

const ET = "America/New_York";

import { CACHE_DIR } from "./paths.mjs";
export { CACHE_DIR };
export const SUMMARY_DIR = path.join(CACHE_DIR, "summaries");

// Shorter than the shortest disk duration (2 minutes), so a memo can never
// serve data older than the disk cache would.
const MEMO_TTL_MS = 60_000;
const memo = new Map();

function memoized(key, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.promise;
  const promise = load();
  memo.set(key, { at: Date.now(), promise });
  // A failed load must not be remembered.
  promise.catch(() => {
    if (memo.get(key)?.promise === promise) memo.delete(key);
  });
  return promise;
}

// Drop expired memo entries so the map cannot grow across days of uptime.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at >= MEMO_TTL_MS) memo.delete(k);
}, MEMO_TTL_MS).unref();

async function getJson(url, duration) {
  return memoized(url, () =>
    EleventyFetch(url, {
      duration,
      type: "json",
      directory: CACHE_DIR,
      verbose: false,
      // A hung connection (captive Wi-Fi, flaky network) must not stall a
      // build; on timeout, expired cached data is used if it exists.
      timeout: 15000,
    }),
  );
}

/** Small concurrency gate for requests that bypass eleventy-fetch's queue. */
function limiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      next();
    });
}
const summaryGate = limiter(8);

/** Date in US Eastern time as YYYYMMDD (NBA slates are keyed to ET). */
export function slateDateEt(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(d)
    .replaceAll("-", "");
}

export function toEtDateString(isoUtc) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoUtc));
}

export function nowEtLabel(at = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

export function labelForYmd(ymd) {
  const d = new Date(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00Z`,
  );
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/* ------------------------------ scoreboard ------------------------------ */

function toTeamSide(c) {
  const overall = c.records?.find((r) => r.type === "total") ?? c.records?.[0];
  return {
    id: c.team.id,
    abbreviation: c.team.abbreviation,
    displayName: c.team.displayName,
    shortDisplayName: c.team.shortDisplayName,
    record: overall?.summary ?? null,
    homeAway: c.homeAway,
    score: c.score !== undefined ? Number(c.score) : null,
    winner: c.winner ?? null,
  };
}

export async function getScoreboard(ymd) {
  const data = await getJson(`${SITE}/scoreboard?dates=${ymd}`, "2m");
  return (data.events ?? []).map((e) => {
    const comps = e.competitions?.[0]?.competitors ?? [];
    const home = comps.find((c) => c.homeAway === "home");
    const away = comps.find((c) => c.homeAway === "away");
    if (!home || !away) {
      throw new Error(`Event ${e.id} is missing a home or away competitor`);
    }
    return {
      id: e.id,
      dateUtc: e.date,
      name: e.name,
      shortName: e.shortName,
      statusState: e.status?.type?.state ?? "pre",
      statusDetail: e.status?.type?.detail ?? "",
      home: toTeamSide(home),
      away: toTeamSide(away),
    };
  });
}

/* --------------------------------- odds --------------------------------- */

function parseAmerican(v) {
  if (!v?.american) return null;
  const n = Number(String(v.american).replace("+", ""));
  return Number.isFinite(n) ? n : null;
}

export async function getOdds(eventId) {
  try {
    const data = await getJson(
      `${CORE}/events/${eventId}/competitions/${eventId}/odds`,
      "2m",
    );
    const items = data.items ?? [];
    if (items.length === 0) return null;
    const best =
      items.find((i) => i.provider?.name === "DraftKings") ?? items[0];
    return {
      provider: best.provider?.name ?? "Unknown",
      details: best.details ?? null,
      overUnder: best.overUnder ?? null,
      spread: best.spread ?? null,
      awayMoneyline: best.awayTeamOdds?.moneyLine ?? null,
      homeMoneyline: best.homeTeamOdds?.moneyLine ?? null,
      openTotal: parseAmerican(best.open?.total),
      currentTotal: parseAmerican(best.current?.total),
      openAwaySpread: parseAmerican(best.open?.pointSpread?.away),
      currentAwaySpread: parseAmerican(best.current?.pointSpread?.away),
      fetchedAtUtc: new Date().toISOString(),
    };
  } catch {
    return null; // Odds are enrichment, never a hard dependency.
  }
}

/* ------------------------------- injuries ------------------------------- */

function athleteIdFromLinks(links) {
  for (const l of links ?? []) {
    const m = /\/id\/(\d+)\//.exec(l.href ?? "");
    if (m) return m[1];
  }
  return null;
}

export async function getInjuriesByTeamId() {
  const data = await getJson(`${SITE}/injuries`, "10m");
  const map = new Map();
  for (const team of data.injuries ?? []) {
    const items = (team.injuries ?? []).map((i) => ({
      athlete: i.athlete?.displayName ?? "Unknown player",
      athleteId: athleteIdFromLinks(i.athlete?.links),
      position: i.athlete?.position?.abbreviation ?? null,
      status: i.status ?? "Unknown",
      comment: i.shortComment ?? i.longComment ?? null,
      dateUtc: i.date ?? null,
      returnDate: i.details?.returnDate ?? null,
      injuryType: i.details?.type ?? null,
    }));
    map.set(team.id, items);
  }
  return map;
}

/** Full game summary (box score, leaders, line scores). Finals only: cached a day. */
/** Keep only what the app reads: about 60 KB instead of about 475 KB. */
function stripSummary(s) {
  return {
    header: s.header,
    boxscore: s.boxscore,
    winprobability: (s.winprobability ?? [])
      .map((p) => p.homeWinPercentage)
      .filter((v) => typeof v === "number"),
  };
}

export async function getGameSummary(eventId) {
  const id = String(eventId);
  if (!/^\d+$/.test(id)) throw new Error(`Invalid event id: ${id}`);
  return memoized(`summary:${id}`, async () => {
    const file = path.join(SUMMARY_DIR, `${id}.json`);
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // Not stored yet: fetch below.
    }
    const raw = await summaryGate(async () => {
      const res = await fetch(`${SITE}/summary?event=${id}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`ESPN summary failed (${res.status}) for ${id}`);
      return res.json();
    });
    const stripped = stripSummary(raw);
    const final =
      raw.header?.competitions?.[0]?.status?.type?.state === "post";
    if (final) {
      await fs.mkdir(SUMMARY_DIR, { recursive: true });
      // Write then rename, so a crash mid-write never leaves a torn file.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(stripped));
      await fs.rename(tmp, file);
    }
    return stripped;
  });
}

/**
 * Delete cache files past their useful life. eleventy-fetch entries all
 * expire within 3 hours, so anything two days old is dead weight.
 * Stored summaries feed last-10 analytics (about three weeks of games),
 * so they are kept for 45 days.
 */
export async function pruneCache() {
  const now = Date.now();
  const sweep = async (dir, maxAgeMs, match) => {
    let removed = 0;
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!match(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fs.stat(file);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          await fs.unlink(file);
          removed++;
        }
      } catch {
        // Raced with another writer; skip.
      }
    }
    return removed;
  };
  const day = 86_400_000;
  const fetchRemoved = await sweep(CACHE_DIR, 2 * day, (n) => n.startsWith("eleventy-fetch-"));
  const summaryRemoved = await sweep(SUMMARY_DIR, 45 * day, (n) => n.endsWith(".json") || n.endsWith(".tmp"));
  return { fetchRemoved, summaryRemoved };
}

/** Raw gamelog for one athlete (per-game stat rows plus game metadata). */
export async function getAthleteGamelog(athleteId) {
  return getJson(
    `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/gamelog`,
    // About 160 KB each and only changes when the player's game ends.
    "3h",
  );
}

/** Athlete ids currently on a team's roster, or null when unavailable. */
export async function getTeamRosterIds(teamId) {
  try {
    const data = await getJson(`${SITE}/teams/${teamId}/roster`, "6h");
    const ids = new Set((data.athletes ?? []).map((a) => String(a.id)));
    return ids.size > 0 ? ids : null;
  } catch {
    return null; // Without a roster, skip the check rather than fail.
  }
}

/** A team's completed games this season, newest first: {eventId, dateUtc, won}. */
export async function getTeamCompletedGames(teamId) {
  // About 880 KB each; the completed-games list only changes when a game ends.
  const data = await getJson(`${SITE}/teams/${teamId}/schedule`, "1h");
  const done = [];
  for (const e of data.events ?? []) {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.state !== "post") continue;
    const mine = comp.competitors?.find((c) => c.team?.id === String(teamId) || c.id === String(teamId));
    done.push({
      eventId: String(e.id),
      dateUtc: e.date,
      won: mine?.winner === true,
    });
  }
  done.sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : -1));
  return done;
}

/* ------------------------------- standings ------------------------------ */

export async function getTeamFormByTeamId() {
  const data = await getJson(`${SITE_V2}/standings`, "30m");
  const map = new Map();
  for (const conf of data.children ?? []) {
    for (const entry of conf.standings?.entries ?? []) {
      const stat = (name) =>
        entry.stats.find((s) => s.name === name || s.type === name);
      map.set(entry.team.id, {
        teamId: entry.team.id,
        abbreviation: entry.team.abbreviation ?? "",
        wins: stat("wins")?.value ?? 0,
        losses: stat("losses")?.value ?? 0,
        avgPointsFor: stat("avgPointsFor")?.value ?? null,
        avgPointsAgainst: stat("avgPointsAgainst")?.value ?? null,
        pointDifferential: stat("pointDifferential")?.value ?? null,
        streak: stat("streak")?.displayValue ?? null,
        lastTen: stat("lasttengames")?.displayValue ?? null,
      });
    }
  }
  return map;
}

/* ------------------------------ rest lookup ----------------------------- */

/**
 * Rest days per team, from the previous few days of scoreboards.
 * One scoreboard call per lookback day instead of one per team.
 */
export async function getRestByTeamId(slateYmd, lookbackDays = 4) {
  const map = new Map();
  const slateDate = new Date(
    `${slateYmd.slice(0, 4)}-${slateYmd.slice(4, 6)}-${slateYmd.slice(6, 8)}T12:00:00Z`,
  );
  for (let back = 1; back <= lookbackDays; back++) {
    const d = new Date(slateDate.getTime() - back * 86_400_000);
    const ymd = d.toISOString().slice(0, 10).replaceAll("-", "");
    let games = [];
    try {
      games = await getScoreboard(ymd);
    } catch {
      continue;
    }
    for (const g of games) {
      for (const side of [g.home, g.away]) {
        if (!map.has(side.id)) {
          map.set(side.id, {
            lastGameDateEt: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
            daysOfRest: back - 1,
            backToBack: back === 1,
          });
        }
      }
    }
  }
  return map;
}
