// Post-game recap: what decided a finished game, computed from the box
// score, the quarter scores, and the pregame line. Rule-based plain
// English, labelled as computed in the UI.

import { getGameSummary as getSummary } from "./espn.mjs";
import { teamAnalytics } from "./teamstats.mjs";

/**
 * How hard this game was to predict, from the live win-probability series
 * and shooting variance. Returns short plain-English observations.
 */
async function surpriseAnalysis(summary, winner, loser) {
  const notes = [];

  // Win-probability path: did the winner ever look beaten, and how often
  // did control of the game flip?
  // Stored summaries hold bare numbers; accept the raw ESPN shape too.
  const wp = (summary.winprobability ?? [])
    .map((p) => (typeof p === "number" ? p : p?.homeWinPercentage))
    .filter((v) => typeof v === "number");
  if (wp.length > 20) {
    const winnerProb = winner.homeAway === "home" ? wp : wp.map((v) => 1 - v);
    const low = Math.min(...winnerProb.slice(5, -5));
    let crossings = 0;
    for (let i = 1; i < wp.length; i++) {
      if ((wp[i] - 0.5) * (wp[i - 1] - 0.5) < 0) crossings++;
    }
    if (low <= 0.2) {
      notes.push(
        `${winner.abbr}'s live win probability bottomed out at ${Math.round(low * 100)}%: they won a game they were losing, which no pregame number predicts.`,
      );
    } else if (low >= 0.45 && crossings <= 2) {
      notes.push(
        `${winner.abbr} controlled this nearly wire to wire (live win probability never below ${Math.round(low * 100)}%): as predictable as games get in-play.`,
      );
    }
    if (crossings >= 8) {
      notes.push(
        `Control flipped ${crossings} times: genuine coin-flip territory, where being wrong carries little signal.`,
      );
    }
  }

  // Shooting variance: a team far off its own recent three-point form is
  // luck more often than skill.
  for (const side of [winner, loser]) {
    try {
      const ta = side.id ? await teamAnalytics(side.id) : null;
      if (!ta || ta.tpPct === null || !side.tp) continue;
      const gamePct = side.tp.att > 0 ? (side.tp.made / side.tp.att) * 100 : null;
      if (gamePct === null) continue;
      const diff = gamePct - ta.tpPct;
      if (Math.abs(diff) >= 10 && side.tp.att >= 15) {
        notes.push(
          `${side.abbr} shot ${Math.round(gamePct)}% from three against their recent ${Math.round(ta.tpPct)}%: a ${diff > 0 ? "hot" : "cold"} shooting outlier worth distrusting as signal.`,
        );
      }
    } catch {
      // Variance note is best effort.
    }
  }
  return notes;
}

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
  const sides = comps.map((c) => {
    const raw = (summary.boxscore?.teams ?? []).find(
      (t) => t.team?.abbreviation === c.team?.abbreviation,
    ) ?? { statistics: [] };
    const tpCell = (raw.statistics ?? []).find(
      (s) => s.name === "threePointFieldGoalsMade-threePointFieldGoalsAttempted",
    )?.displayValue;
    const [tpm, tpa] = String(tpCell ?? "").split("-").map(Number);
    return {
      abbr: c.team?.abbreviation,
      id: c.team?.id,
      homeAway: c.homeAway,
      score: Number(c.score),
      linescores: (c.linescores ?? []).map((ls) => ls.displayValue),
      raw,
      tp: Number.isFinite(tpm) && Number.isFinite(tpa) ? { made: tpm, att: tpa } : null,
    };
  });
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
    surprise: await surpriseAnalysis(summary, winner, loser),
  };
}
