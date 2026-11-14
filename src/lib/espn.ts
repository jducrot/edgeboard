// ESPN public API fetchers. No key required.
// Hosts: site.api.espn.com (scoreboard, injuries, standings),
//        sports.core.api.espn.com (odds).

import type {
  GameSummary,
  InjuryItem,
  OddsSnapshot,
  RestInfo,
  TeamForm,
  TeamSide,
} from "./types";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const SITE_V2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";

const ET = "America/New_York";

/** Today's date in US Eastern time as YYYYMMDD (NBA slates are keyed to ET). */
export function slateDateEt(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA gives YYYY-MM-DD
  return parts.replaceAll("-", "");
}

export function toEtDateString(isoUtc: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoUtc));
}

async function getJson<T>(url: string, revalidateSeconds: number): Promise<T> {
  const res = await fetch(url, { next: { revalidate: revalidateSeconds } });
  if (!res.ok) {
    throw new Error(`ESPN request failed (${res.status}): ${url}`);
  }
  return (res.json() as Promise<T>);
}

/* ------------------------------ scoreboard ------------------------------ */

interface EspnCompetitor {
  homeAway: "home" | "away";
  winner?: boolean;
  score?: string;
  team: {
    id: string;
    abbreviation: string;
    displayName: string;
    shortDisplayName: string;
    logo?: string;
  };
  records?: { summary: string; type?: string }[];
}

interface EspnEvent {
  id: string;
  date: string;
  name: string;
  shortName: string;
  status: { type: { state: "pre" | "in" | "post"; detail: string } };
  competitions: { id: string; competitors: EspnCompetitor[] }[];
}

function toTeamSide(c: EspnCompetitor): TeamSide {
  const overall = c.records?.find((r) => r.type === "total") ?? c.records?.[0];
  return {
    id: c.team.id,
    abbreviation: c.team.abbreviation,
    displayName: c.team.displayName,
    shortDisplayName: c.team.shortDisplayName,
    logo: c.team.logo,
    record: overall?.summary,
    homeAway: c.homeAway,
    score: c.score !== undefined ? Number(c.score) : undefined,
    winner: c.winner,
  };
}

export async function getScoreboard(dateYyyymmdd: string): Promise<GameSummary[]> {
  const data = await getJson<{ events?: EspnEvent[] }>(
    `${SITE}/scoreboard?dates=${dateYyyymmdd}`,
    120,
  );
  return (data.events ?? []).map((e) => {
    const comps = e.competitions[0]?.competitors ?? [];
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
      statusState: e.status.type.state,
      statusDetail: e.status.type.detail,
      home: toTeamSide(home),
      away: toTeamSide(away),
    };
  });
}

/* --------------------------------- odds --------------------------------- */

interface EspnOddsValue {
  american?: string;
}
interface EspnOddsBlock {
  pointSpread?: { away?: EspnOddsValue; home?: EspnOddsValue };
  total?: EspnOddsValue;
}
interface EspnOddsItem {
  provider?: { name?: string; priority?: number };
  details?: string;
  overUnder?: number;
  spread?: number;
  awayTeamOdds?: { moneyLine?: number };
  homeTeamOdds?: { moneyLine?: number };
  open?: EspnOddsBlock;
  current?: EspnOddsBlock;
}

function parseAmerican(v?: EspnOddsValue): number | null {
  if (!v?.american) return null;
  const n = Number(v.american.replace("+", ""));
  return Number.isFinite(n) ? n : null;
}

export async function getOdds(eventId: string): Promise<OddsSnapshot | null> {
  try {
    const data = await getJson<{ items?: EspnOddsItem[] }>(
      `${CORE}/events/${eventId}/competitions/${eventId}/odds`,
      120,
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
    // Odds are enrichment, not a hard dependency.
    return null;
  }
}

/* ------------------------------- injuries ------------------------------- */

interface EspnInjuryTeam {
  id: string;
  displayName: string;
  injuries?: {
    status?: string;
    date?: string;
    shortComment?: string;
    longComment?: string;
    athlete?: { displayName?: string; position?: { abbreviation?: string } };
  }[];
}

export async function getInjuriesByTeamId(): Promise<Map<string, InjuryItem[]>> {
  const data = await getJson<{ injuries?: EspnInjuryTeam[] }>(
    `${SITE}/injuries`,
    600,
  );
  const map = new Map<string, InjuryItem[]>();
  for (const team of data.injuries ?? []) {
    const items: InjuryItem[] = (team.injuries ?? []).map((i) => ({
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

interface EspnStandingStat {
  name?: string;
  type?: string;
  value?: number;
  displayValue?: string;
}
interface EspnStandingEntry {
  team: { id: string; abbreviation?: string };
  stats: EspnStandingStat[];
}

export async function getTeamFormByTeamId(): Promise<Map<string, TeamForm>> {
  const data = await getJson<{
    children?: { standings?: { entries?: EspnStandingEntry[] } }[];
  }>(`${SITE_V2}/standings`, 1800);
  const map = new Map<string, TeamForm>();
  for (const conf of data.children ?? []) {
    for (const entry of conf.standings?.entries ?? []) {
      const stat = (name: string) =>
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
 * Rest days per team, computed from the previous few days of scoreboards.
 * Cheap: one scoreboard call per lookback day instead of one per team.
 */
export async function getRestByTeamId(
  slateYyyymmdd: string,
  lookbackDays = 4,
): Promise<Map<string, RestInfo>> {
  const map = new Map<string, RestInfo>();
  const slateDate = new Date(
    `${slateYyyymmdd.slice(0, 4)}-${slateYyyymmdd.slice(4, 6)}-${slateYyyymmdd.slice(6, 8)}T12:00:00Z`,
  );
  for (let back = 1; back <= lookbackDays; back++) {
    const d = new Date(slateDate.getTime() - back * 86_400_000);
    const ymd = d.toISOString().slice(0, 10).replaceAll("-", "");
    let games: GameSummary[] = [];
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
