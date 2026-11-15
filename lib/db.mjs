// SQLite storage for predictions, snapshots, and retrospectives.
// Schema is identical to the 0.1 (Next.js) version, so an existing
// data/edgeboard.db keeps working across the rebuild.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "edgeboard.db");

export const RETRO_TAGS = [
  "In-game injury",
  "Lineup or rotation change",
  "Signal we were not tracking",
  "Variance / fluke",
  "Market was right",
  "My read was right",
];

let db = null;

export function getDb() {
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
  const cols = db.prepare("PRAGMA table_info(predictions)").all().map((c) => c.name);
  if (!cols.includes("auto_retro")) {
    db.exec("ALTER TABLE predictions ADD COLUMN auto_retro TEXT");
  }
  return db;
}

export function saveAutoRetro(id, text) {
  getDb().prepare(`UPDATE predictions SET auto_retro = ? WHERE id = ?`).run(text, id);
}

export function insertPrediction(p) {
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

export function listPredictions() {
  return getDb()
    .prepare(`SELECT * FROM predictions ORDER BY game_date_et DESC, id DESC`)
    .all();
}

export function listPredictionsForGame(gameId) {
  return getDb()
    .prepare(`SELECT * FROM predictions WHERE game_id = ? ORDER BY id DESC`)
    .all(gameId);
}

export function listUnreconciled() {
  return getDb()
    .prepare(`SELECT * FROM predictions WHERE reconciled_at_utc IS NULL`)
    .all();
}

export function getPrediction(id) {
  return getDb().prepare(`SELECT * FROM predictions WHERE id = ?`).get(id);
}

export function reconcilePrediction(id, finalHomeScore, finalAwayScore, pickCorrect) {
  getDb()
    .prepare(
      `UPDATE predictions
       SET final_home_score = ?, final_away_score = ?, pick_correct = ?, reconciled_at_utc = ?
       WHERE id = ?`,
    )
    .run(finalHomeScore, finalAwayScore, pickCorrect ? 1 : 0, new Date().toISOString(), id);
}

export function saveRetro(id, notes) {
  getDb()
    .prepare(`UPDATE predictions SET retro_notes = ?, retro_at_utc = ? WHERE id = ?`)
    .run(notes, new Date().toISOString(), id);
}
