// The Line check's flags: each stat on the card, as a one- or two-word flag
// on the side of the team it favors, with the numbers behind it. The 13
// counted stats are the same ones the Insights upset research tests, so a
// count on the card means the same thing as a count there.

import { SIGNALS } from "./predictors.mjs";

const COUNTED = new Set(SIGNALS.filter((s) => s.stat).map((s) => s.key));
export const COUNTED_TOTAL = COUNTED.size;
/** When this many counted stats favor the underdog, the upset research band applies. */
export const STACK_ALERT = 7;

const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const signed = (n) => `${n > 0 ? "+" : ""}${f1(n)}`;
const pct = (n) => `${f1(n)}%`;
const winPct = (form) => (form && form.wins + form.losses > 0 ? form.wins / (form.wins + form.losses) : null);
const lastTenWins = (form) => {
  const m = /^(\d+)-(\d+)/.exec(form?.lastTen ?? "");
  return m ? Number(m[1]) / (Number(m[1]) + Number(m[2])) : null;
};
const margin = (form) =>
  form?.avgPointsFor != null && form?.avgPointsAgainst != null ? form.avgPointsFor - form.avgPointsAgainst : null;

/** "home", "away", or null on a tie or missing number. */
function favored(h, a, lowerIsBetter = false) {
  if (h == null || a == null || !Number.isFinite(h) || !Number.isFinite(a) || h === a) return null;
  return (h > a) !== lowerIsBetter ? "home" : "away";
}

/**
 * Every flag for one game. `d` holds what the card already shows:
 * { away, home } each with { abbr, form, stats, rest, pair, replaced }.
 */
export function sideFlags(d) {
  const { away: A, home: H } = d;
  const both = (label, a, h) => `${label}: ${A.abbr} ${a}, ${H.abbr} ${h}.`;
  // League rank over the last 10 games, from the card's rank data.
  const rankLine = (key) =>
    A.rank?.[key] && H.rank?.[key]
      ? ` League rank: ${A.abbr} ${ordinal(A.rank[key])}, ${H.abbr} ${ordinal(H.rank[key])} of ${A.rank.of ?? 30}.`
      : "";
  const flags = [];
  const add = (key, label, side, detail) => side && flags.push({ key, label, side, detail, counted: COUNTED.has(key) });

  add("record", "Record", favored(winPct(H.form), winPct(A.form)),
    both("Record this season", `${A.form?.wins}-${A.form?.losses}`, `${H.form?.wins}-${H.form?.losses}`));
  add("seasonMargin", "Scoring margin", favored(margin(H.form), margin(A.form)),
    margin(A.form) != null && margin(H.form) != null
      ? `${both("Points for minus against per game, this season", signed(margin(A.form)), signed(margin(H.form)))} This is also why the Offense vs their defense row (in Full stats) projects one team to score more.`
      : "");
  add("lastRecord", "Recent form", favored(lastTenWins(H.form), lastTenWins(A.form)),
    both("Last 10 games", A.form?.lastTen, H.form?.lastTen));
  const s = (t, k) => t.stats?.[k];
  add("net", "Net rating", favored(s(H, "net"), s(A, "net")),
    `${both("Net rating, last 10", signed(s(A, "net") ?? 0), signed(s(H, "net") ?? 0))} Points per 100 possessions, scored minus allowed.`);
  add("offense", "Offense", favored(s(H, "ortg"), s(A, "ortg")),
    `${both("Points scored per 100 possessions, last 10", f1(s(A, "ortg") ?? 0), f1(s(H, "ortg") ?? 0))}${rankLine("off")}`);
  add("defense", "Defense", favored(s(H, "drtg"), s(A, "drtg"), true),
    `${both("Points allowed per 100 possessions, last 10", f1(s(A, "drtg") ?? 0), f1(s(H, "drtg") ?? 0))} Lower is better.${rankLine("def")}`);
  const shoot = (t) => (t.stats ? t.stats.efg - t.stats.efgAllowed : null);
  add("shooting", "Shooting", favored(shoot(H), shoot(A)),
    `${both("Effective field goal % for minus against, last 10", signed(shoot(A) ?? 0), signed(shoot(H) ?? 0))} Counts a 3 as worth 1.5 makes.`);
  add("rebounding", "Rebounding", favored(s(H, "trbPct"), s(A, "trbPct")),
    `${both("Share of all rebounds, last 10", pct(s(A, "trbPct") ?? 0), pct(s(H, "trbPct") ?? 0))}${rankLine("reb")}`);
  const tov = (t) => (t.stats ? t.stats.tovForcedPct - t.stats.tovPct : null);
  add("turnovers", "Turnovers", favored(tov(H), tov(A)),
    `${both("Turnovers forced minus committed, per 100 possessions, last 10", signed(tov(A) ?? 0), signed(tov(H) ?? 0))}`);
  add("threes", "3-point %", favored(s(H, "tpPct"), s(A, "tpPct")),
    `${both("3-point %, last 10", pct(s(A, "tpPct") ?? 0), pct(s(H, "tpPct") ?? 0))}${rankLine("three")}`);
  add("cohesion", "Cohesion", favored(H.pair, A.pair),
    `${both("Average pair, starts together", A.pair, H.pair)} How long each projected five has played together.${d.cohesionNote ? ` ${d.cohesionNote}` : ""}`);
  add("lineup", "Healthier", favored(H.replaced, A.replaced, true),
    `${both("Usual starters out and replaced tonight", A.replaced, H.replaced)}`);
  const b2b = (t) => t.rest?.backToBack === true;
  add("rest", "Rested", b2b(H) === b2b(A) ? null : b2b(H) ? "away" : "home",
    `${b2b(H) ? H.abbr : A.abbr} is on the second night of a back-to-back. ${b2b(H) ? A.abbr : H.abbr} is not.`);
  add("home", "Home court", "home", `${H.abbr} plays at home. Not counted with the stats: home court is already in every spread.`);
  return flags;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/**
 * Order flags by how well each signal picked winners in the research,
 * strongest first, and mark the weak ones: below 58% at picking winners
 * and no lean toward upsets. Follows the data, so the groups update as the
 * season goes on. Flags the research does not cover stay strong.
 */
export const WEAK_BELOW = 58;
export function rankFlags(flags, study) {
  const won = (key) => study?.winners?.find((s) => s.key === key)?.wonPct;
  const z = (key) => study?.upsetSignals?.find((s) => s.key === key)?.z;
  return flags
    .map((f) => {
      const w = won(f.key);
      return { ...f, strength: w ?? 100, weak: w != null && w < WEAK_BELOW && !((z(f.key) ?? 0) >= 1) };
    })
    .sort((a, b) => b.strength - a.strength);
}

/** Add what the upset research found for flags that back the underdog. */
export function withHistory(flags, underdog, study) {
  return flags.map((f) => {
    const h = f.side === underdog ? study?.upsetSignals?.find((x) => x.key === f.key) : null;
    return h?.games
      ? { ...f, detail: `${f.detail} When this favored the underdog in past games, the underdog won ${h.wonPct.toFixed(0)}% of ${h.games}, against ${h.usualPct.toFixed(0)}% usual at those spreads (${h.standing.toLowerCase()}).` }
      : f;
  });
}

/**
 * The Upset Alert: raised when the stats pick the market's underdog to
 * win, or when at least STACK_ALERT of the counted stats favor it. Returns
 * null when neither holds. Each reason carries what past games showed.
 */
export function upsetAlert({ flags, statsHome, marketHome, abbr, study }) {
  if (!marketHome) return null;
  const dog = marketHome > 0 ? "away" : "home";
  const fav = dog === "home" ? "away" : "home";
  const reasons = [];
  const usual = (t) =>
    t?.games ? ` In past games like that, the underdog won ${t.wonPct.toFixed(0)}% of ${t.games}, against ${t.usualPct.toFixed(0)}% usual at those spreads (${t.standing.toLowerCase()}).` : "";
  if (statsHome && (statsHome > 0 ? "home" : "away") === dog) {
    reasons.push(`The stats pick ${abbr[dog]} to win, but the market makes ${abbr[dog]} the underdog against ${abbr[fav]}.${usual(study?.lineCheckUpsets?.dog)}`);
  }
  const backing = flags.filter((f) => f.counted && f.side === dog).length;
  const counted = COUNTED.size;
  if (backing >= STACK_ALERT) {
    reasons.push(`${backing} of the ${counted} counted stats favor ${abbr[dog]}, the underdog.${usual(study?.stack?.at(-1))}`);
  }
  return reasons.length ? { team: abbr[dog], reasons } : null;
}
