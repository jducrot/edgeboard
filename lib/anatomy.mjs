// Anatomy of an upset: what underdogs actually did in the games they won,
// from lineup history's box scores. Descriptive, not predictive: it shows
// why upsets happened, which mostly cannot be seen before tip-off.

import { historyDb, historyVersion, currentSeasonYear } from "./history.mjs";
import { teamTotals } from "./teamstats.mjs";
import { getGameSummary } from "./espn.mjs";

const poss = (t) => t.fga - t.orb + t.tov + 0.44 * t.fta;
const efg = (t) => (100 * (t.fgm + 0.5 * t.tpm)) / t.fga;
const tp = (t) => (t.tpa ? (100 * t.tpm) / t.tpa : null);
const MIN_TPA = 150; // 3-point attempts before a season average counts

/** One game's shooting against each team's own season average before it. */
export function shootingVsUsual(dog, fav, dogBefore, favBefore) {
  const avg = (s) => (s && s.tpa >= MIN_TPA ? (100 * s.tpm) / s.tpa : null);
  const dogAvg = avg(dogBefore);
  const favAvg = avg(favBefore);
  return {
    dogTp: tp(dog),
    favTp: tp(fav),
    dogAvg,
    favAvg,
    dogDelta: dogAvg == null || tp(dog) == null ? null : tp(dog) - dogAvg,
    favDelta: favAvg == null || tp(fav) == null ? null : tp(fav) - favAvg,
    dogEfg: efg(dog),
    favEfg: efg(fav),
  };
}

/** The finished-card line for an upset: was it a shooting night? */
export function shootingNightLine({ dogAbbr, favAbbr, s }) {
  if (!s || s.dogDelta == null || s.favDelta == null) return null;
  const n = (x) => Math.round(x);
  const dir = (d) => (d >= 0 ? "above" : "below");
  // 3 points either way from a team's own average counts as a shooting night.
  const hot = s.dogDelta >= 3;
  const cold = s.favDelta <= -3;
  const whose = hot && cold ? "A shooting night at both ends" : hot ? `${dogAbbr}'s hot shooting night` : cold ? `${favAbbr}'s cold shooting night` : null;
  return [
    `Shooting: ${dogAbbr} made ${n(s.dogTp)}% of its 3s, ${n(Math.abs(s.dogDelta))} points ${dir(s.dogDelta)} its season average of ${n(s.dogAvg)}%. ${favAbbr} made ${n(s.favTp)}%, ${n(Math.abs(s.favDelta))} points ${dir(s.favDelta)} its usual ${n(s.favAvg)}%.`,
    whose
      ? `${whose} decided it, which is how most upsets happen, and no pregame stat can see it coming.`
      : "This upset was not a shooting night, so look at turnovers and rebounds in the factors above.",
  ];
}

let cached = null;

/** How underdogs won, across every game in lineup history with a line. */
export function upsetAnatomy() {
  const version = historyVersion();
  if (cached?.version === version) return cached.result;
  const d = historyDb();
  const games = d
    .prepare("SELECT * FROM games WHERE home_line IS NOT NULL AND home_line != 0 AND box_done = 1 ORDER BY date_utc")
    .all();
  const box = new Map();
  for (const b of d.prepare("SELECT * FROM team_box").iterate()) {
    if (!box.has(b.event_id)) box.set(b.event_id, {});
    box.get(b.event_id)[b.team_id] = b;
  }
  const season = new Map(); // "<season>|<team>" -> { tpm, tpa } before each game
  const rows = [];
  for (const g of games) {
    const fav = g.home_line > 0 ? g.home_id : g.away_id;
    const dog = fav === g.home_id ? g.away_id : g.home_id;
    const b = box.get(g.event_id);
    if (b?.[fav] && b?.[dog] && b[fav].fga && b[dog].fga) {
      const D = b[dog];
      const F = b[fav];
      rows.push({
        won: D.pts > F.pts,
        margin: D.pts - F.pts,
        spread: Math.abs(g.home_line),
        shot: efg(D) > efg(F),
        threes: tp(D) > tp(F),
        tov: D.tov / poss(D) < F.tov / poss(F),
        orb: D.orb / (D.orb + F.drb) > F.orb / (F.orb + D.drb),
        reb: D.orb + D.drb > F.orb + F.drb,
        fta: D.fta > F.fta,
        s: shootingVsUsual(D, F, season.get(`${g.season}|${dog}`), season.get(`${g.season}|${fav}`)),
      });
      for (const t of [g.home_id, g.away_id]) {
        const k = `${g.season}|${t}`;
        const s = season.get(k) ?? { tpm: 0, tpa: 0 };
        season.set(k, { tpm: s.tpm + b[t].tpm, tpa: s.tpa + b[t].tpa });
      }
    }
  }
  cached = { version, result: summarize(rows) };
  return cached.result;
}

/** The anatomy from per-game rows. Exported for tests. */
export function summarize(rows) {
  const up = rows.filter((r) => r.won);
  const lost = rows.filter((r) => !r.won);
  const pct = (xs, f) => (xs.length ? (100 * xs.filter(f).length) / xs.length : null);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const battle = (label, key) => {
    const won = rows.filter((r) => r[key]);
    return { label, inUpsets: pct(up, (r) => r[key]), inLosses: pct(lost, (r) => r[key]), winWhenWon: pct(won, (r) => r.won) };
  };
  const hasDelta = (r) => r.s.dogDelta != null && r.s.favDelta != null;
  const swing = (r) => r.s.dogDelta > 0 && r.s.favDelta < 0;
  const noShot = up.filter((r) => !r.shot);
  return {
    games: rows.length,
    upsets: up.length,
    battles: [
      battle("Out-shot the favorite (effective field goal %)", "shot"),
      battle("Better 3-point %", "threes"),
      battle("More total rebounds", "reb"),
      battle("Better offensive rebounding", "orb"),
      battle("Fewer turnovers", "tov"),
      battle("More free throws", "fta"),
    ],
    dogAboveUsual: avg(up.filter(hasDelta).map((r) => r.s.dogDelta)),
    favBelowUsual: avg(up.filter(hasDelta).map((r) => r.s.favDelta)),
    swingInUpsets: pct(up.filter(hasDelta), swing),
    swingInLosses: pct(lost.filter(hasDelta), swing),
    withoutShooting: noShot.length,
    withoutShootingTov: pct(noShot, (r) => r.tov),
    withoutShootingOrb: pct(noShot, (r) => r.orb),
    closeWithin5: pct(up, (r) => r.margin <= 5),
    closeWithin10: pct(up, (r) => r.margin <= 10),
    under7: pct(up, (r) => r.spread < 7),
  };
}

/** A team's 3-point makes and attempts this season, before a given game. */
function threesBefore(teamId, dateUtc) {
  return historyDb()
    .prepare(
      `SELECT COALESCE(SUM(tb.tpm), 0) AS tpm, COALESCE(SUM(tb.tpa), 0) AS tpa
       FROM team_box tb JOIN games g ON g.event_id = tb.event_id
       WHERE tb.team_id = ? AND g.season = ? AND g.date_utc < ?`,
    )
    .get(String(teamId), currentSeasonYear(new Date(dateUtc)), dateUtc);
}

/**
 * For a finished game the underdog won: the shooting-night line, or null.
 * `favorite` is "home" or "away" from the closing line.
 */
export async function upsetShootingLine(game, favorite) {
  if (!favorite) return null;
  const dogSide = favorite === "home" ? "away" : "home";
  if (game[dogSide].score == null || game[dogSide].score <= game[favorite].score) return null;
  const totals = teamTotals(await getGameSummary(game.id));
  const of = (side) => totals.find((t) => t.teamId === String(game[side].id));
  const D = of(dogSide);
  const F = of(favorite);
  if (!D || !F) return null;
  const s = shootingVsUsual(
    { ...D, tov: D.to },
    { ...F, tov: F.to },
    threesBefore(game[dogSide].id, game.dateUtc),
    threesBefore(game[favorite].id, game.dateUtc),
  );
  return shootingNightLine({ dogAbbr: game[dogSide].abbreviation, favAbbr: game[favorite].abbreviation, s });
}
