// ESPN public API fetchers. No key required. Shared by the Eleventy data
// cascade (build time) and the form server (prediction snapshots).
// Responses are cached on disk by @11ty/eleventy-fetch so repeated builds
// stay fast and polite.

import EleventyFetch from "@11ty/eleventy-fetch";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const SITE_V2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";

const ET = "America/New_York";

async function getJson(url, duration) {
  return EleventyFetch(url, {
    duration,
    type: "json",
    directory: ".cache",
    verbose: false,
  });
}

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

export function nowEtLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
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

export async function getInjuriesByTeamId() {
  const data = await getJson(`${SITE}/injuries`, "10m");
  const map = new Map();
  for (const team of data.injuries ?? []) {
    const items = (team.injuries ?? []).map((i) => ({
      athlete: i.athlete?.displayName ?? "Unknown player",
      position: i.athlete?.position?.abbreviation ?? null,
      status: i.status ?? "Unknown",
      comment: i.shortComment ?? i.longComment ?? null,
      dateUtc: i.date ?? null,
    }));
    map.set(team.id, items);
  }
  return map;
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
