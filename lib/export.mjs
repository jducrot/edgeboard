// All picks as a CSV file, for spreadsheets or safekeeping.

import { listPredictions } from "./db.mjs";

const COLUMNS = [
  ["game_date_et", "Game date"],
  ["game_label", "Game"],
  ["pick_team", "Pick"],
  ["predicted_margin", "Predicted margin"],
  ["confidence", "Confidence (1-5)"],
  ["reasoning", "Reasoning"],
  ["line_at_prediction", "Line at pick"],
  ["final_away_score", "Final away score"],
  ["final_home_score", "Final home score"],
  ["result", "Result"],
  ["retro_notes", "Your notes"],
  ["created_at_utc", "Saved (UTC)"],
  ["updated_at_utc", "Updated (UTC)"],
];

/**
 * One CSV cell. Quotes when needed, and neutralizes text that a
 * spreadsheet would otherwise run as a formula (=, +, -, @ at the start).
 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function picksCsv() {
  const rows = listPredictions().map((p) => ({
    ...p,
    result:
      p.reconciled_at_utc === null ? "Pending" : p.pick_correct === 1 ? "Correct" : "Incorrect",
  }));
  const lines = [COLUMNS.map(([, label]) => csvCell(label)).join(",")];
  for (const r of rows) lines.push(COLUMNS.map(([key]) => csvCell(r[key])).join(","));
  // The byte-order mark makes Excel read accented names (Dončić) correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
