"use server";

import {
  getInjuriesByTeamId,
  getOdds,
  getRestByTeamId,
  getScoreboard,
  getTeamFormByTeamId,
  toEtDateString,
} from "@/lib/espn";
import {
  insertPrediction,
  listPredictionsForGame,
  listUnreconciled,
  reconcilePrediction,
  saveRetro,
} from "@/lib/db";
import type { GameSnapshot, PickSide } from "@/lib/types";
import { RETRO_TAGS } from "@/lib/types";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Save a prediction. Freezes a full snapshot of everything the app knows
 * about the game at this moment, so retrospectives compare against what
 * was actually knowable before tipoff.
 */
export async function savePrediction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const gameId = String(formData.get("gameId") ?? "");
  const slateDate = String(formData.get("slateDate") ?? ""); // YYYYMMDD
  const pick = String(formData.get("pick") ?? "") as PickSide;
  const marginRaw = String(formData.get("predictedMargin") ?? "").trim();
  const confidence = Number(formData.get("confidence") ?? 0);
  const reasoning = String(formData.get("reasoning") ?? "").trim();

  if (!gameId || !slateDate) return { ok: false, message: "Missing game reference." };
  if (pick !== "home" && pick !== "away") {
    return { ok: false, message: "Choose which team you expect to win." };
  }
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return { ok: false, message: "Confidence must be between 1 and 5." };
  }
  if (reasoning.length < 10) {
    return {
      ok: false,
      message: "Write at least a sentence of reasoning. Future you needs it for the retrospective.",
    };
  }
  let predictedMargin: number | null = null;
  if (marginRaw !== "") {
    const m = Number(marginRaw);
    if (!Number.isInteger(m) || m < 1 || m > 60) {
      return { ok: false, message: "Predicted margin must be a whole number between 1 and 60." };
    }
    predictedMargin = m;
  }

  if (listPredictionsForGame(gameId).length > 0) {
    return { ok: false, message: "You already logged a prediction for this game." };
  }

  const games = await getScoreboard(slateDate);
  const game = games.find((g) => g.id === gameId);
  if (!game) return { ok: false, message: "Could not find that game on the slate." };
  if (game.statusState !== "pre") {
    return { ok: false, message: "This game has already started. Predictions lock at tipoff." };
  }

  const [odds, form, injuries, rest] = await Promise.all([
    getOdds(gameId),
    getTeamFormByTeamId(),
    getInjuriesByTeamId(),
    getRestByTeamId(slateDate),
  ]);

  const snapshot: GameSnapshot = {
    game,
    odds,
    homeForm: form.get(game.home.id) ?? null,
    awayForm: form.get(game.away.id) ?? null,
    homeInjuries: injuries.get(game.home.id) ?? [],
    awayInjuries: injuries.get(game.away.id) ?? [],
    homeRest: rest.get(game.home.id) ?? null,
    awayRest: rest.get(game.away.id) ?? null,
    capturedAtUtc: new Date().toISOString(),
  };

  insertPrediction({
    gameId,
    gameDateEt: toEtDateString(game.dateUtc),
    gameLabel: game.shortName,
    pick,
    pickTeam: pick === "home" ? game.home.abbreviation : game.away.abbreviation,
    predictedMargin,
    confidence,
    reasoning,
    lineAtPrediction: odds?.details ?? null,
    snapshotJson: JSON.stringify(snapshot),
  });

  // No revalidatePath here: it would re-render the current route in the same
  // response, unmounting the form and its live status message before screen
  // readers announce it. Both pages are dynamic and re-read the database on
  // the next navigation anyway.
  const team = pick === "home" ? game.home.displayName : game.away.displayName;
  return { ok: true, message: `Prediction saved: ${team} to win. Inputs snapshotted.` };
}

/** Grade finished games for any predictions still waiting on a result. */
export async function reconcilePending(): Promise<number> {
  const pending = listUnreconciled();
  if (pending.length === 0) return 0;
  const dates = [...new Set(pending.map((p) => p.gameDateEt.replaceAll("-", "")))];
  let reconciled = 0;
  for (const d of dates) {
    let games;
    try {
      games = await getScoreboard(d);
    } catch {
      continue;
    }
    for (const p of pending.filter((x) => x.gameDateEt.replaceAll("-", "") === d)) {
      const g = games.find((x) => x.id === p.gameId);
      if (!g || g.statusState !== "post") continue;
      if (g.home.score === undefined || g.away.score === undefined) continue;
      const homeWon = g.home.score > g.away.score;
      const correct = (p.pick === "home") === homeWon;
      reconcilePrediction(p.id, g.home.score, g.away.score, correct);
      reconciled++;
    }
  }
  return reconciled;
}

export async function saveRetroAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get("predictionId") ?? 0);
  const notes = String(formData.get("notes") ?? "").trim();
  const tags = RETRO_TAGS.filter((t) => formData.get(`tag:${t}`) === "on");
  if (!id) return { ok: false, message: "Missing prediction reference." };
  if (tags.length === 0 && notes.length === 0) {
    return { ok: false, message: "Pick at least one cause tag or write a note." };
  }
  saveRetro(id, tags, notes);
  return { ok: true, message: "Retrospective saved. It will appear here on your next visit." };
}
