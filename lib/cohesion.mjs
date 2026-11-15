// Cohesion: how long a team's players have played together, and whether
// that has predicted results against the spread.
//
// Measures (from data/history.db, this season and last, playoffs included):
// - five together: games this exact starting five has started together
// - average pair: for the 10 pairs within a five, games each pair started
//   together, averaged. One new player lowers it instead of zeroing it.
// - returning minutes: share of this season's team minutes played by
//   players who also played for the team last season
//
// The backtest walks every game in date order and scores each one using
// only games played before it, so it never sees the future.

import { historyDb, historyVersion, currentSeasonYear } from "./history.mjs";

const BREAK_EVEN = 52.38; // Win rate needed to profit at standard -110 pricing.

function pairsOf(ids) {
  const sorted = [...ids].sort();
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) pairs.push(`${sorted[i]}|${sorted[j]}`);
  }
  return pairs;
}

const fiveKey = (ids) => [...ids].sort().join("|");

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 95% Wilson interval for a proportion, in percent. */
function wilson(successes, n) {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [100 * (center - half), 100 * (center + half)];
}

let cached = null;

/** Build (or reuse) the in-memory index. Rebuilt only when history changes. */
export function cohesionIndex() {
  const version = historyVersion();
  if (cached?.version === version) return cached;

  const d = historyDb();
  const games = d
    .prepare(
      `SELECT event_id, season, season_type, date_utc, home_id, away_id,
              home_score, away_score, home_line
       FROM games WHERE lineups_done = 1 ORDER BY date_utc`,
    )
    .all();
  const byEvent = new Map();
  for (const a of d.prepare("SELECT event_id, team_id, athlete_id, started, minutes FROM appearances").iterate()) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id).push(a);
  }

  const pairStarts = new Map();
  const fiveStarts = new Map(); // "all|key" and "<season>|key"
  const teamGames = new Map();
  const teamSeasonGameNo = new Map();
  const seasonMinutes = new Map(); // "<season>|<team>" -> Map(athlete -> minutes)
  const backtest = [];

  for (const g of games) {
    const apps = byEvent.get(g.event_id) ?? [];
    const starters = {
      [g.home_id]: apps.filter((a) => a.team_id === g.home_id && a.started).map((a) => a.athlete_id),
      [g.away_id]: apps.filter((a) => a.team_id === g.away_id && a.started).map((a) => a.athlete_id),
    };
    const pairAvg = (ids) => {
      const p = pairsOf(ids);
      return p.reduce((t, k) => t + (pairStarts.get(k) ?? 0), 0) / p.length;
    };

    // Score this game from history before it.
    const gameNo = (team) => (teamSeasonGameNo.get(`${g.season}|${team}`) ?? 0) + 1;
    if (
      g.home_line !== null &&
      starters[g.home_id].length === 5 &&
      starters[g.away_id].length === 5 &&
      (teamGames.get(g.home_id) ?? 0) >= 10 &&
      (teamGames.get(g.away_id) ?? 0) >= 10
    ) {
      backtest.push({
        season: g.season,
        seasonType: g.season_type,
        homePair: pairAvg(starters[g.home_id]),
        awayPair: pairAvg(starters[g.away_id]),
        homeMargin: g.home_score - g.away_score,
        homeLine: g.home_line,
        early: Math.min(gameNo(g.home_id), gameNo(g.away_id)) <= 20,
      });
    }

    // Then add the game to history.
    for (const team of [g.home_id, g.away_id]) {
      const ids = starters[team];
      for (const k of pairsOf(ids)) pairStarts.set(k, (pairStarts.get(k) ?? 0) + 1);
      if (ids.length === 5) {
        const k = fiveKey(ids);
        fiveStarts.set(`all|${k}`, (fiveStarts.get(`all|${k}`) ?? 0) + 1);
        fiveStarts.set(`${g.season}|${k}`, (fiveStarts.get(`${g.season}|${k}`) ?? 0) + 1);
      }
      teamGames.set(team, (teamGames.get(team) ?? 0) + 1);
      teamSeasonGameNo.set(`${g.season}|${team}`, gameNo(team));
      const mk = `${g.season}|${team}`;
      if (!seasonMinutes.has(mk)) seasonMinutes.set(mk, new Map());
      const mm = seasonMinutes.get(mk);
      for (const a of apps) {
        if (a.team_id === team) mm.set(a.athlete_id, (mm.get(a.athlete_id) ?? 0) + a.minutes);
      }
    }
  }

  const season = currentSeasonYear();
  // What a typical starting lineup looks like this season, for context.
  const thisSeasonPairs = backtest
    .filter((b) => b.season === season)
    .flatMap((b) => [b.homePair, b.awayPair]);

  cached = {
    version,
    season,
    pairStarts,
    fiveStarts,
    seasonMinutes,
    backtest,
    typicalPair: median(thisSeasonPairs),
    gamesCovered: games.length,
  };
  return cached;
}

/** Cohesion of a projected five, for a game card. */
export function lineupCohesion(index, teamId, athleteIds) {
  const ids = (athleteIds ?? []).filter(Boolean);
  if (ids.length !== 5) return null;
  const k = fiveKey(ids);
  const pairs = pairsOf(ids);
  const pairAvg = pairs.reduce((t, p) => t + (index.pairStarts.get(p) ?? 0), 0) / pairs.length;

  const thisSeason = index.seasonMinutes.get(`${index.season}|${teamId}`);
  const lastSeason = index.seasonMinutes.get(`${index.season - 1}|${teamId}`);
  let returningPct = null;
  if (thisSeason && lastSeason) {
    let total = 0;
    let returning = 0;
    for (const [athlete, min] of thisSeason) {
      total += min;
      if (lastSeason.has(athlete)) returning += min;
    }
    if (total > 0) returningPct = Math.round((100 * returning) / total);
  }

  return {
    fiveAll: index.fiveStarts.get(`all|${k}`) ?? 0,
    fiveThisSeason: index.fiveStarts.get(`${index.season}|${k}`) ?? 0,
    pairAvg: Math.round(pairAvg),
    returningPct,
  };
}

function summarize(rows) {
  let covered = 0;
  let decided = 0;
  let won = 0;
  for (const r of rows) {
    const homeMoreCohesive = r.homePair > r.awayPair;
    const ats = r.homeMargin - r.homeLine;
    if (ats !== 0) {
      decided++;
      if ((ats > 0) === homeMoreCohesive) covered++;
    }
    if ((r.homeMargin > 0) === homeMoreCohesive) won++;
  }
  const ci = wilson(covered, decided);
  return {
    games: decided,
    coverPct: decided ? (100 * covered) / decided : null,
    low: ci?.[0] ?? null,
    high: ci?.[1] ?? null,
    wonPct: rows.length ? (100 * won) / rows.length : null,
  };
}

/** Does the more cohesive team beat the spread? */
export function cohesionBacktest(index) {
  const rows = index.backtest.filter((r) => r.homePair !== r.awayPair);
  const gap = (r) => Math.abs(r.homePair - r.awayPair);
  const gaps = rows.map(gap).sort((a, b) => a - b);
  const t1 = gaps[Math.floor(gaps.length / 3)] ?? 0;
  const t2 = gaps[Math.floor((2 * gaps.length) / 3)] ?? 0;

  const groups = [
    { label: "All games", rows },
    { label: "Large cohesion gap (top third)", rows: rows.filter((r) => gap(r) > t2) },
    { label: "Medium gap (middle third)", rows: rows.filter((r) => gap(r) > t1 && gap(r) <= t2) },
    { label: "Small gap (bottom third)", rows: rows.filter((r) => gap(r) <= t1) },
    { label: "Early season (a team's first 20 games)", rows: rows.filter((r) => r.early && r.seasonType !== 3) },
    { label: "Rest of the regular season", rows: rows.filter((r) => !r.early && r.seasonType !== 3) },
    { label: "Playoffs", rows: rows.filter((r) => r.seasonType === 3) },
  ].map((g) => ({ label: g.label, ...summarize(g.rows) }));

  const all = groups[0];
  const large = groups[1];
  let verdict;
  if (large.low !== null && large.low > BREAK_EVEN) {
    verdict = `When the cohesion gap is large, the more cohesive team has covered ${large.coverPct.toFixed(1)}% of the time, and even the low end of the range clears the ${BREAK_EVEN}% needed to profit at standard odds. That is a real, bettable edge so far.`;
  } else if (large.low !== null && large.low > 50) {
    verdict = `When the cohesion gap is large, the more cohesive team has covered ${large.coverPct.toFixed(1)}% of the time. That is better than a coin flip, but not yet clearly above the ${BREAK_EVEN}% needed to profit after the bookmaker's cut. Promising; keep watching.`;
  } else if (all.high !== null && all.high < 50) {
    verdict = `The more cohesive team has covered only ${all.coverPct.toFixed(1)}% of the time. If anything, the market overrates cohesion.`;
  } else {
    verdict = `No edge against the spread so far: the more cohesive team has covered ${all.coverPct?.toFixed(1)}% of ${all.games} games, which is indistinguishable from a coin flip. Cohesive teams do win more often (${all.wonPct?.toFixed(1)}% straight up), but the spread already accounts for that. Cohesion still helps explain games; it just has not beaten the line.`;
  }

  // Slicing seven ways makes one slice likely to look good by luck alone.
  const slices = groups.slice(1);
  const best = slices
    .filter((g) => g.low !== null && g.low > 50)
    .sort((a, b) => b.coverPct - a.coverPct)[0];
  const caution = best
    ? `The strongest slice is "${best.label}" at ${best.coverPct.toFixed(1)}% over ${best.games} games. Worth watching as the season goes on, but with ${slices.length} slices, one is likely to look this good by chance alone, so it is not yet evidence.`
    : null;
  return { groups, verdict, caution, breakEven: BREAK_EVEN, gamesCovered: index.gamesCovered };
}
