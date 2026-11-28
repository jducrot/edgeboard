// Builds the three slate days (yesterday, today, tomorrow) with everything
// the templates need precomputed, so the Nunjucks stays presentation-only.

import {
  getInjuriesByTeamId,
  getOdds,
  getRestByTeamId,
  getScoreboard,
  getTeamFormByTeamId,
  labelForYmd,
  picksOpen,
  slateDateEt,
} from "../../lib/espn.mjs";
import { listPredictions } from "../../lib/db.mjs";
import { playerImpact } from "../../lib/impact.mjs";
import { getGameRecap } from "../../lib/recap.mjs";
import { teamStarters } from "../../lib/starters.mjs";
import { reconcileStartersAndInjuries } from "../../lib/lineup.mjs";
import { compareToSnapshot } from "../../lib/changes.mjs";
import { cohesionIndex, lineupCohesion, cohesionBacktest, cohesionNote } from "../../lib/cohesion.mjs";
import { predictorStudy, lineCheckNote } from "../../lib/predictors.mjs";
import { minutesOut, minutesLine } from "../../lib/minutes.mjs";
import { sideFlags, withHistory, upsetAlert, rankFlags, COUNTED_TOTAL } from "../../lib/flags.mjs";
import { watchFlags } from "../../lib/watchlist.mjs";
import { upsetPotential } from "../../lib/potential.mjs";
import { upsetShootingLine } from "../../lib/anatomy.mjs";
import { lineCheck } from "../../lib/linecheck.mjs";
import { teamAnalytics } from "../../lib/teamstats.mjs";

function fmt(n, digits = 1) {
  return n === null || n === undefined ? "–" : Number(n).toFixed(digits);
}

/**
 * How this team's offense projects against tonight's defense. The lead
 * number is the opponent's defense relative to league average: positive
 * means an easier-than-normal night for the offense, negative a harder
 * one. The projection adds that to the team's own scoring average.
 */
function matchupCell(team, opponent, leagueAvgPA) {
  if (
    !team || !opponent ||
    team.avgPointsFor === null ||
    opponent.avgPointsAgainst === null ||
    leagueAvgPA === null
  ) {
    return "–";
  }
  const ease = opponent.avgPointsAgainst - leagueAvgPA;
  const proj = team.avgPointsFor + ease;
  const r = Math.round(ease * 10) / 10;
  const sign = r > 0 ? "+" : "";
  const word = r > 1 ? "easier" : r < -1 ? "tougher" : "neutral";
  return `${sign}${r} ${word} (proj ${fmt(proj)}, usual ${fmt(team.avgPointsFor)})`;
}

/** Rows for the last-10 analytics table; null when either side lacks data. */
function analyticsRows(away, home) {
  if (!away || !home) return null;
  const f1 = (n) => (n === null ? "–" : (Math.round(n * 10) / 10).toString());
  const signed = (n) => (n > 0 ? `+${f1(n)}` : f1(n));
  const rate = (n) => (n === null ? "–" : `.${Math.round(n * 100).toString().padStart(2, "0")}`);
  const cell = {
    net: (t) => `${signed(t.net)} (${f1(t.ortg)} off, ${f1(t.drtg)} def)`,
    pace: (t) => f1(t.pace),
    efg: (t) => `${f1(t.efg)} / ${f1(t.efgAllowed)}`,
    tov: (t) => `${signed(t.tovForcedPct - t.tovPct)} (forced ${f1(t.tovForcedPct)}, committed ${f1(t.tovPct)})`,
    orb: (t) => f1(t.orbPct),
    ft: (t) => `${rate(t.ftRate)} / ${rate(t.ftRateAllowed)}`,
    three: (t) => `${f1(t.tpaPerGame)} att at ${f1(t.tpPct)}%; opp ${f1(t.oppTpPct)}%`,
  };
  return [
    { label: "Net rating (per 100)", away: cell.net(away), home: cell.net(home) },
    { label: "Pace (possessions/game)", away: cell.pace(away), home: cell.pace(home) },
    { label: "eFG% for / against", away: cell.efg(away), home: cell.efg(home) },
    { label: "Turnover battle (%)", away: cell.tov(away), home: cell.tov(home) },
    { label: "Off. rebound %", away: cell.orb(away), home: cell.orb(home) },
    { label: "FT rate for / against", away: cell.ft(away), home: cell.ft(home) },
    { label: "3-point profile", away: cell.three(away), home: cell.three(home) },
  ];
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/**
 * Rank every team on last-10 offense, defense, rebounding, and
 * three-point shooting. Returns Map teamId -> { off, def, reb, three, of }.
 */
async function leagueRankings(teamIds) {
  const rows = (
    await Promise.all(
      teamIds.map(async (id) => ({ id, a: await teamAnalytics(id).catch(() => null) })),
    )
  ).filter((r) => r.a);
  const ranks = new Map(rows.map((r) => [r.id, { of: rows.length }]));
  const rankBy = (key, value, higherIsBetter) => {
    const sorted = [...rows]
      .filter((r) => r.a[value] !== null && Number.isFinite(r.a[value]))
      .sort((x, y) => (higherIsBetter ? y.a[value] - x.a[value] : x.a[value] - y.a[value]));
    sorted.forEach((r, i) => (ranks.get(r.id)[key] = i + 1));
  };
  rankBy("off", "ortg", true);
  rankBy("def", "drtg", false); // Fewer points allowed per 100 is better.
  rankBy("reb", "trbPct", true);
  rankBy("three", "tpPct", true);
  return ranks;
}

function rankRows(ranks, awayId, homeId) {
  const a = ranks.get(awayId);
  const h = ranks.get(homeId);
  if (!a || !h) return null;
  const cell = (r, key) => (r[key] ? ordinal(r[key]) : "–");
  return {
    of: a.of,
    rows: [
      { label: "Offense (points per 100)", away: cell(a, "off"), home: cell(h, "off") },
      { label: "Defense (points allowed per 100)", away: cell(a, "def"), home: cell(h, "def") },
      { label: "Rebounding (share of all boards)", away: cell(a, "reb"), home: cell(h, "reb") },
      { label: "3-point shooting %", away: cell(a, "three"), home: cell(h, "three") },
    ],
  };
}

/** Cohesion of each team's projected five, as table rows. */
/** Which side the closing line favored ("home", "away"), or null. */
async function closingFavorite(odds, g) {
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(odds?.details ?? "");
  if (!m) return null;
  return m[1] === g.home.abbreviation ? "home" : m[1] === g.away.abbreviation ? "away" : null;
}

/** The Line check laid out for scanning: alert, margins, flags by side, then detail. */
function lineCheckView(check, g, { form, rest, awayStats, homeStats, awayStarters, homeStarters, cohesion, study, cohesionStudy, ranks, odds }) {
  const pair = (team, starters) =>
    cohesion ? (lineupCohesion(cohesion, team.id, starters?.map((s) => s.id))?.pairAvg ?? null) : null;
  const side = (team, stats, starters) => ({
    abbr: team.abbreviation,
    form: form.get(team.id) ?? null,
    stats,
    rest: rest.get(team.id) ?? null,
    pair: pair(team, starters),
    replaced: starters ? starters.filter((s) => s.projected).length : null,
    rank: ranks?.get(team.id) ?? null,
  });
  const underdog = check.marketHome > 0 ? "away" : check.marketHome < 0 ? "home" : null;
  const flags = [
    ...withHistory(
      sideFlags({
        away: side(g.away, awayStats, awayStarters),
        home: side(g.home, homeStats, homeStarters),
        cohesionNote: (() => {
          const a = pair(g.away, awayStarters);
          const h = pair(g.home, homeStarters);
          return a != null && h != null
            ? cohesionNote(cohesionStudy, { abbr: g.away.abbreviation, pair: a }, { abbr: g.home.abbreviation, pair: h })
            : null;
        })(),
      }),
      underdog,
      study,
    ),
    // Watch-list ideas that have beaten the market in both seasons.
    ...(study?.watchNow
      ? watchFlags(study.watch, study.watchNow({ homeId: g.home.id, awayId: g.away.id, dateUtc: g.dateUtc }), check.marketHome)
      : []),
  ];
  const abbr = { away: g.away.abbreviation, home: g.home.abbreviation };
  const alert = upsetAlert({ flags, statsHome: check.statsHome, marketHome: check.marketHome, abbr, study });
  const ranked = rankFlags(flags, study);
  const column = (key, role) => ({
    abbr: abbr[key],
    role,
    underdog: underdog === key,
    flags: flags.filter((f) => f.side === key),
    strong: ranked.filter((f) => f.side === key && !f.weak),
    weak: ranked.filter((f) => f.side === key && f.weak),
    counted: flags.filter((f) => f.side === key && f.counted).length,
    total: COUNTED_TOTAL,
  });
  // The market's own chance for the underdog, with the bookmaker's cut removed.
  const pA = impliedProb(odds?.awayMoneyline);
  const pH = impliedProb(odds?.homeMoneyline);
  const marketDogPct =
    underdog && pA !== null && pH !== null && pA + pH > 0 ? (100 * (underdog === "away" ? pA : pH)) / (pA + pH) : null;
  const potential = underdog
    ? upsetPotential({
        study,
        spread: Math.abs(check.marketHome),
        statsPickDog: (check.statsHome > 0 ? "home" : "away") === underdog,
        backing: flags.filter((f) => f.counted && f.side === underdog).length,
        total: COUNTED_TOTAL,
        dog: abbr[underdog],
        fav: abbr[underdog === "home" ? "away" : "home"],
        marketDogPct,
      })
    : null;
  return {
    alert,
    potential,
    market: check.market,
    stats: check.stats,
    verdict: check.verdict,
    meaning: check.meaning,
    parts: check.parts,
    uncertain: check.uncertain,
    away: column("away", "away"),
    home: column("home", "home"),
    // With no alert, the history line still says how underdogs fared.
    history: alert ? null : lineCheckNote(study, check.statsHome, check.marketHome),
  };
}

function cohesionRows(index, g, awayStarters, homeStarters, study) {
  const a = lineupCohesion(index, g.away.id, awayStarters?.map((s) => s.id));
  const h = lineupCohesion(index, g.home.id, homeStarters?.map((s) => s.id));
  if (!a && !h) return null;
  const five = (c) => {
    if (!c) return "–";
    if (c.fiveAll === 0) return "First start together";
    return c.fiveThisSeason > 0 && c.fiveThisSeason !== c.fiveAll
      ? `${c.fiveAll} (${c.fiveThisSeason} this season)`
      : `${c.fiveAll}`;
  };
  return {
    note: a && h
      ? cohesionNote(study, { abbr: g.away.abbreviation, pair: a.pairAvg }, { abbr: g.home.abbreviation, pair: h.pairAvg })
      : null,
    typicalPair: index.typicalPair !== null ? Math.round(index.typicalPair) : null,
    rows: [
      { label: "This five, starts together", away: five(a), home: five(h) },
      { label: "Average pair, starts together", away: a ? `${a.pairAvg}` : "–", home: h ? `${h.pairAvg}` : "–" },
      {
        label: "Minutes from players here last season",
        away: a?.returningPct !== null && a ? `${a.returningPct}%` : "–",
        home: h?.returningPct !== null && h ? `${h.returningPct}%` : "–",
      },
    ],
  };
}

function fmtEt(isoUtc) {
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoUtc))} ET`;
}

/** "Your pick: <team> by <margin> because <reasoning>", as entered. */
/** "correct", "incorrect", or null while the game has no final score. */
function pickOutcome(pick, score) {
  if (!score || !(score.home.won || score.away.won)) return null;
  return score[pick].won ? "correct" : "incorrect";
}

function pickView(row, g) {
  const team = row.pick === "home" ? g.home.displayName : g.away.displayName;
  const reasoning = String(row.reasoning ?? "").trim();
  const ending = /[.!?]$/.test(reasoning) ? "" : ".";
  return {
    id: row.id,
    text: `${team}${row.predicted_margin !== null ? ` by ${row.predicted_margin}` : ""} because ${reasoning}${ending}`,
    savedNote: row.updated_at_utc
      ? `Updated ${fmtEt(row.updated_at_utc)}`
      : `Saved ${fmtEt(row.created_at_utc)}`,
    // Graded straight from the final score shown on the card.
    outcome: pickOutcome(row.pick, finalScore(g, g.statusState === "post")),
    pick: row.pick,
    margin: row.predicted_margin,
    confidence: row.confidence,
    reasoning,
  };
}

/** Mark, in words, each item on the card that changed since the pick. */
function markChanges(cmp, oddsView, sides) {
  for (const item of oddsView?.items ?? []) {
    if (cmp.marginWas && item.text.startsWith("Expected margin")) {
      item.changed = true;
      item.text += ` (changed since your pick, was ${cmp.marginWas})`;
    }
    if (cmp.winProbWas && item.text.startsWith("Win probability")) {
      item.changed = true;
      item.text += ` (changed since your pick, was ${cmp.winProbWas})`;
    }
  }
  for (const side of ["away", "home"]) {
    let changedCount = 0;
    for (const i of sides[side].inj?.all ?? []) {
      const note = cmp.injuryNotes.get(`${side}:${i.athleteId || i.athlete}`);
      if (note) {
        i.changedNote = note;
        changedCount++;
      }
    }
    if (sides[side].inj) sides[side].inj.changedCount = changedCount;
    for (const s of sides[side].starters ?? []) {
      if (cmp.newStarters.has(`${side}:${s.name}`)) {
        s.changedNote = "New in the projected lineup since your pick";
      }
      const note = cmp.injuryNotes.get(`${side}:${s.id}`) ?? cmp.injuryNotes.get(`${side}:${s.name}`);
      if (note) s.changedNote = note;
    }
  }
}

function restLabel(rest) {
  if (!rest) return "4+ days rest";
  if (rest.backToBack) return "Back-to-back (0 days rest)";
  if (rest.daysOfRest === 1) return "1 day rest";
  return `${rest.daysOfRest} days rest`;
}

/** American moneyline -> implied probability (0..1), before devigging. */
function impliedProb(ml) {
  if (ml === null || !Number.isFinite(ml)) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

/** Pregame line restated against the final score, in past tense. */
function finalOddsLine(odds, game) {
  const hs = game.home.score;
  const as = game.away.score;
  if (hs === null || as === null) return null;
  const winner = hs > as ? game.home : game.away;
  const loser = hs > as ? game.away : game.home;
  const margin = Math.abs(hs - as);
  const sentences = [];

  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(odds.details ?? "");
  if (m) {
    const fav = m[1];
    const num = Number(m[2]);
    if (winner.abbreviation === fav) {
      const res =
        margin > num ? "covered" : margin === num ? "a push against the spread" : "won but did not cover";
      sentences.push(`${fav} closed as ${num}-point favorites and won by ${margin}: ${res}`);
    } else {
      sentences.push(
        `${fav} closed as ${num}-point favorites and lost by ${margin}: an upset, and ${winner.abbreviation} covered`,
      );
    }
  }

  if (odds.overUnder !== null) {
    const combined = hs + as;
    const diff = Math.round((combined - odds.overUnder) * 10) / 10;
    const res =
      diff > 0 ? `over by ${diff}` : diff < 0 ? `under by ${-diff}` : "a push";
    sentences.push(`Total ${odds.overUnder}: they scored ${combined}, ${res}`);
  }

  if (sentences.length === 0) return null;
  return { provider: odds.provider, items: sentences };
}

/**
 * The scoreline for a finished game's heading, with the winner marked.
 * ESPN's winner flag decides it, with the higher score as a fallback.
 */
function finalScore(g, isFinal) {
  if (!isFinal || g.home.score === null || g.away.score === null) return null;
  const won = (side, other) =>
    side.winner === true || (side.winner == null && other.winner == null && side.score > other.score);
  return {
    away: { name: g.away.displayName, score: g.away.score, won: won(g.away, g.home) },
    home: { name: g.home.displayName, score: g.home.score, won: won(g.home, g.away) },
  };
}

function oddsLine(odds, game, isFinal = false, awayStats = null, homeStats = null) {
  if (!odds) return null;
  if (isFinal) return finalOddsLine(odds, game);
  const items = [];
  // The spread IS the market's expected margin; phrase it that way.
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(odds.details ?? "");
  if (m) {
    items.push(`Expected margin: ${m[1]} by ${m[2]}`);
  } else if (odds.details) {
    items.push(odds.details); // e.g. "EVEN"
  } else {
    items.push("No spread posted");
  }
  // No total: it says nothing about who wins, and the research never found
  // a use for it.

  // Devigged win probabilities from the moneylines, instead of raw prices.
  const pA = impliedProb(odds.awayMoneyline);
  const pH = impliedProb(odds.homeMoneyline);
  if (pA !== null && pH !== null && pA + pH > 0) {
    const a = Math.round((pA / (pA + pH)) * 100);
    items.push(`Win probability: ${game.away.abbreviation} ${a}%, ${game.home.abbreviation} ${100 - a}%`);
  }
  return { provider: odds.provider, items };
}

function returnNote(item) {
  if (!item.returnDate) return null;
  const d = new Date(`${item.returnDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const label = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
  return `Expected return ${label}.`;
}

async function injuryView(teamName, teamId, items) {
  const enriched = await Promise.all(
    items.slice(0, 8).map(async (i) => {
      let impact = { value: null, context: null };
      if (i.athleteId) {
        try {
          impact = await playerImpact(i.athleteId, teamId);
        } catch {
          // Enrichment is best effort; the card still shows the basics.
        }
      }
      return { ...i, ...impact, returnNote: returnNote(i) };
    }),
  );
  const rest = items.slice(8).map((i) => ({ ...i, value: null, context: null, returnNote: returnNote(i) }));
  const all = [...enriched, ...rest];
  return {
    teamName,
    count: all.length,
    all,
  };
}

/**
 * For a finished game: which pregame-knowable signals pointed at the actual
 * winner, which pointed the wrong way, and a verdict on predictability.
 */
function knowableSignals(g, homeForm, awayForm, homeRest, awayRest) {
  if (g.home.score === null || g.away.score === null) return null;
  const homeWon = g.home.score > g.away.score;
  const winner = homeWon ? g.home : g.away;
  const loser = homeWon ? g.away : g.home;

  // Each signal favors "home" or "away".
  const signals = [];
  signals.push({ favors: "home", text: "home court" });

  if (homeRest?.backToBack && !awayRest?.backToBack) {
    signals.push({ favors: "away", text: `the rest edge (${g.home.abbreviation} on a back-to-back)` });
  } else if (awayRest?.backToBack && !homeRest?.backToBack) {
    signals.push({ favors: "home", text: `the rest edge (${g.away.abbreviation} on a back-to-back)` });
  }

  const net = (f) =>
    f && f.avgPointsFor !== null && f.avgPointsAgainst !== null
      ? f.avgPointsFor - f.avgPointsAgainst
      : null;
  const nh = net(homeForm);
  const na = net(awayForm);
  if (nh !== null && na !== null && Math.abs(nh - na) >= 1.5) {
    const f = (n) => `${n >= 0 ? "+" : ""}${Math.round(n * 10) / 10}`;
    signals.push({
      favors: nh > na ? "home" : "away",
      text: `the better season scoring margin (${nh > na ? `${f(nh)} vs ${f(na)}` : `${f(na)} vs ${f(nh)}`} per game)`,
    });
  }

  const tenWins = (f) => {
    const m = /^(\d+)-(\d+)$/.exec(f?.lastTen ?? "");
    return m ? Number(m[1]) : null;
  };
  const th = tenWins(homeForm);
  const ta = tenWins(awayForm);
  if (th !== null && ta !== null && Math.abs(th - ta) >= 2) {
    signals.push({
      favors: th > ta ? "home" : "away",
      text: `the better last 10 (${th > ta ? `${homeForm.lastTen} vs ${awayForm.lastTen}` : `${awayForm.lastTen} vs ${homeForm.lastTen}`})`,
    });
  }

  for (const [side, form, team] of [
    ["home", homeForm, g.home],
    ["away", awayForm, g.away],
  ]) {
    const m = /^([WL])(\d+)$/.exec(form?.streak ?? "");
    if (!m || Number(m[2]) < 3) continue;
    if (m[1] === "W") {
      signals.push({ favors: side, text: `${team.abbreviation}'s ${m[2]}-game winning streak` });
    } else {
      signals.push({
        favors: side === "home" ? "away" : "home",
        text: `${team.abbreviation}'s ${m[2]}-game losing streak`,
      });
    }
  }

  const winnerSide = homeWon ? "home" : "away";
  const right = signals.filter((s) => s.favors === winnerSide).map((s) => s.text);
  const wrong = signals.filter((s) => s.favors !== winnerSide).map((s) => s.text);

  let verdict;
  if (right.length >= 2 && wrong.length === 0) {
    verdict = "The basics called this one.";
  } else if (wrong.length > right.length) {
    verdict = "The basics favored the loser; this was hard to see coming from the stats alone.";
  } else {
    verdict = "Mixed signals; this one was genuinely uncertain going in.";
  }

  const parts = [];
  if (right.length > 0) {
    parts.push(`What pointed to ${winner.abbreviation} beforehand: ${right.join(", ")}.`);
  }
  if (wrong.length > 0) {
    parts.push(`What pointed to ${loser.abbreviation} instead: ${wrong.join(", ")}.`);
  }
  parts.push(verdict);
  return parts.join(" ");
}

export default async function () {
  const ymds = [slateDateEt(-1), slateDateEt(0), slateDateEt(1)];
  const todayYmd = ymds[1];

  const [form, injuries] = await Promise.all([
    getTeamFormByTeamId(),
    getInjuriesByTeamId(),
  ]);
  const predictionsByGame = new Map(listPredictions().map((p) => [p.game_id, p]));

  // Last-10 league ranks for every team in the standings, not just the
  // teams playing, so "5th of 30" means what it says.
  const leagueRanks = await leagueRankings([...form.keys()]);

  // Lineup history may still be downloading on a first run; cards simply
  // omit cohesion until it is there.
  let cohesion = null;
  let cohesionStudy = null;
  let study = null;
  try {
    const idx = cohesionIndex();
    if (idx.gamesCovered > 0) {
      cohesion = idx;
      cohesionStudy = cohesionBacktest(idx);
      study = predictorStudy();
    }
  } catch {
    // Research notes are context; cards build without them.
  }

  const paValues = [...form.values()]
    .map((f) => f.avgPointsAgainst)
    .filter((v) => v !== null && Number.isFinite(v));
  const leagueAvgPA =
    paValues.length > 0
      ? paValues.reduce((a, b) => a + b, 0) / paValues.length
      : null;

  // Every slate, and every game within it, builds concurrently. The memo
  // layer in lib/espn.mjs merges duplicate requests, and eleventy-fetch's
  // queue caps network concurrency.
  const buildCard = async (g, rest) => {
      const isFinal = g.statusState === "post";
      const emptyInj = (team) => ({ teamName: team.displayName, count: 0, all: [] });
      const [odds, recap, awayInjView, homeInjView] = await Promise.all([
        getOdds(g.id),
        isFinal ? getGameRecap(g.id).catch(() => null) : null,
        isFinal
          ? emptyInj(g.away)
          : injuryView(g.away.displayName, g.away.id, injuries.get(g.away.id) ?? []),
        isFinal
          ? emptyInj(g.home)
          : injuryView(g.home.displayName, g.home.id, injuries.get(g.home.id) ?? []),
      ]);
      let check = null;
      let awayStats = null;
      let homeStats = null;
      let awayStartersList = null;
      let homeStartersList = null;
      let awayInjFinal = awayInjView;
      let homeInjFinal = homeInjView;
      let awayUnaccounted = [];
      let homeUnaccounted = [];
      if (!isFinal) {
        let awayTs;
        let homeTs;
        [awayStats, homeStats, awayTs, homeTs] = await Promise.all([
          teamAnalytics(g.away.id).catch(() => null),
          teamAnalytics(g.home.id).catch(() => null),
          teamStarters(g.away.id).catch(() => null),
          teamStarters(g.home.id).catch(() => null),
        ]);
        const awayR = reconcileStartersAndInjuries(awayTs, awayInjView);
        const homeR = reconcileStartersAndInjuries(homeTs, homeInjView);
        ({ starters: awayStartersList, injView: awayInjFinal, unaccounted: awayUnaccounted } = awayR);
        ({ starters: homeStartersList, injView: homeInjFinal, unaccounted: homeUnaccounted } = homeR);
        if (g.statusState === "pre") {
          // Minutes out tonight, from the full injury report.
          const awayMin = minutesOut(study, g.away, g.dateUtc, awayInjView.all);
          const homeMin = minutesOut(study, g.home, g.dateUtc, homeInjView.all);
          awayInjFinal = { ...awayInjFinal, minutesLine: minutesLine(awayMin) };
          homeInjFinal = { ...homeInjFinal, minutesLine: minutesLine(homeMin) };
          // The line check sees the full, unreconciled injury list so that
          // game-time-decision starters still surface as uncertainty, plus
          // anyone whose absence has no injury listing.
          check = lineCheck({
            game: g,
            odds,
            homeForm: form.get(g.home.id) ?? null,
            awayForm: form.get(g.away.id) ?? null,
            homeRest: rest.get(g.home.id) ?? null,
            awayRest: rest.get(g.away.id) ?? null,
            homeInjuryItems: homeInjView.all,
            awayInjuryItems: awayInjView.all,
            homeStats,
            awayStats,
            unlistedAbsences: [...awayR.unlisted, ...homeR.unlisted],
            minutes: { home: homeMin, away: awayMin, rate: study?.injuryRate ?? 0 },
          });
        }
      }
      // Bookmaker bullets as objects, so a changed one can be marked.
      // A postponed or canceled game's line no longer means anything.
      const oddsView = g.statusState === "off" ? null : oddsLine(odds, g, isFinal, awayStats, homeStats);
      if (oddsView) oddsView.items = oddsView.items.map((text) => ({ text, changed: false }));

      // Your pick, and what changed since you made it (pregame only).
      const myRow = predictionsByGame.get(g.id) ?? null;
      let changes = null;
      if (myRow && g.statusState === "pre") {
        let snap = null;
        try {
          snap = JSON.parse(myRow.snapshot_json);
        } catch {
          snap = null;
        }
        const cmp = compareToSnapshot(
          snap,
          {
            odds,
            homeForm: form.get(g.home.id) ?? null,
            awayForm: form.get(g.away.id) ?? null,
            // The full report, as the snapshot recorded it.
            homeInjuries: injuries.get(g.home.id) ?? [],
            awayInjuries: injuries.get(g.away.id) ?? [],
            homeLineup: homeStartersList?.map((s) => s.name) ?? null,
            awayLineup: awayStartersList?.map((s) => s.name) ?? null,
          },
          g,
        );
        changes = cmp.items;
        markChanges(cmp, oddsView, {
          away: { inj: awayInjFinal, starters: awayStartersList },
          home: { inj: homeInjFinal, starters: homeStartersList },
        });
      }

      return {
        recap,
        upsetShooting: isFinal && odds ? await closingFavorite(odds, g).then((fav) => upsetShootingLine(g, fav)).catch(() => null) : null,
        isFinal,
        notPlayed: g.statusState === "off",
        myPick: myRow ? pickView(myRow, g) : null,
        changes,
        collapseDetails: Boolean(myRow) && !isFinal,
        canEdit: Boolean(myRow) && picksOpen(g),
        knowable: isFinal
          ? knowableSignals(
              g,
              form.get(g.home.id) ?? null,
              form.get(g.away.id) ?? null,
              rest.get(g.home.id) ?? null,
              rest.get(g.away.id) ?? null,
            )
          : null,
        lineCheck: check ? lineCheckView(check, g, {
          form,
          rest,
          awayStats,
          homeStats,
          awayStarters: awayStartersList,
          homeStarters: homeStartersList,
          cohesion,
          study,
          cohesionStudy,
          ranks: leagueRanks,
          odds,
        }) : null,
        analyticsRows: g.statusState === "pre" ? analyticsRows(awayStats, homeStats) : null,
        rankRows: g.statusState === "pre"
          ? rankRows(leagueRanks, g.away.id, g.home.id)
          : null,
        cohesion: !isFinal && cohesion
          ? cohesionRows(cohesion, g, awayStartersList, homeStartersList, cohesionStudy)
          : null,
        id: g.id,
        heading: `${g.away.displayName} at ${g.home.displayName}`,
        finalScore: finalScore(g, isFinal),
        // A finished game's heading carries the score, so the status line
        // only remains when it adds something, such as "Final/OT".
        statusLine: finalScore(g, isFinal) && g.statusDetail === "Final" ? null : g.statusDetail,
        away: g.away,
        home: g.home,
        odds: oddsView,
        awayForm: form.get(g.away.id) ?? null,
        homeForm: form.get(g.home.id) ?? null,
        awayMatchup: matchupCell(form.get(g.away.id), form.get(g.home.id), leagueAvgPA),
        homeMatchup: matchupCell(form.get(g.home.id), form.get(g.away.id), leagueAvgPA),
        awayLastTen: form.get(g.away.id)
          ? `${form.get(g.away.id).lastTen ?? "–"} / ${form.get(g.away.id).streak ?? "–"}`
          : "–",
        homeLastTen: form.get(g.home.id)
          ? `${form.get(g.home.id).lastTen ?? "–"} / ${form.get(g.home.id).streak ?? "–"}`
          : "–",
        awayRest: restLabel(rest.get(g.away.id) ?? null),
        homeRest: restLabel(rest.get(g.home.id) ?? null),
        awayInjuries: awayInjFinal,
        homeInjuries: homeInjFinal,
        awayStarters: awayStartersList,
        homeStarters: homeStartersList,
        awayUnaccounted,
        homeUnaccounted,
        canPredict: picksOpen(g) && !myRow,
      };
  };

  const slates = await Promise.all(
    ymds.map(async (ymd) => {
      const [games, rest] = await Promise.all([
        getScoreboard(ymd),
        getRestByTeamId(ymd),
      ]);
      // Promise.all preserves input order, so cards keep scoreboard order.
      const cards = await Promise.all(games.map((g) => buildCard(g, rest)));
      return {
        ymd,
        label: labelForYmd(ymd),
        isToday: ymd === todayYmd,
        navLabel:
          ymd === todayYmd ? "Today" : ymd === ymds[0] ? "Yesterday" : "Tomorrow",
        games: cards,
      };
    }),
  );

  normalizeStarterIndices(slates);
  return slates;
}

/**
 * Offense and defensive-activity indices for starters, normalized across
 * every tracked starter on these slates: 100 is average, 15 points is one
 * standard deviation. Offense: 45% scoring per 36, 30% true shooting,
 * 25% playmaking (assists minus turnovers per 36). Defensive activity:
 * 40% steals, 40% blocks, 20% rebounds, all per 36.
 */
function normalizeStarterIndices(slates) {
  // Every displayed row gets an index, but each player counts once in the
  // sample: a team on two slate days would otherwise be double-weighted.
  const rows = [];
  const byPlayer = new Map();
  for (const s of slates) {
    for (const game of s.games) {
      for (const list of [game.awayStarters, game.homeStarters]) {
        if (!list) continue;
        for (const r of list) {
          if (!r.raw) continue;
          rows.push(r);
          if (!byPlayer.has(r.id)) byPlayer.set(r.id, r);
        }
      }
    }
  }
  const sample = [...byPlayer.values()];
  if (sample.length < 20) return; // Too few players to normalize honestly.

  const comps = ["pts36", "ts", "astNet36", "stl36", "blk36", "reb36"];
  const stats = {};
  for (const c of comps) {
    const vals = sample
      .map((r) => r.raw[c])
      .filter((v) => v !== null && Number.isFinite(v));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd =
      Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    stats[c] = { mean, sd };
  }
  const z = (r, c) =>
    r.raw[c] === null || !Number.isFinite(r.raw[c])
      ? 0
      : (r.raw[c] - stats[c].mean) / stats[c].sd;

  for (const r of rows) {
    const off =
      100 + 15 * (0.45 * z(r, "pts36") + 0.3 * z(r, "ts") + 0.25 * z(r, "astNet36"));
    const def =
      100 + 15 * (0.4 * z(r, "stl36") + 0.4 * z(r, "blk36") + 0.2 * z(r, "reb36"));
    r.off = off;
    r.def = def;
    r.indexLine = `O:${Math.round(off)}, DA:${Math.round(def)}`;
  }

  // The five as a unit: the average keeps the same scale as each player,
  // so 100 still means an average starter.
  for (const s of slates) {
    for (const game of s.games) {
      for (const side of ["away", "home"]) {
        const rated = (game[`${side}Starters`] ?? []).filter((r) => Number.isFinite(r.off));
        if (rated.length < 3) continue;
        const mean = (k) => Math.round(rated.reduce((t, r) => t + r[k], 0) / rated.length);
        const note = rated.length < 5 ? ` (${rated.length} of 5 rated)` : "";
        game[`${side}StartersGroup`] = `Starters O:${mean("off")}, Starters DA:${mean("def")}${note}`;
      }
    }
  }
}
