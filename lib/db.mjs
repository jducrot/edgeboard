// SQLite storage for predictions, snapshots, and retrospectives.
// Schema is identical to the 0.1 (Next.js) version, so an existing
// data/edgeboard.db keeps working across the rebuild.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import { DATA_DIR } from "./paths.mjs";
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
  if (!cols.includes("retro_gen")) {
    db.exec("ALTER TABLE predictions ADD COLUMN retro_gen INTEGER DEFAULT 0");
  }
  if (!cols.includes("updated_at_utc")) {
    db.exec("ALTER TABLE predictions ADD COLUMN updated_at_utc TEXT");
  }
  // A permanent id shared by every computer, for syncing picks. Row ids
  // differ from computer to computer, so they cannot be used.
  if (!cols.includes("uid")) {
    db.exec("ALTER TABLE predictions ADD COLUMN uid TEXT");
  }
  if (!cols.includes("sync_note")) {
    db.exec("ALTER TABLE predictions ADD COLUMN sync_note TEXT");
  }
  for (const { id } of db.prepare("SELECT id FROM predictions WHERE uid IS NULL").all()) {
    db.prepare("UPDATE predictions SET uid = ? WHERE id = ?").run(randomUUID(), id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_uid ON predictions (uid)");
  return db;
}

/**
 * Revise a pick before tip-off. The snapshot is replaced too: it records
 * what was known at the latest decision, which is what the retrospective
 * and the "changed since your pick" checks should measure against.
 */
export function updatePrediction(id, p) {
  getDb()
    .prepare(
      `UPDATE predictions
       SET pick = @pick, pick_team = @pickTeam, predicted_margin = @predictedMargin,
           confidence = @confidence, reasoning = @reasoning,
           line_at_prediction = @lineAtPrediction, snapshot_json = @snapshotJson,
           updated_at_utc = @updatedAtUtc
       WHERE id = @id AND reconciled_at_utc IS NULL`,
    )
    .run({ ...p, id, updatedAtUtc: new Date().toISOString() });
}

export function saveAutoRetro(id, text, gen) {
  getDb()
    .prepare(`UPDATE predictions SET auto_retro = ?, retro_gen = ? WHERE id = ?`)
    .run(text, gen, id);
}

export function insertPrediction(p) {
  const res = getDb()
    .prepare(
      `INSERT INTO predictions
       (uid, game_id, game_date_et, game_label, pick, pick_team, predicted_margin,
        confidence, reasoning, line_at_prediction, snapshot_json, created_at_utc)
       VALUES (@uid, @gameId, @gameDateEt, @gameLabel, @pick, @pickTeam, @predictedMargin,
        @confidence, @reasoning, @lineAtPrediction, @snapshotJson, @createdAtUtc)`,
    )
    .run({ ...p, uid: randomUUID(), createdAtUtc: new Date().toISOString() });
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

/* --------------------- syncing between computers ---------------------- */

/** Add a pick saved on another computer. */
export function importPrediction(r) {
  getDb()
    .prepare(
      `INSERT INTO predictions
       (uid, game_id, game_date_et, game_label, pick, pick_team, predicted_margin, confidence,
        reasoning, line_at_prediction, snapshot_json, created_at_utc, updated_at_utc,
        retro_tags, retro_notes, retro_at_utc)
       VALUES (@uid, @gameId, @gameDateEt, @gameLabel, @pick, @pickTeam, @predictedMargin, @confidence,
        @reasoning, @lineAtPrediction, @snapshotJson, @createdAtUtc, @updatedAtUtc,
        @retroTags, @retroNotes, @retroAtUtc)`,
    )
    .run(r);
}

/**
 * Overwrite a local pick with the version from another computer. If the
 * picked side changed, the grade is cleared so it is graded again.
 */
export function applyRemotePrediction(id, r) {
  const d = getDb();
  const before = d.prepare("SELECT pick FROM predictions WHERE id = ?").get(id);
  d.prepare(
    `UPDATE predictions
     SET uid = @uid, game_id = @gameId, game_date_et = @gameDateEt, game_label = @gameLabel,
         pick = @pick, pick_team = @pickTeam, predicted_margin = @predictedMargin,
         confidence = @confidence, reasoning = @reasoning, line_at_prediction = @lineAtPrediction,
         snapshot_json = @snapshotJson, created_at_utc = @createdAtUtc, updated_at_utc = @updatedAtUtc,
         retro_tags = @retroTags, retro_notes = @retroNotes, retro_at_utc = @retroAtUtc
     WHERE id = @id`,
  ).run({ ...r, id });
  if (before && before.pick !== r.pick) {
    d.prepare(
      `UPDATE predictions SET final_home_score = NULL, final_away_score = NULL, pick_correct = NULL,
         reconciled_at_utc = NULL, auto_retro = NULL WHERE id = ?`,
    ).run(id);
  }
}

export function setSyncNote(id, note) {
  getDb().prepare("UPDATE predictions SET sync_note = ? WHERE id = ?").run(note, id);
}
