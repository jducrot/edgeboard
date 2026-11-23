// Prediction journal data: grades any finished games first, then returns
// every prediction with display fields precomputed for the template.

import { getScoreboard } from "../../lib/espn.mjs";
import { trackRecord } from "../../lib/trackrecord.mjs";
import { confidenceChart, confidenceSummary, promiseAt } from "../../lib/charts.mjs";
import { predictorStudy } from "../../lib/predictors.mjs";

/** The track record, worded and formatted for the Review page. */
function trackView(t) {
  if (t.graded === 0) return null;
  const pc = (x) => (x.games ? `${x.pct.toFixed(0)}%` : "–");
  const of = (x) => (x.games ? `${x.right} of ${x.games}` : "none yet");
  const row = (label, x, note = "") => ({ label, right: pc(x), count: of(x), note });
  return {
    early: t.graded < 30,
    graded: t.graded,
    compare: [
      row("You", t.you),
      row("The market's favorite", t.market),
      row("The Line check's stats", t.stats, "Rebuilt from each pick's snapshot, without fresh absences"),
    ],
    confidence: t.byConfidence.map((c) => row(`Confidence ${c.confidence}`, c, `Promises about ${promiseAt(c.confidence)}%`)),
    chart: confidenceChart(t.byConfidence),
    chartSummary: confidenceSummary(t.byConfidence),
    sides: [
      row("You picked the favorite", t.favorite),
      row("You picked the underdog", t.underdog, t.underdog.usualPct != null ? `Underdogs at those spreads usually win ${t.underdog.usualPct.toFixed(0)}%` : ""),
      row("You picked the home team", t.home),
      row("You picked the road team", t.away),
      row("Your pick covered the spread", t.againstSpread, "Needs 52.4% to profit at standard odds"),
    ],
  };
}
import { getGameRecap } from "../../lib/recap.mjs";
import {
  listPredictions,
  listUnreconciled,
  reconcilePrediction,
  saveAutoRetro,
} from "../../lib/db.mjs";

/**
 * Grade picks on games played to the end. Returns pick id -> status for
 * picks whose game was postponed or canceled, which are never graded.
 */
async function reconcilePending() {
  const notPlayed = new Map();
  const pending = listUnreconciled();
  if (pending.length === 0) return notPlayed;
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
      if (g?.statusState === "off") notPlayed.set(p.id, g.statusDetail || "Postponed");
      if (!g || g.statusState !== "post") continue;
      if (g.home.score === null || g.away.score === null) continue;
      const homeWon = g.home.score > g.away.score;
      const correct = (p.pick === "home") === homeWon;
      reconcilePrediction(p.id, g.home.score, g.away.score, correct);
    }
  }
  return notPlayed;
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

  const items = [];
  let marginNote = "";
  if (youRight && p.predicted_margin !== null) {
    marginNote = ` (final margin ${winMargin} against your ${p.predicted_margin})`;
  }
  items.push(
    `Your pick: ${p.pick_team} at ${p.confidence}/5 confidence, ${youRight ? "correct" : "wrong"}${marginNote}`,
  );

  // Compare your read with the market's.
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(p.line_at_prediction ?? "");
  if (m) {
    const fav = m[1];
    // If your pick was right, the winner is your team; otherwise the other
    // side won. The favorite won when it matches the winner.
    const favoriteWon = youRight ? fav === p.pick_team : fav !== p.pick_team;
    if (youRight && !favoriteWon) {
      items.push(`Market: had ${fav} -${m[2]} and missed, so your read beat the line`);
    } else if (youRight && favoriteWon) {
      items.push(`Market: agreed with you (${fav} -${m[2]}), so no edge proven either way`);
    } else if (!youRight && favoriteWon) {
      items.push(`Market: had ${fav} -${m[2]} and was right, and your read went against it`);
    } else {
      items.push(`Market: ${fav} -${m[2]} missed this one too, so nobody saw it coming`);
    }
  }

  try {
    const recap = await getGameRecap(p.game_id);
    if (recap?.analysis) items.push(recap.analysis);
    for (const f of recap?.factors ?? []) items.push(`Factor: ${f}`);
    for (const s of recap?.surprise ?? []) items.push(s);
  } catch {
    // Recap is enrichment.
  }
  return items;
}

// Bump when the generated content gets smarter or changes shape, so
// existing retrospectives regenerate once.
const RETRO_GEN = 4;

/** Stored retrospectives are JSON arrays; older rows may hold plain text. */
function parseRetroItems(stored) {
  if (!stored) return null;
  try {
    const v = JSON.parse(stored);
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch {
    return [stored];
  }
}

export default async function () {
  const notPlayed = await reconcilePending();
  const rows = listPredictions();

  for (const p of rows) {
    if (p.reconciled_at_utc !== null && (!p.auto_retro || (p.retro_gen ?? 0) < RETRO_GEN)) {
      try {
        const items = await generateAutoRetro(p);
        p.auto_retro = JSON.stringify(items);
        saveAutoRetro(p.id, p.auto_retro, RETRO_GEN);
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
      outcome: graded ? (p.pick_correct ? "correct" : "incorrect") : null,
      resultLine: !graded
        ? notPlayed.has(p.id)
          ? `Not graded: the game was ${notPlayed.get(p.id).toLowerCase()}`
          : "Awaiting result"
        : `${p.pick_correct ? "Correct" : "Incorrect"}, final ${p.final_away_score}–${p.final_home_score}`,
      snapshot: snapshotSummary(p.snapshot_json),
      autoRetroItems: parseRetroItems(p.auto_retro),
      retroNotes: p.retro_notes ?? "",
      syncNote: p.sync_note ?? null,
      canAddNotes: graded && !p.retro_notes,
    };
  });

  const graded = predictions.filter((p) => p.graded);
  const correct = rows.filter((p) => p.pick_correct === 1).length;

  let usualAt = null;
  try {
    usualAt = predictorStudy().usualAt;
  } catch {
    // Without lineup history, the underdog comparison is left out.
  }
  return {
    predictions,
    track: trackView(trackRecord(rows, { usualAt })),
    summary:
      predictions.length === 0
        ? "No predictions logged yet. Pick a game on the slate to start."
        : `Record so far: ${correct} correct of ${graded.length} graded (${predictions.length - graded.length} awaiting results).`,
  };
}
