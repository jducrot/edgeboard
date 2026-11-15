// Builds the three slate days (yesterday, today, tomorrow) with everything
// the templates need precomputed, so the Nunjucks stays presentation-only.

import {
  getInjuriesByTeamId,
  getOdds,
  getRestByTeamId,
  getScoreboard,
  getTeamFormByTeamId,
  labelForYmd,
  slateDateEt,
} from "../../lib/espn.mjs";
import { listPredictions } from "../../lib/db.mjs";
import { playerImpact } from "../../lib/impact.mjs";
import { getGameRecap } from "../../lib/recap.mjs";
import { teamStarters } from "../../lib/starters.mjs";
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

function restLabel(rest) {
  if (!rest) return "4+ days rest";
  if (rest.backToBack) return "Back-to-back (0 days rest)";
  if (rest.daysOfRest === 1) return "1 day rest";
  return `${rest.daysOfRest} days rest`;
}

function movementNotes(odds) {
  const notes = [];
  if (
    odds.openTotal !== null &&
    odds.currentTotal !== null &&
    odds.openTotal !== odds.currentTotal
  ) {
    const dir = odds.currentTotal < odds.openTotal ? "down" : "up";
    notes.push(`Total moved ${dir} from ${odds.openTotal} to ${odds.currentTotal}`);
  }
  if (
    odds.openAwaySpread !== null &&
    odds.currentAwaySpread !== null &&
    odds.openAwaySpread !== odds.currentAwaySpread
  ) {
    notes.push(
      `Away spread moved from ${odds.openAwaySpread} to ${odds.currentAwaySpread}`,
    );
  }
  return notes;
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
      sentences.push(`${fav} closed as ${num}-point favorites and won by ${margin}: ${res}.`);
    } else {
      sentences.push(
        `${fav} closed as ${num}-point favorites and lost by ${margin}: an upset, and ${winner.abbreviation} covered.`,
      );
    }
  }

  if (odds.overUnder !== null) {
    const combined = hs + as;
    const diff = Math.round((combined - odds.overUnder) * 10) / 10;
    const res =
      diff > 0 ? `over by ${diff}` : diff < 0 ? `under by ${-diff}` : "a push";
    let s = `Total ${odds.overUnder}: they scored ${combined}, ${res}.`;
    if (
      odds.openTotal !== null &&
      odds.currentTotal !== null &&
      odds.openTotal !== odds.currentTotal
    ) {
      const dir = odds.currentTotal < odds.openTotal ? "dropped" : "rose";
      const confirmed =
        (dir === "dropped" && diff < 0) || (dir === "rose" && diff > 0);
      s += ` The total had ${dir} from ${odds.openTotal} before tipoff${confirmed ? ", and the move was right" : ", but the game went the other way"}.`;
    }
    sentences.push(s);
  }

  if (sentences.length === 0) return null;
  return { provider: odds.provider, text: sentences.join(" "), movement: [] };
}

function oddsLine(odds, game, isFinal = false) {
  if (!odds) return null;
  if (isFinal) return finalOddsLine(odds, game);
  // The spread IS the market's expected margin; phrase it that way.
  let s;
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(odds.details ?? "");
  if (m) {
    s = `Expected margin: ${m[1]} by ${m[2]}`;
  } else if (odds.details) {
    s = odds.details; // e.g. "EVEN"
  } else {
    s = "No spread posted";
  }
  if (odds.overUnder !== null) s += `, total ${odds.overUnder}`;

  // Devigged win probabilities from the moneylines, instead of raw prices.
  const pA = impliedProb(odds.awayMoneyline);
  const pH = impliedProb(odds.homeMoneyline);
  if (pA !== null && pH !== null && pA + pH > 0) {
    const a = Math.round((pA / (pA + pH)) * 100);
    s += `. Win probability: ${game.away.abbreviation} ${a}%, ${game.home.abbreviation} ${100 - a}%`;
  }
  return { provider: odds.provider, text: s, movement: movementNotes(odds) };
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
  const notable = all.filter((i) => i.status.toLowerCase() !== "day-to-day");
  const visible = (notable.length > 0 ? notable : all).slice(0, 4);
  // The disclosure holds only players NOT already shown above it.
  const more = all.filter((i) => !visible.includes(i));
  return {
    teamName,
    count: all.length,
    visible,
    more,
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
  const predictedGameIds = new Set(listPredictions().map((p) => p.game_id));

  const paValues = [...form.values()]
    .map((f) => f.avgPointsAgainst)
    .filter((v) => v !== null && Number.isFinite(v));
  const leagueAvgPA =
    paValues.length > 0
      ? paValues.reduce((a, b) => a + b, 0) / paValues.length
      : null;

  const slates = [];
  for (const ymd of ymds) {
    const [games, rest] = await Promise.all([
      getScoreboard(ymd),
      getRestByTeamId(ymd),
    ]);
    const cards = [];
    for (const g of games) {
      const odds = await getOdds(g.id);
      const isFinal = g.statusState === "post";
      let recap = null;
      if (isFinal) {
        try {
          recap = await getGameRecap(g.id);
        } catch {
          recap = null; // Recaps are best effort.
        }
      }
      const awayInjView = isFinal
        ? { teamName: g.away.displayName, count: 0, visible: [], more: [] }
        : await injuryView(g.away.displayName, g.away.id, injuries.get(g.away.id) ?? []);
      const homeInjView = isFinal
        ? { teamName: g.home.displayName, count: 0, visible: [], more: [] }
        : await injuryView(g.home.displayName, g.home.id, injuries.get(g.home.id) ?? []);
      let check = null;
      let awayStats = null;
      let homeStats = null;
      if (g.statusState === "pre") {
        [awayStats, homeStats] = await Promise.all([
          teamAnalytics(g.away.id).catch(() => null),
          teamAnalytics(g.home.id).catch(() => null),
        ]);
        check = lineCheck({
          game: g,
          odds,
          homeForm: form.get(g.home.id) ?? null,
          awayForm: form.get(g.away.id) ?? null,
          homeRest: rest.get(g.home.id) ?? null,
          awayRest: rest.get(g.away.id) ?? null,
          homeInjuryItems: [...homeInjView.visible, ...homeInjView.more],
          awayInjuryItems: [...awayInjView.visible, ...awayInjView.more],
          homeStats,
          awayStats,
        });
      }
      cards.push({
        recap,
        isFinal,
        knowable: isFinal
          ? knowableSignals(
              g,
              form.get(g.home.id) ?? null,
              form.get(g.away.id) ?? null,
              rest.get(g.home.id) ?? null,
              rest.get(g.away.id) ?? null,
            )
          : null,
        lineCheck: check ? check.text : null,
        analyticsRows: g.statusState === "pre" ? analyticsRows(awayStats, homeStats) : null,
        id: g.id,
        heading: `${g.away.displayName} at ${g.home.displayName}`,
        statusLine:
          isFinal && g.home.score !== null && g.away.score !== null
            ? `${g.statusDetail} — ${g.away.abbreviation} ${g.away.score}, ${g.home.abbreviation} ${g.home.score}`
            : g.statusDetail,
        away: g.away,
        home: g.home,
        odds: oddsLine(odds, g, isFinal),
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
        awayInjuries: awayInjView,
        homeInjuries: homeInjView,
        awayStarters: isFinal ? null : await teamStarters(g.away.id).catch(() => null),
        homeStarters: isFinal ? null : await teamStarters(g.home.id).catch(() => null),
        hasPrediction: predictedGameIds.has(g.id),
        canPredict: g.statusState === "pre" && !predictedGameIds.has(g.id),
      });
    }
    slates.push({
      ymd,
      label: labelForYmd(ymd),
      isToday: ymd === todayYmd,
      navLabel:
        ymd === todayYmd ? "Today" : ymd === ymds[0] ? "Yesterday" : "Tomorrow",
      games: cards,
    });
  }

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
  const rows = new Set();
  for (const s of slates) {
    for (const game of s.games) {
      for (const list of [game.awayStarters, game.homeStarters]) {
        if (!list) continue;
        for (const r of list) if (r.raw) rows.add(r);
      }
    }
  }
  const sample = [...rows];
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

  for (const r of sample) {
    const off =
      100 + 15 * (0.45 * z(r, "pts36") + 0.3 * z(r, "ts") + 0.25 * z(r, "astNet36"));
    const def =
      100 + 15 * (0.4 * z(r, "stl36") + 0.4 * z(r, "blk36") + 0.2 * z(r, "reb36"));
    r.indexLine = `O:${Math.round(off)}, DA:${Math.round(def)}`;
  }
}
