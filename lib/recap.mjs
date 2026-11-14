// Post-game recap: what decided a finished game, computed from the box
// score, the quarter scores, and the pregame line. Rule-based plain
// English, labelled as computed in the UI.

import { getGameSummary as getSummary } from "./espn.mjs";

function statsByName(team) {
  const m = new Map();
  for (const s of team.statistics ?? []) m.set(s.name, s.displayValue);
  return m;
}

function num(v) {
  const n = Number(String(v ?? "").split("-")[0]);
  return Number.isFinite(n) ? n : null;
}

function madeOf(v) {
  // "16-46" -> 16
  const n = Number(String(v ?? "").split("-")[0]);
  return Number.isFinite(n) ? n : null;
}

/** Winner-centric statistical factors, strongest first. */
function computeFactors(winner, loser) {
  const w = statsByName(winner.raw);
  const l = statsByName(loser.raw);
  const candidates = [];
  const add = (salience, text) => {
    if (salience >= 1) candidates.push({ salience, text });
  };

  const w3 = madeOf(w.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
  const l3 = madeOf(l.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
  if (w3 !== null && l3 !== null) {
    add(
      Math.abs(w3 - l3) / 4,
      w3 > l3
        ? `${winner.abbr} won the three-point battle ${w3} makes to ${l3} (a ${(w3 - l3) * 3}-point gap from deep)`
        : `${loser.abbr} actually won the three-point battle ${l3} makes to ${w3}, and lost anyway`,
    );
  }

  const wto = num(w.get("totalTurnovers"));
  const lto = num(l.get("totalTurnovers"));
  const wtp = num(w.get("turnoverPoints"));
  if (wto !== null && lto !== null && lto - wto >= 1) {
    add(
      (lto - wto) / 4,
      `${loser.abbr} gave it away ${lto} times against ${wto}${wtp ? `, worth ${wtp} ${winner.abbr} points` : ""}`,
    );
  }

  const wrb = num(w.get("totalRebounds"));
  const lrb = num(l.get("totalRebounds"));
  if (wrb !== null && lrb !== null) {
    add((wrb - lrb) / 6, `${winner.abbr} out-rebounded ${loser.abbr} ${wrb} to ${lrb}`);
  }

  const wfg = num(w.get("fieldGoalPct"));
  const lfg = num(l.get("fieldGoalPct"));
  if (wfg !== null && lfg !== null) {
    add(
      (wfg - lfg) / 5,
      `${winner.abbr} shot ${wfg}% from the field against ${lfg}%`,
    );
  }

  const wft = String(w.get("freeThrowsMade-freeThrowsAttempted") ?? "");
  const lft = String(l.get("freeThrowsMade-freeThrowsAttempted") ?? "");
  const wfta = Number(wft.split("-")[1]);
  const lfta = Number(lft.split("-")[1]);
  if (Number.isFinite(wfta) && Number.isFinite(lfta)) {
    add(
      (wfta - lfta) / 8,
      `${winner.abbr} got to the line ${wfta} times against ${lfta}`,
    );
  }

  const wp = num(w.get("pointsInPaint"));
  const lp = num(l.get("pointsInPaint"));
  if (wp !== null && lp !== null) {
    add((wp - lp) / 10, `${winner.abbr} owned the paint ${wp} to ${lp}`);
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return candidates.slice(0, 3).map((c) => c.text);
}

function quarterStory(winner, loser) {
  const wq = (winner.linescores ?? []).map(Number);
  const lq = (loser.linescores ?? []).map(Number);
  if (wq.length < 4 || lq.length < 4) return null;
  const names = ["1st", "2nd", "3rd", "4th", "OT", "2OT", "3OT"];
  let best = null;
  for (let i = 0; i < wq.length; i++) {
    const margin = wq[i] - lq[i];
    if (!best || Math.abs(margin) > Math.abs(best.margin)) {
      best = { i, margin };
    }
  }
  if (!best || Math.abs(best.margin) < 8) return null;
  const q = names[best.i] ?? `period ${best.i + 1}`;
  return best.margin > 0
    ? `The game turned in the ${q}, which ${winner.abbr} won ${wq[best.i]}-${lq[best.i]}.`
    : `${loser.abbr} took the ${q} ${lq[best.i]}-${wq[best.i]} but could not hold the rest.`;
}

/** Top two scorers per team with their stat lines, from the box score. */
function keyPerformances(summary) {
  const lines = [];
  for (const teamBox of summary.boxscore?.players ?? []) {
    const abbr = teamBox.team?.abbreviation;
    const block = teamBox.statistics?.[0];
    const labels = block?.names ?? block?.labels ?? [];
    const iPts = labels.indexOf("PTS");
    const iReb = labels.indexOf("REB");
    const iAst = labels.indexOf("AST");
    if (!abbr || iPts < 0) continue;
    const players = (block.athletes ?? [])
      .filter((a) => !a.didNotPlay && Array.isArray(a.stats))
      .map((a) => ({
        name: a.athlete?.displayName ?? "Unknown",
        pts: Number(a.stats[iPts]),
        reb: iReb >= 0 ? Number(a.stats[iReb]) : NaN,
        ast: iAst >= 0 ? Number(a.stats[iAst]) : NaN,
      }))
      .filter((p) => Number.isFinite(p.pts))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, 2)
      .map((p) => {
        let s = `${p.name} ${p.pts} pts`;
        if (Number.isFinite(p.reb) && p.reb >= 10) s += ` ${p.reb} reb`;
        if (Number.isFinite(p.ast) && p.ast >= 8) s += ` ${p.ast} ast`;
        return s;
      });
    if (players.length > 0) lines.push(`${abbr}: ${players.join(", ")}`);
  }
  return lines.length > 0 ? `Key performances — ${lines.join(". ")}.` : null;
}

export async function getGameRecap(eventId) {
  const summary = await getSummary(eventId);
  const comps = summary.header?.competitions?.[0]?.competitors ?? [];
  if (comps.length < 2) return null;
  const sides = comps.map((c) => ({
    abbr: c.team?.abbreviation,
    score: Number(c.score),
    linescores: (c.linescores ?? []).map((ls) => ls.displayValue),
    raw: (summary.boxscore?.teams ?? []).find(
      (t) => t.team?.abbreviation === c.team?.abbreviation,
    ) ?? { statistics: [] },
  }));
  if (!Number.isFinite(sides[0].score) || !Number.isFinite(sides[1].score)) return null;
  const [winner, loser] =
    sides[0].score > sides[1].score ? [sides[0], sides[1]] : [sides[1], sides[0]];
  const margin = winner.score - loser.score;

  // The card's line block already restates the market against the result,
  // so the recap sticks to how the game itself unfolded.
  const sentences = [];
  const qs = quarterStory(winner, loser);
  if (qs) sentences.push(qs);
  if (!qs && margin <= 5) {
    sentences.push(`A possession game to the end: ${winner.abbr} escaped by ${margin}.`);
  }

  return {
    analysis: sentences.join(" ") || null,
    factors: computeFactors(winner, loser),
    performers: keyPerformances(summary),
  };
}
