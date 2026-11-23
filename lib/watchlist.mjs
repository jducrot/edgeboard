// The watch list: popular betting ideas tested the same honest way as the
// Insights research, but kept off the game cards until they earn a place.
// A signal earns it only by beating the market in each of the last two
// seasons on its own: its cover rate's whole likely range above 50%, or its
// underdogs winning clearly more often than usual at their spreads. Until
// then it is listed with plain words about where it stands.

import { tally, upsetTally, underdogCurve } from "./predictors.mjs";

const MIN_ATS = 50; // games against the spread in a season to judge it
const MIN_DOGS = 30; // underdog games in a season to judge upsets

const w = (r, side) => r[side]?.watch;
/** The side a team-level test favors: true for home only, false for away only. */
const one = (h, a, backs) => (h === a ? null : h ? backs.home : backs.away);
const SELF = { home: "home", away: "away" };
const OTHER = { home: "away", away: "home" };
const cmp = (h, a) => (h == null || a == null || h === a ? null : h > a ? "home" : "away");

export const WATCH = [
  { key: "fatigue3in4", flag: "Fresher", name: "Opponent playing a 3rd game in 4 nights",
    pick: (r) => one(w(r, "home")?.gamesLast3Days >= 2, w(r, "away")?.gamesLast3Days >= 2, OTHER) },
  { key: "fatigue4in6", flag: "Lighter schedule", name: "Opponent playing a 4th game in 6 nights",
    pick: (r) => one(w(r, "home")?.gamesLast5Days >= 3, w(r, "away")?.gamesLast5Days >= 3, OTHER) },
  { key: "bounceBack", flag: "Bounce-back", name: "Lost its last game by 15 or more",
    pick: (r) => one(w(r, "home")?.prevMargin <= -15, w(r, "away")?.prevMargin <= -15, SELF) },
  { key: "afterRout", flag: "Rolling", name: "Won its last game by 15 or more",
    pick: (r) => one(w(r, "home")?.prevMargin >= 15, w(r, "away")?.prevMargin >= 15, SELF) },
  { key: "losingStreak", flag: "Losing streak", name: "On a losing streak of 4 or more",
    pick: (r) => one(w(r, "home")?.streak <= -4, w(r, "away")?.streak <= -4, SELF) },
  { key: "winStreak", flag: "Win streak", name: "On a winning streak of 5 or more",
    pick: (r) => one(w(r, "home")?.streak >= 5, w(r, "away")?.streak >= 5, SELF) },
  { key: "coverForm", flag: "Covering", name: "Better record against the spread, last 10",
    pick: (r) => cmp(w(r, "home")?.coverRate, w(r, "away")?.coverRate) },
  { key: "venue", flag: "Venue record", name: "Better record at home (for the home team) or on the road (for the visitor)",
    pick: (r) => cmp(w(r, "home")?.venueWinPct, w(r, "away")?.venueWinPct) },
  { key: "meetings", flag: "Head to head", name: "Won the earlier meetings this season",
    pick: (r) => {
      const m = w(r, "home")?.meetingMargin;
      return m == null || m === 0 ? null : m > 0 ? "home" : "away";
    } },
  { key: "surge", flag: "Surging", name: "Playing 3 or more points per game above its season level, last 10",
    pick: (r) => {
      const h = w(r, "home")?.surge;
      const a = w(r, "away")?.surge;
      if (h == null || a == null || Math.abs(h - a) < 3) return null;
      return h > a ? "home" : "away";
    } },
  { key: "homeDog", flag: "Home underdog", name: "Home underdog",
    pick: (r) => (r.homeLine < 0 ? "home" : null) },
];

/** Does one season's result beat the market? */
export const beatsMarket = (s) =>
  (s.ats.atsGames >= MIN_ATS && s.ats.atsLow > 50) || (s.upset.games >= MIN_DOGS && s.upset.z >= 1.96);
const judged = (s) => s.ats.atsGames >= MIN_ATS || s.upset.games >= MIN_DOGS;

/** Plain words for where a signal stands, from its two seasons. */
export function watchStatus(last, current) {
  const a = beatsMarket(last);
  const b = beatsMarket(current);
  if (a && b) return { ready: true, text: "On the cards: beat the market in both seasons" };
  if (a && !judged(current)) return { ready: false, text: "Promising last season, too few games this season to tell" };
  if (a) return { ready: false, text: "Beat the market last season, not this season" };
  if (b) return { ready: false, text: "Promising this season only, not last season" };
  return { ready: false, text: "No edge so far: the market already prices it" };
}

const label = (season) => `${season - 1}-${String(season).slice(2)}`;

/** Every watch-list signal, measured separately in each of the last two seasons. */
export function evaluateWatch(rows) {
  const lined = rows.filter((r) => r.homeLine != null && r.homeLine !== 0);
  const seasons = [...new Set(lined.map((r) => r.season))].sort().slice(-2);
  if (seasons.length < 2) return { seasons: seasons.map(label), signals: [] };
  const usual = underdogCurve(lined);
  const dog = (r) => (r.homeLine > 0 ? "away" : "home");
  const signals = WATCH.map((s) => {
    const per = seasons.map((season) => {
      const picks = lined.filter((r) => r.season === season).map((row) => ({ row, side: s.pick(row) })).filter((p) => p.side);
      return {
        ats: tally(picks),
        upset: upsetTally(picks.filter((p) => p.side === dog(p.row)).map((p) => p.row), usual),
      };
    });
    return { key: s.key, flag: s.flag, name: s.name, last: per[0], current: per[1], ...watchStatus(per[0], per[1]) };
  });
  return { seasons: seasons.map(label), signals };
}

/**
 * Card flags for the watch-list signals that have earned a place, for one
 * upcoming game. `views` holds each team's watch measures, and `marketHome`
 * is the spread from the home side. Not counted with the 13 stats.
 */
export function watchFlags(watch, views, marketHome) {
  if (!watch?.signals?.length || !views?.home || !views?.away) return [];
  const row = { home: { watch: views.home }, away: { watch: views.away }, homeLine: marketHome };
  const pct = (n) => `${n.toFixed(0)}%`;
  return watch.signals
    .filter((s) => s.ready)
    .map((s) => {
      const def = WATCH.find((d) => d.key === s.key);
      const side = def?.pick(row);
      if (!side) return null;
      return {
        key: `watch:${s.key}`,
        label: s.flag,
        side,
        counted: false,
        detail: `${s.name}. From the watch list: teams in this spot covered ${pct(s.last.ats.atsPct)} in ${watch.seasons[0]} and ${pct(s.current.ats.atsPct)} in ${watch.seasons[1]}. Not counted with the 13 stats.`,
      };
    })
    .filter(Boolean);
}
