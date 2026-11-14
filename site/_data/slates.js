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

function oddsLine(odds, game) {
  if (!odds) return null;
  let s = `${odds.details ?? "No spread posted"}`;
  if (odds.overUnder !== null) s += `, total ${odds.overUnder}`;
  if (odds.awayMoneyline !== null && odds.homeMoneyline !== null) {
    const fmtMl = (n) => (n > 0 ? `+${n}` : `${n}`);
    s += `. Moneyline: ${game.away.abbreviation} ${fmtMl(odds.awayMoneyline)}, ${game.home.abbreviation} ${fmtMl(odds.homeMoneyline)}`;
  }
  return { provider: odds.provider, text: s, movement: movementNotes(odds) };
}

function injuryView(teamName, items) {
  const notable = items.filter((i) => i.status.toLowerCase() !== "day-to-day");
  const visible = (notable.length > 0 ? notable : items).slice(0, 4);
  return {
    teamName,
    count: items.length,
    visible,
    all: items,
    showFull: items.length > visible.length,
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
      cards.push({
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
        awayInjuries: injuryView(g.away.displayName, injuries.get(g.away.id) ?? []),
        homeInjuries: injuryView(g.home.displayName, injuries.get(g.home.id) ?? []),
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
