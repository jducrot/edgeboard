// Prediction journal data: grades any finished games first, then returns
// every prediction with display fields precomputed for the template.

import { getScoreboard } from "../../lib/espn.mjs";
import { getGameRecap } from "../../lib/recap.mjs";
import {
  listPredictions,
  listUnreconciled,
  reconcilePrediction,
  saveAutoRetro,
} from "../../lib/db.mjs";

async function reconcilePending() {
  const pending = listUnreconciled();
  if (pending.length === 0) return;
  const dates = [...new Set(pending.map((p) => p.game_date_et.replaceAll("-", "")))];
  for (const d of dates) {
    let games;
    try {
      games = await getScoreboard(d);
    } catch {
      continue;
    }
    for (const p of pending.filter((x) => x.game_date_et.replaceAll("-", "") === d)) {
      const g = games.find((x) => x.id === p.game_id);
      if (!g || g.statusState !== "post") continue;
      if (g.home.score === null || g.away.score === null) continue;
      const homeWon = g.home.score > g.away.score;
      const correct = (p.pick === "home") === homeWon;
      reconcilePrediction(p.id, g.home.score, g.away.score, correct);
    }
  }
}

function snapshotSummary(json) {
  let snap;
  try {
    snap = JSON.parse(json);
  } catch {
    return null;
  }
  if (!snap?.game) return null;
  const inj = (items) =>
    !items || items.length === 0
      ? "none listed"
      : items.map((i) => `${i.athlete} (${i.status})`).join(", ");
  const formLine = (f) =>
    f
      ? `${f.wins}-${f.losses}, last 10: ${f.lastTen ?? "–"}, diff ${f.pointDifferential ?? "–"}`
      : "–";
  return {
    line: snap.odds
      ? `${snap.odds.details ?? "no spread"}, total ${snap.odds.overUnder ?? "–"} (${snap.odds.provider})`
      : "none posted",
    awayAbbr: snap.game.away.abbreviation,
    homeAbbr: snap.game.home.abbreviation,
    awayForm: formLine(snap.awayForm),
    homeForm: formLine(snap.homeForm),
    awayInjuries: inj(snap.awayInjuries),
    homeInjuries: inj(snap.homeInjuries),
  };
}

/**
 * The computed retrospective: your pick against the market's pick and the
 * result, plus how the game was actually decided.
 */
async function generateAutoRetro(p) {
  const winMargin = Math.abs(p.final_home_score - p.final_away_score);
  const youRight = p.pick_correct === 1;

  const sentences = [];
  let marginNote = "";
  if (youRight && p.predicted_margin !== null) {
    marginNote = `, final margin ${winMargin} against your ${p.predicted_margin}`;
  }
  sentences.push(
    `You picked ${p.pick_team} at confidence ${p.confidence}/5: ${youRight ? "correct" : "wrong"}${marginNote}.`,
  );

  // Compare your read with the market's.
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(p.line_at_prediction ?? "");
  if (m) {
    const fav = m[1];
    // If your pick was right, the winner is your team; otherwise the other
    // side won. The favorite won when it matches the winner.
    const favoriteWon = youRight ? fav === p.pick_team : fav !== p.pick_team;
    if (youRight && !favoriteWon) {
      sentences.push(`The market had ${fav} -${m[2]} and missed; your read beat the line.`);
    } else if (youRight && favoriteWon) {
      sentences.push(`The market agreed (${fav} -${m[2]}); no edge proven either way.`);
    } else if (!youRight && favoriteWon) {
      sentences.push(`The market had ${fav} -${m[2]} and was right; your read went against it and lost.`);
    } else {
      sentences.push(`The market (${fav} -${m[2]}) missed this one too; nobody saw it.`);
    }
  }

  try {
    const recap = await getGameRecap(p.game_id);
    if (recap?.analysis) sentences.push(recap.analysis);
    if (recap?.factors?.length) {
      sentences.push(`Deciding factors: ${recap.factors.join("; ")}.`);
    }
  } catch {
    // Recap is enrichment.
  }
  return sentences.join(" ");
}

export default async function () {
  await reconcilePending();
  const rows = listPredictions();

  for (const p of rows) {
    if (p.reconciled_at_utc !== null && !p.auto_retro) {
      try {
        const text = await generateAutoRetro(p);
        saveAutoRetro(p.id, text);
        p.auto_retro = text;
      } catch {
        // Try again next build.
      }
    }
  }

  const predictions = rows.map((p) => {
    const graded = p.reconciled_at_utc !== null;
    return {
      id: p.id,
      gameLabel: p.game_label,
      gameDateEt: p.game_date_et,
      pickLine:
        `${p.pick_team} to win` +
        (p.predicted_margin !== null ? ` by ${p.predicted_margin}` : "") +
        `, confidence ${p.confidence}/5`,
      lineAtPrediction: p.line_at_prediction ?? "none posted",
      reasoning: p.reasoning,
      graded,
      resultLine: !graded
        ? "Awaiting result"
        : `${p.pick_correct ? "Correct" : "Incorrect"} — final ${p.final_away_score}–${p.final_home_score}`,
      snapshot: snapshotSummary(p.snapshot_json),
      autoRetro: p.auto_retro ?? null,
      retroNotes: p.retro_notes ?? "",
      canAddNotes: graded && !p.retro_notes,
    };
  });

  const graded = predictions.filter((p) => p.graded);
  const correct = rows.filter((p) => p.pick_correct === 1).length;

  return {
    predictions,
    summary:
      predictions.length === 0
        ? "No predictions logged yet. Pick a game on the slate to start."
        : `Record so far: ${correct} correct of ${graded.length} graded (${predictions.length - graded.length} awaiting results).`,
  };
}
