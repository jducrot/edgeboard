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

function fmt(n, digits = 1) {
  return n === null || n === undefined ? "–" : Number(n).toFixed(digits);
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

function oddsLine(odds, game) {
  if (!odds) return null;
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

export default async function () {
  const ymds = [slateDateEt(-1), slateDateEt(0), slateDateEt(1)];
  const todayYmd = ymds[1];

  const [form, injuries] = await Promise.all([
    getTeamFormByTeamId(),
    getInjuriesByTeamId(),
  ]);
  const predictedGameIds = new Set(listPredictions().map((p) => p.game_id));

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
      if (g.statusState === "pre") {
        check = lineCheck({
          game: g,
          odds,
          homeForm: form.get(g.home.id) ?? null,
          awayForm: form.get(g.away.id) ?? null,
          homeRest: rest.get(g.home.id) ?? null,
          awayRest: rest.get(g.away.id) ?? null,
          homeInjuryItems: [...homeInjView.visible, ...homeInjView.more],
          awayInjuryItems: [...awayInjView.visible, ...awayInjView.more],
        });
      }
      cards.push({
        recap,
        isFinal,
        lineCheck: check ? check.text : null,
        id: g.id,
        heading: `${g.away.displayName} at ${g.home.displayName}`,
        statusLine:
          isFinal && g.home.score !== null && g.away.score !== null
            ? `${g.statusDetail} — ${g.away.abbreviation} ${g.away.score}, ${g.home.abbreviation} ${g.home.score}`
            : g.statusDetail,
        away: g.away,
        home: g.home,
        odds: oddsLine(odds, g),
        awayForm: form.get(g.away.id) ?? null,
        homeForm: form.get(g.home.id) ?? null,
        awayPoints: form.get(g.away.id)
          ? `${fmt(form.get(g.away.id).avgPointsFor)} / ${fmt(form.get(g.away.id).avgPointsAgainst)}`
          : "–",
        homePoints: form.get(g.home.id)
          ? `${fmt(form.get(g.home.id).avgPointsFor)} / ${fmt(form.get(g.home.id).avgPointsAgainst)}`
          : "–",
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
  return slates;
}
