// SQLite storage for predictions, snapshots, and retrospectives.
// Local file database for the MVP; the schema ports to Turso/Postgres for deploy.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { PickSide, PredictionRow } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "edgeboard.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      game_date_et TEXT NOT NULL,
      game_label TEXT NOT NULL,
      pick TEXT NOT NULL CHECK (pick IN ('home', 'away')),
      pick_team TEXT NOT NULL,
      predicted_margin INTEGER,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 5),
      reasoning TEXT NOT NULL,
      line_at_prediction TEXT,
      snapshot_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      final_home_score INTEGER,
      final_away_score INTEGER,
      pick_correct INTEGER,
      reconciled_at_utc TEXT,
      retro_tags TEXT,
      retro_notes TEXT,
      retro_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_game ON predictions (game_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_date ON predictions (game_date_et);
  `);
  return db;
}

function rowToPrediction(r: Record<string, unknown>): PredictionRow {
  return {
    id: r.id as number,
    gameId: r.game_id as string,
    gameDateEt: r.game_date_et as string,
    gameLabel: r.game_label as string,
    pick: r.pick as PickSide,
    pickTeam: r.pick_team as string,
    predictedMargin: r.predicted_margin as number | null,
    confidence: r.confidence as number,
    reasoning: r.reasoning as string,
    lineAtPrediction: r.line_at_prediction as string | null,
    snapshotJson: r.snapshot_json as string,
    createdAtUtc: r.created_at_utc as string,
    finalHomeScore: r.final_home_score as number | null,
    finalAwayScore: r.final_away_score as number | null,
    pickCorrect: r.pick_correct as number | null,
    reconciledAtUtc: r.reconciled_at_utc as string | null,
    retroTags: r.retro_tags as string | null,
    retroNotes: r.retro_notes as string | null,
    retroAtUtc: r.retro_at_utc as string | null,
  };
}

export function insertPrediction(p: {
  gameId: string;
  gameDateEt: string;
  gameLabel: string;
  pick: PickSide;
  pickTeam: string;
  predictedMargin: number | null;
  confidence: number;
  reasoning: string;
  lineAtPrediction: string | null;
  snapshotJson: string;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO predictions
       (game_id, game_date_et, game_label, pick, pick_team, predicted_margin,
        confidence, reasoning, line_at_prediction, snapshot_json, created_at_utc)
       VALUES (@gameId, @gameDateEt, @gameLabel, @pick, @pickTeam, @predictedMargin,
        @confidence, @reasoning, @lineAtPrediction, @snapshotJson, @createdAtUtc)`,
    )
    .run({ ...p, createdAtUtc: new Date().toISOString() });
  return Number(res.lastInsertRowid);
}

export function listPredictions(): PredictionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM predictions ORDER BY game_date_et DESC, id DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToPrediction);
}

export function listPredictionsForGame(gameId: string): PredictionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM predictions WHERE game_id = ? ORDER BY id DESC`)
    .all(gameId) as Record<string, unknown>[];
  return rows.map(rowToPrediction);
}

export function listUnreconciled(): PredictionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM predictions WHERE reconciled_at_utc IS NULL`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToPrediction);
}

export function reconcilePrediction(
  id: number,
  finalHomeScore: number,
  finalAwayScore: number,
  pickCorrect: boolean,
): void {
  getDb()
    .prepare(
      `UPDATE predictions
       SET final_home_score = ?, final_away_score = ?, pick_correct = ?, reconciled_at_utc = ?
       WHERE id = ?`,
    )
    .run(finalHomeScore, finalAwayScore, pickCorrect ? 1 : 0, new Date().toISOString(), id);
}

export function saveRetro(id: number, tags: string[], notes: string): void {
  getDb()
    .prepare(
      `UPDATE predictions SET retro_tags = ?, retro_notes = ?, retro_at_utc = ? WHERE id = ?`,
    )
    .run(JSON.stringify(tags), notes, new Date().toISOString(), id);
}
