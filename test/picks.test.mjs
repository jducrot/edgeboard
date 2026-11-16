// Saving picks must be reliable: one pick per game however the button is
// pressed, and a pick still saves when part of ESPN is down.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { makeSandbox, startServer, postForm, findOpenGame } from "./harness.mjs";

let sandbox;
let game;

const picksFor = (gameId) => {
  const db = new Database(path.join(sandbox.data, "edgeboard.db"));
  try {
    return db.prepare("SELECT * FROM predictions WHERE game_id = ?").all(gameId);
  } finally {
    db.close();
  }
};
const deletePicks = (gameId) => {
  const db = new Database(path.join(sandbox.data, "edgeboard.db"));
  db.prepare("DELETE FROM predictions WHERE game_id = ?").run(gameId);
  db.close();
};
const pickForm = (reasoning) => ({
  gameId: game.gameId,
  slateDate: game.slateDate,
  pick: "home",
  predictedMargin: "4",
  confidence: "3",
  reasoning,
});

before(async () => {
  sandbox = await makeSandbox({ emptyCache: true });
});
after(async () => {
  await sandbox?.cleanup();
});

test("a double-clicked save stores one pick, and both clicks land on the card", async (t) => {
  const first = await startServer(sandbox);
  game = await findOpenGame(first);
  await first.stop();
  if (!game) return t.skip("no games open for picks on the current slates");
  // A fresh server with nothing cached and slow odds, so saving has to wait
  // on ESPN: the moment a second click can slip in.
  await fs.rm(sandbox.cache, { recursive: true, force: true });
  const server = await startServer(sandbox, { slowUrls: "/odds" });
  try {
    const form = pickForm("Double click test");
    const [a, b] = await Promise.all([postForm(server, "/predict", form), postForm(server, "/predict", form)]);
    assert.deepEqual([a.status, b.status], [303, 303], `${a.body.slice(0, 200)} ${b.body.slice(0, 200)}`);
    assert.equal(picksFor(game.gameId).length, 1, "exactly one pick saved");
    // A different pick for the same game is still refused.
    const other = await postForm(server, "/predict", { ...form, pick: "away", reasoning: "A second opinion" });
    assert.equal(other.status, 400);
    assert.match(other.body, /You already have a pick for this game/);
    assert.equal(picksFor(game.gameId).length, 1);
  } finally {
    await server.stop();
  }
});

test("a pick still saves when the injury report and standings cannot be downloaded", async (t) => {
  if (!game) return t.skip("no games open for picks on the current slates");
  deletePicks(game.gameId);
  // Nothing saved to fall back on, and those two downloads fail.
  await fs.rm(sandbox.cache, { recursive: true, force: true });
  const server = await startServer(sandbox, { failUrls: "/injuries|/standings" });
  try {
    const saved = await postForm(server, "/predict", pickForm("Saved while ESPN injuries were down"));
    assert.equal(saved.status, 303, `not saved: ${saved.body.slice(0, 300)}`);
    const [row] = picksFor(game.gameId);
    assert.ok(row, "the pick is in the database");
    const snap = JSON.parse(row.snapshot_json);
    assert.deepEqual(snap.homeInjuries, [], "the missing injury report is recorded as empty");
    assert.equal(snap.homeForm, null, "the missing standings are recorded as unknown");
  } finally {
    await server.stop();
  }
});
