// Which signals on a game card have predicted the winner, and which have
// beaten the spread?
//
// Every stored game is scored using only games played before it, the way
// the card would have looked that day, so nothing here sees the future.
// Each signal picks a side by the same rule a reader of the card would use
// ("the team with the better last-10 net rating"), and we count how often
// that side won outright, won as the market's underdog, and covered.

import { historyDb, historyVersion, currentSeasonYear } from "./history.mjs";
import { evaluateWatch } from "./watchlist.mjs";
import { cohesionIndex } from "./cohesion.mjs";

export const BREAK_EVEN = 52.38; // Win rate needed to profit at standard -110 pricing.
const MIN_GAMES = 10; // Games a team must have played this season to be scored.
const LAST = 10;

// The Line check's own constants (lib/linecheck.mjs).
const HOME_COURT = 2.5;
const B2B_PENALTY = 2;
const FRESH_KEY_ABSENCE = 3;
const MAX_ABSENCE_ADJ = 6;

/** 95% Wilson interval for a proportion, in percent. */
export function wilson(successes, n) {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [100 * (center - half), 100 * (center + half)];
}

const etDay = (dateUtc) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(dateUtc),
  );
const dayNumber = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Last-10 box-score analytics, computed the way lib/teamstats.mjs does. */
function analytics(past) {
  const withBox = past.filter((g) => g.my && g.opp);
  if (withBox.length < 5) return null;
  const my = {};
  const opp = {};
  for (const g of withBox) {
    for (const k of Object.keys(g.my)) my[k] = (my[k] ?? 0) + g.my[k];
    for (const k of Object.keys(g.opp)) opp[k] = (opp[k] ?? 0) + g.opp[k];
  }
  const poss = (t) => t.fga - t.orb + t.tov + 0.44 * t.fta;
  const myPoss = poss(my);
  const oppPoss = poss(opp);
  if (myPoss <= 0 || oppPoss <= 0 || my.fga <= 0 || opp.fga <= 0) return null;
  const ortg = (my.pts / myPoss) * 100;
  const drtg = (opp.pts / oppPoss) * 100;
  return {
    ortg,
    drtg,
    net: ortg - drtg,
    pace: (myPoss + oppPoss) / 2 / withBox.length,
    efgMargin: (100 * (my.fgm + 0.5 * my.tpm)) / my.fga - (100 * (opp.fgm + 0.5 * opp.tpm)) / opp.fga,
    tovMargin: (100 * opp.tov) / oppPoss - (100 * my.tov) / myPoss,
    trbPct: (100 * (my.orb + my.drb)) / (my.orb + my.drb + opp.orb + opp.drb),
    tpPct: my.tpa > 0 ? (100 * my.tpm) / my.tpa : null,
  };
}

/** The five players with the most starts in the last 10 games. */
function regularStarters(past) {
  const starts = new Map();
  past.forEach((g, i) => {
    for (const id of g.starters ?? []) {
      const s = starts.get(id) ?? { n: 0, last: -1 };
      starts.set(id, { n: s.n + 1, last: i });
    }
  });
  return [...starts.entries()]
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .slice(0, 5)
    .map(([id]) => id);
}

/**
 * Watch-list measures for one team before a game: schedule, recent
 * results, streaks, results against the spread, venue record, earlier
 * meetings. Built from earlier games only. Null before 10 games.
 */
export function watchView(history, game, opp, isHome) {
  if (history.length < MIN_GAMES) return null;
  const day = dayNumber(game.etDay);
  const last = history.at(-1);
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].won === last.won; i--) streak++;
  const lined = history.filter((g) => g.ats != null).slice(-LAST);
  const venue = history.filter((g) => g.home === isHome);
  const meetings = history.filter((g) => g.oppId === opp);
  return {
    gamesLast3Days: history.filter((g) => day - dayNumber(g.etDay) <= 3).length,
    gamesLast5Days: history.filter((g) => day - dayNumber(g.etDay) <= 5).length,
    prevMargin: last.margin,
    streak: last.won ? streak : -streak,
    coverRate: lined.length >= 6 ? lined.filter((g) => g.ats > 0).length / lined.length : null,
    venueWinPct: venue.length >= 5 ? venue.filter((g) => g.won).length / venue.length : null,
    meetingMargin: meetings.length ? avg(meetings.map((g) => g.margin)) : null,
    surge: avg(history.slice(-LAST).map((g) => g.margin)) - avg(history.map((g) => g.margin)),
  };
}

/** What the card would have shown for one team before a game. */
function teamView(history, game, starters, opp, isHome) {
  if (history.length < MIN_GAMES) return null;
  const last = history.slice(-LAST);
  const wins = (gs) => gs.filter((g) => g.won).length;
  const regulars = regularStarters(last);
  const now = new Set(starters ?? []);
  const lineupKnown = now.size === 5;
  const missing = lineupKnown ? regulars.filter((id) => !now.has(id)) : null;
  const prev = new Set(history.at(-1).starters ?? []);
  return {
    seasonWinPct: wins(history) / history.length,
    seasonMargin: avg(history.map((g) => g.margin)),
    lastWinPct: wins(last) / last.length,
    lastMargin: avg(last.map((g) => g.margin)),
    stats: analytics(last),
    restDays: dayNumber(game.etDay) - dayNumber(history.at(-1).etDay) - 1,
    missingRegulars: missing ? missing.length : null,
    // Newly out: a regular who started the previous game but not this one.
    freshMissing: missing ? missing.filter((id) => prev.has(id)).length : null,
    watch: watchView(history, game, opp, isHome),
  };
}

/**
 * Score every game from earlier games only. `games` must be in date order.
 * boxes: Map eventId -> Map teamId -> totals. starters: Map eventId -> Map
 * teamId -> athlete ids. cohesion: Map eventId -> { homePair, awayPair }.
 */
export function scoreGames(games, { boxes = new Map(), starters = new Map(), cohesion = new Map() } = {}) {
  const seasons = new Map(); // "<season>|<team>" -> past games this season
  const rows = [];
  for (const raw of games) {
    const g = { ...raw, etDay: etDay(raw.dateUtc) };
    const past = (team) => seasons.get(`${g.season}|${team}`) ?? [];
    const lineup = starters.get(g.eventId);
    const home = teamView(past(g.homeId), g, lineup?.get(g.homeId), g.awayId, true);
    const away = teamView(past(g.awayId), g, lineup?.get(g.awayId), g.homeId, false);
    if (home && away) {
      rows.push({
        eventId: g.eventId,
        season: g.season,
        homeMargin: g.homeScore - g.awayScore,
        homeLine: g.homeLine,
        home,
        away,
        cohesion: cohesion.get(g.eventId) ?? null,
      });
    }
    // Only now does this game join the history.
    const box = boxes.get(g.eventId);
    for (const [team, other, margin] of [
      [g.homeId, g.awayId, g.homeScore - g.awayScore],
      [g.awayId, g.homeId, g.awayScore - g.homeScore],
    ]) {
      const key = `${g.season}|${team}`;
      if (!seasons.has(key)) seasons.set(key, []);
      seasons.get(key).push({
        etDay: g.etDay,
        won: margin > 0,
        margin,
        my: box?.get(team) ?? null,
        opp: box?.get(other) ?? null,
        starters: lineup?.get(team) ?? null,
        home: team === g.homeId,
        oppId: other,
        // Margin against the spread, from this team's side.
        ats: g.homeLine == null ? null : team === g.homeId ? margin - g.homeLine : margin + g.homeLine,
      });
    }
  }
  // Each team's games so far, for measuring upcoming games the same way.
  rows.histories = seasons;
  return rows;
}

/** The Line check's stats margin, home perspective, as the card would compute it. */
export function statsMargin(row) {
  const { home, away } = row;
  let base;
  if (home.stats && away.stats) {
    const pace = (home.stats.pace + away.stats.pace) / 2;
    base = ((home.stats.net - away.stats.net) * pace) / 100;
  } else {
    base = home.seasonMargin - away.seasonMargin;
  }
  let m = base + HOME_COURT;
  if (home.restDays === 0 && away.restDays !== 0) m -= B2B_PENALTY;
  if (away.restDays === 0 && home.restDays !== 0) m += B2B_PENALTY;
  if (home.freshMissing) m -= Math.min(MAX_ABSENCE_ADJ, home.freshMissing * FRESH_KEY_ABSENCE);
  if (away.freshMissing) m += Math.min(MAX_ABSENCE_ADJ, away.freshMissing * FRESH_KEY_ABSENCE);
  return m;
}

/** Pick the side with the higher value, or null on a tie or missing data. */
const higher = (h, a) => (h == null || a == null || h === a ? null : h > a ? "home" : "away");
const lower = (h, a) => (h == null || a == null || h === a ? null : h < a ? "home" : "away");

/**
 * Each signal, the card row it lives on, and the side it picks. `stat`
 * marks the ones counted when stacking signals: stats a reader can find on
 * the card, not the market itself, home court, or the Line check (which is
 * built from several of them).
 */
export const SIGNALS = [
  { key: "market", label: "The market's favorite", where: "DraftKings: Expected margin", pick: (r) => (r.homeLine > 0 ? "home" : r.homeLine < 0 ? "away" : null) },
  { key: "lineCheck", label: "The Line check's stats estimate", where: 'Line check: the "Stats:" margin', group: true, pick: (r) => (statsMargin(r) > 0 ? "home" : statsMargin(r) < 0 ? "away" : null) },
  { key: "seasonMargin", stat: true, label: "Better scoring margin this season", where: "Offense vs their defense row (the team projected to score more)", pick: (r) => higher(r.home.seasonMargin, r.away.seasonMargin) },
  { key: "record", stat: true, label: "Better record this season", where: "Record row", pick: (r) => higher(r.home.seasonWinPct, r.away.seasonWinPct) },
  { key: "lastMargin", label: "Better scoring margin, last 10", where: "Not on the card yet. Closest: Last 10 analytics: Net rating (per 100)", pick: (r) => higher(r.home.lastMargin, r.away.lastMargin) },
  { key: "net", stat: true, label: "Better net rating, last 10", where: "Last 10 analytics: Net rating (per 100)", pick: (r) => higher(r.home.stats?.net, r.away.stats?.net) },
  { key: "offense", stat: true, label: "Better offense, last 10", where: "League rank: Offense (points per 100)", pick: (r) => higher(r.home.stats?.ortg, r.away.stats?.ortg) },
  { key: "defense", stat: true, label: "Better defense, last 10", where: "League rank: Defense (points allowed per 100)", pick: (r) => lower(r.home.stats?.drtg, r.away.stats?.drtg) },
  { key: "shooting", stat: true, label: "Better shooting margin, last 10", where: "Last 10 analytics: eFG% for / against", pick: (r) => higher(r.home.stats?.efgMargin, r.away.stats?.efgMargin) },
  { key: "lastRecord", stat: true, label: "Better record, last 10", where: "Last 10 / streak row", pick: (r) => higher(r.home.lastWinPct, r.away.lastWinPct) },
  { key: "rebounding", stat: true, label: "Bigger share of rebounds, last 10", where: "League rank: Rebounding (share of all boards)", pick: (r) => higher(r.home.stats?.trbPct, r.away.stats?.trbPct) },
  { key: "turnovers", stat: true, label: "Better turnover margin, last 10", where: "Last 10 analytics: Turnover battle (%)", pick: (r) => higher(r.home.stats?.tovMargin, r.away.stats?.tovMargin) },
  { key: "cohesion", stat: true, label: "More cohesive starting five", where: "Cohesion: Average pair, starts together", pick: (r) => higher(r.cohesion?.homePair, r.cohesion?.awayPair) },
  { key: "lineup", stat: true, label: "Fewer regular starters missing", where: "Each team's starters and injuries", pick: (r) => lower(r.home.missingRegulars, r.away.missingRegulars) },
  { key: "threes", stat: true, label: "Better 3-point %, last 10", where: "League rank: 3-point shooting %", pick: (r) => higher(r.home.stats?.tpPct, r.away.stats?.tpPct) },
  { key: "home", label: "Home court", where: "The team listed second", pick: () => "home" },
  {
    key: "rest",
    stat: true,
    label: "Rested team against a team on a back-to-back",
    where: "Rest row",
    pick: (r) => (r.home.restDays === 0 && r.away.restDays !== 0 ? "away" : r.away.restDays === 0 && r.home.restDays !== 0 ? "home" : null),
  },
];

/** Outcome counts for a set of (row, picked side) pairs. */
export function tally(picks) {
  let won = 0;
  let dogGames = 0;
  let dogWon = 0;
  let atsGames = 0;
  let covered = 0;
  for (const { row, side } of picks) {
    const homeWon = row.homeMargin > 0;
    const sideWon = side === "home" ? homeWon : !homeWon;
    if (sideWon) won++;
    if (row.homeLine != null && row.homeLine !== 0) {
      const favorite = row.homeLine > 0 ? "home" : "away";
      if (side !== favorite) {
        dogGames++;
        if (sideWon) dogWon++;
      }
      const homeAts = row.homeMargin - row.homeLine;
      if (homeAts !== 0) {
        atsGames++;
        if ((homeAts > 0) === (side === "home")) covered++;
      }
    }
  }
  const pct = (a, b) => (b ? (100 * a) / b : null);
  const wr = wilson(won, picks.length);
  const ar = wilson(covered, atsGames);
  return {
    games: picks.length,
    wonPct: pct(won, picks.length),
    wonLow: wr?.[0] ?? null,
    wonHigh: wr?.[1] ?? null,
    dogGames,
    dogWonPct: pct(dogWon, dogGames),
    atsGames,
    atsPct: pct(covered, atsGames),
    atsLow: ar?.[0] ?? null,
    atsHigh: ar?.[1] ?? null,
  };
}

/* -------------------------------- upsets -------------------------------- */

const hasLine = (r) => r.homeLine != null && r.homeLine !== 0;
const underdogSide = (r) => (r.homeLine > 0 ? "away" : "home");
const underdogWon = (r) => (r.homeLine > 0 ? r.homeMargin < 0 : r.homeMargin > 0);

/**
 * How often an underdog usually wins at a given spread, fitted to the
 * games themselves (a logistic curve on the spread's size). It is the yard
 * stick for upsets: small spreads produce far more of them, so a signal
 * must beat the usual rate at the spreads it backed, not the overall rate.
 */
export function underdogCurve(rows) {
  const games = rows.filter(hasLine);
  let a = 0;
  let b = 0;
  for (let i = 0; i < 50 && games.length; i++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of games) {
      const x = Math.abs(r.homeLine);
      const p = 1 / (1 + Math.exp(-(a + b * x)));
      const y = underdogWon(r) ? 1 : 0;
      const w = p * (1 - p);
      ga += y - p;
      gb += (y - p) * x;
      haa += w;
      hab += w * x;
      hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab;
    if (!det) break;
    a += (hbb * ga - hab * gb) / det;
    b += (haa * gb - hab * ga) / det;
  }
  return (spread) => 1 / (1 + Math.exp(-(a + b * Math.abs(spread))));
}

/** Plain words for how far a set of underdogs beat their usual rate. */
export function standing(z) {
  if (z >= 1.96) return "Clearly more than usual";
  if (z >= 1) return "More than usual, but could be chance";
  if (z > -1) return "About the usual rate";
  return "Fewer than usual";
}

/** Underdog results for a set of games, against the usual rate at their spreads. */
export function upsetTally(rows, usual) {
  const won = rows.filter(underdogWon).length;
  const expected = rows.reduce((t, r) => t + usual(r.homeLine), 0);
  const spread = Math.sqrt(rows.reduce((t, r) => t + usual(r.homeLine) * (1 - usual(r.homeLine)), 0));
  const ci = wilson(won, rows.length);
  const z = spread ? (won - expected) / spread : 0;
  return {
    games: rows.length,
    won,
    wonPct: rows.length ? (100 * won) / rows.length : null,
    wonLow: ci?.[0] ?? null,
    wonHigh: ci?.[1] ?? null,
    usualPct: rows.length ? (100 * expected) / rows.length : null,
    diff: rows.length ? (100 * (won - expected)) / rows.length : null,
    z,
    standing: standing(z),
  };
}

/** Everything the Insights page reports, from scored games. */
export function evaluate(rows) {
  // How often each signal picked the winner, for reference.
  const winners = SIGNALS.map((s) => {
    const picks = [];
    for (const row of rows) {
      const side = s.pick(row);
      if (side) picks.push({ row, side });
    }
    return { key: s.key, label: s.label, where: s.where, group: Boolean(s.group), ...tally(picks) };
  }).sort((a, b) => (b.wonPct ?? 0) - (a.wonPct ?? 0));

  const withLine = rows.filter(hasLine);
  const usual = underdogCurve(withLine);
  const totalUpsets = withLine.filter(underdogWon).length;

  // Each signal when it backed the underdog.
  const upsetSignals = SIGNALS.filter((s) => s.key !== "market")
    .map((s) => {
      const backed = withLine.filter((r) => s.pick(r) === underdogSide(r));
      return { key: s.key, label: s.label, where: s.where, group: Boolean(s.group), ...upsetTally(backed, usual) };
    })
    .filter((s) => s.games > 0)
    .sort((a, b) => b.z - a.z);

  // Stacking: how many of the card's stats backed the underdog.
  const stats = SIGNALS.filter((s) => s.stat);
  const backing = (r) => stats.filter((s) => s.pick(r) === underdogSide(r)).length;
  const stackBands = [
    { label: "None", lo: 0, hi: 0 },
    { label: "1 to 3", lo: 1, hi: 3 },
    { label: "4 to 6", lo: 4, hi: 6 },
    { label: "7 or more", lo: 7, hi: stats.length },
  ];
  const stack = stackBands.map((b) => ({
    label: b.label,
    ...upsetTally(withLine.filter((r) => backing(r) >= b.lo && backing(r) <= b.hi), usual),
  }));

  // How often underdogs won, by the size of the spread.
  const bySpread = [
    { label: "Under 3.5 points", lo: 0, hi: 3.5 },
    { label: "3.5 to 6.5 points", lo: 3.5, hi: 7 },
    { label: "7 to 9.5 points", lo: 7, hi: 10 },
    { label: "10 points or more", lo: 10, hi: Infinity },
  ].map((b) => {
    const g = withLine.filter((r) => Math.abs(r.homeLine) >= b.lo && Math.abs(r.homeLine) < b.hi);
    const won = g.filter(underdogWon).length;
    return { label: b.label, games: g.length, wonPct: g.length ? (100 * won) / g.length : null };
  });

  // The Line check: when its stats margin backed the underdog, and when it
  // backed the favorite.
  const statsBackDog = (r) => (statsMargin(r) > 0 ? "home" : "away") === underdogSide(r);
  const lineCheckUpsets = {
    dog: upsetTally(withLine.filter(statsBackDog), usual),
    favorite: upsetTally(withLine.filter((r) => !statsBackDog(r)), usual),
  };

  // The Line check's verdict bands, against the spread, as the card words them.
  const band = (lo, hi) =>
    withLine.filter((r) => {
      const gap = Math.abs(statsMargin(r) - r.homeLine);
      return gap >= lo && gap < hi;
    });
  const statsSide = (r) => (statsMargin(r) - r.homeLine > 0 ? "home" : "away");
  const lineCheck = [
    { label: "In line with the stats (under 3 points apart)", rows: band(0, 3) },
    { label: "Stats mildly disagree (3 to 6 points)", rows: band(3, 6) },
    { label: "Stats strongly disagree (6 points or more)", rows: band(6, Infinity) },
  ].map((b) => ({ label: b.label, ats: tally(b.rows.map((row) => ({ row, side: statsSide(row) }))) }));

  return {
    games: rows.length,
    lineGames: withLine.length,
    totalUpsets,
    upsetPct: withLine.length ? (100 * totalUpsets) / withLine.length : null,
    usualAt: (spread) => 100 * usual(spread),
    statCount: stats.length,
    winners,
    upsetSignals,
    stack,
    bySpread,
    lineCheckUpsets,
    lineCheck,
  };
}

/** Plain-English findings about upsets, from the results, so the text never goes stale. */
export function verdicts(result) {
  const f = (n) => `${n.toFixed(1)}%`;
  const lines = [];
  const close = result.bySpread[0];
  const long = result.bySpread.at(-1);
  lines.push(
    `Underdogs won ${f(result.upsetPct)} of ${result.lineGames.toLocaleString("en-US")} games. How big the spread is matters most: underdogs won ${f(close.wonPct)} when it was ${close.label.toLowerCase()}, and ${f(long.wonPct)} at ${long.label.toLowerCase()}. So every signal below is compared with how often underdogs usually win at the spreads it backed.`,
  );
  // One rule for the words, shared with the table: standing().
  const isNow = (label) => (s) => s.games >= 50 && standing(s.z) === label;
  const clear = result.upsetSignals.filter(isNow("Clearly more than usual"));
  const maybe = result.upsetSignals.filter(isNow("More than usual, but could be chance"));
  const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const howMany = (n) => words[n] ?? String(n);
  if (clear.length) {
    lines.push(
      `Clearly more upsets than usual: ${clear.map((s) => `"${s.label}" (its underdogs won ${f(s.wonPct)} of ${s.games}, against ${f(s.usualPct)} usual)`).join(", and ")}. With ${result.upsetSignals.length} signals tested, one can clear this bar by luck, so watch whether it holds as games are added.`,
    );
  } else {
    lines.push("No single signal's underdogs have won clearly more often than usual yet.");
  }
  if (maybe.length) {
    const diffs = maybe.map((s) => s.diff);
    const top = maybe[0];
    lines.push(
      `${howMany(maybe.length)} ${maybe.length === 1 ? "signal leans" : "signals lean"} that way: their underdogs won ${Math.min(...diffs).toFixed(1)} to ${Math.max(...diffs).toFixed(1)} points more often than usual, which chance alone could still produce. The strongest lean is "${top.label}": its underdogs won ${f(top.wonPct)} of ${top.games}, against ${f(top.usualPct)} usual. Most of these measure the same thing, which team has been better lately, so they tend to back the same underdogs and are not separate pieces of evidence.`,
    );
  }
  const stacked = result.stack.at(-1);
  const none = result.stack[0];
  if (stacked.games && none.games) {
    lines.push(
      `Counting the card's ${result.statCount} stats together: when ${stacked.label.toLowerCase()} backed the underdog, it won ${f(stacked.wonPct)} of ${stacked.games} games (${f(stacked.usualPct)} usual). When none did, it won only ${f(none.wonPct)} of ${none.games} (${f(none.usualPct)} usual), so those were the games where the favorite was safest.`,
    );
  }
  const flat = result.upsetSignals.filter(isNow("About the usual rate"));
  if (flat.length) {
    lines.push(`No help at all for spotting upsets so far: ${flat.map((s) => `"${s.label}"`).join(", ")}. Their underdogs won about as often as any underdog at the same spread.`);
  }
  return lines;
}

/**
 * One line for a card's Line check: did the stats back the underdog or the
 * favorite, and how did underdogs do in past games like that?
 */
export function lineCheckNote(study, statsHome, marketHome) {
  if (!study || !statsHome || !marketHome) return null;
  const backsDog = statsHome > 0 !== marketHome > 0;
  const t = backsDog ? study.lineCheckUpsets.dog : study.lineCheckUpsets.favorite;
  if (!t?.games) return null;
  const won = `${t.wonPct.toFixed(0)}%`;
  const usualPct = `${t.usualPct.toFixed(0)}%`;
  return backsDog
    ? `The stats back the underdog here. In past games like that, the underdog won ${won} of ${t.games}, against ${usualPct} usual at those spreads.`
    : `The stats back the favorite here. In past games like that, the underdog won ${won} of ${t.games}, against ${usualPct} usual at those spreads.`;
}

let cached = null;

/** The study over everything in lineup history, rebuilt when history changes. */
export function predictorStudy() {
  const version = historyVersion();
  if (cached?.version === version) return cached.result;
  const d = historyDb();
  const games = d
    .prepare(
      `SELECT event_id AS eventId, season, date_utc AS dateUtc, home_id AS homeId, away_id AS awayId,
              home_score AS homeScore, away_score AS awayScore, home_line AS homeLine
       FROM games ORDER BY date_utc`,
    )
    .all();
  const boxes = new Map();
  for (const b of d.prepare("SELECT * FROM team_box").iterate()) {
    if (!boxes.has(b.event_id)) boxes.set(b.event_id, new Map());
    boxes.get(b.event_id).set(b.team_id, {
      pts: b.pts, fgm: b.fgm, fga: b.fga, tpm: b.tpm, tpa: b.tpa, fta: b.fta, orb: b.orb, drb: b.drb, tov: b.tov,
    });
  }
  const starters = new Map();
  for (const a of d.prepare("SELECT event_id, team_id, athlete_id FROM appearances WHERE started = 1").iterate()) {
    if (!starters.has(a.event_id)) starters.set(a.event_id, new Map());
    const m = starters.get(a.event_id);
    if (!m.has(a.team_id)) m.set(a.team_id, []);
    m.get(a.team_id).push(a.athlete_id);
  }
  const cohesion = new Map(cohesionIndex().backtest.map((b) => [b.eventId, { homePair: b.homePair, awayPair: b.awayPair }]));
  const rows = scoreGames(games, { boxes, starters, cohesion });
  const result = evaluate(rows);
  result.watch = evaluateWatch(rows);
  // Watch-list measures for an upcoming game, from this season's games.
  result.watchNow = ({ homeId, awayId, dateUtc }) => {
    const season = currentSeasonYear(new Date(dateUtc));
    const game = { etDay: etDay(dateUtc) };
    const past = (team) => rows.histories.get(`${season}|${team}`) ?? [];
    return {
      home: watchView(past(homeId), game, awayId, true),
      away: watchView(past(awayId), game, homeId, false),
    };
  };
  cached = { version, result };
  return result;
}
