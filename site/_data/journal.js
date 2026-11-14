// Prediction journal data: grades any finished games first, then returns
// every prediction with display fields precomputed for the template.

import { getScoreboard } from "../../lib/espn.mjs";
import {
  RETRO_TAGS,
  listPredictions,
  listUnreconciled,
  reconcilePrediction,
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

export default async function () {
  await reconcilePending();
  const rows = listPredictions();

  const predictions = rows.map((p) => {
    const graded = p.reconciled_at_utc !== null;
    let retroTags = [];
    try {
      retroTags = p.retro_tags ? JSON.parse(p.retro_tags) : [];
    } catch {
      retroTags = [];
    }
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
      hasRetro: p.retro_at_utc !== null,
      retroTags,
      retroNotes: p.retro_notes ?? "",
      needsRetro: graded && p.retro_at_utc === null,
    };
  });

  const graded = predictions.filter((p) => p.graded);
  const correct = rows.filter((p) => p.pick_correct === 1).length;

  return {
    predictions,
    retroTagOptions: RETRO_TAGS,
    summary:
      predictions.length === 0
        ? "No predictions logged yet. Pick a game on the slate to start."
        : `Record so far: ${correct} correct of ${graded.length} graded (${predictions.length - graded.length} awaiting results).`,
  };
}
