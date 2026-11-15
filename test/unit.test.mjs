// Fast checks of individual pieces. No server, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the app's data folder at a throwaway one before anything opens a
// database. Each test file runs in its own process, so this stays local.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "edgeboard-unit-"));
process.env.EDGEBOARD_DATA_DIR = tmp;
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const { wordmarkViolations, WORDMARK } = await import("../lib/wordmark.mjs");
const { createBuildQueue } = await import("../lib/build-queue.mjs");
const { csvCell, picksCsv } = await import("../lib/export.mjs");
const { backupPicks } = await import("../lib/backup.mjs");
const { insertPrediction, getDb } = await import("../lib/db.mjs");

test("wordmark: the exact form passes and every altered form is caught", () => {
  assert.deepEqual(wordmarkViolations(`Welcome to ${WORDMARK}.`), []);
  for (const bad of ["Edgeboard", "edgeBoard", "EDGEBOARD", "Edge Board", "edge-board", "EdgeBOARD"]) {
    assert.deepEqual(wordmarkViolations(`<p>${bad}</p>`), [bad], `should catch "${bad}"`);
  }
  assert.deepEqual(wordmarkViolations("an edge on the board"), []);
});

test("save during a refresh: the page shown includes the new pick", async () => {
  let saved = false;
  let builds = 0;
  const doBuild = async () => {
    builds++;
    const sawPick = saved;
    await new Promise((r) => setTimeout(r, 200));
    return sawPick;
  };
  const q = createBuildQueue(doBuild);
  const running = q.rebuild(); // A background refresh starts.
  await new Promise((r) => setTimeout(r, 50));
  saved = true; // A pick is saved mid-refresh.
  const first = q.rebuildAfterChange();
  const second = q.rebuildAfterChange(); // Another save in the same window.
  assert.equal(await running, false, "the running refresh started before the save");
  assert.equal(await first, true, "the save's refresh must include the pick");
  assert.equal(first, second, "two saves share one follow-up refresh");
  assert.equal(builds, 2);
});

test("save after a failed refresh still gets a refresh", async () => {
  let calls = 0;
  const q = createBuildQueue(async () => {
    calls++;
    if (calls === 1) {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("offline");
    }
    return "ok";
  });
  const failing = q.rebuild().catch(() => "failed");
  const after = q.rebuildAfterChange();
  assert.equal(await failing, "failed");
  assert.equal(await after, "ok");
});

test("CSV cells: quoting and spreadsheet formula safety", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(7), "7");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('says "hi", twice'), '"says ""hi"", twice"');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-5 pts"), "'-5 pts");
  assert.equal(csvCell("@cmd"), "'@cmd");
});

function addPick(reasoning) {
  return insertPrediction({
    gameId: "999",
    gameDateEt: "2026-11-15",
    gameLabel: "AAA @ BBB",
    pick: "home",
    pickTeam: "BBB",
    predictedMargin: 4,
    confidence: 3,
    reasoning,
    lineAtPrediction: "BBB -2.5",
    snapshotJson: "{}",
  });
}

test("CSV export: every pick, with tricky text kept intact", () => {
  addPick('Rest edge, "big" one\nand =SUM(A1) is just text');
  const csv = picksCsv();
  assert.ok(csv.startsWith("﻿Game date,Game,Pick"), "header row with byte-order mark");
  assert.ok(csv.includes('"Rest edge, ""big"" one\nand =SUM(A1) is just text"'));
  assert.ok(csv.includes("AAA @ BBB,BBB,4,3,"));
  assert.ok(csv.includes(",Pending,"));
});

test("backups: one per day, newest 14 kept, and each copy is readable", async () => {
  const dir = path.join(tmp, "backups-test");
  const day = (n) => new Date(Date.UTC(2026, 10, 1 + n, 12));
  for (let n = 0; n < 16; n++) {
    assert.ok(await backupPicks({ dir, now: day(n) }), `day ${n} writes a backup`);
  }
  assert.equal(await backupPicks({ dir, now: day(15) }), null, "a second run the same day writes nothing");
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files.length, 14);
  assert.equal(files[0], "edgeboard-picks-2026-11-03.db", "the two oldest were removed");

  const Database = (await import("better-sqlite3")).default;
  const copy = new Database(path.join(dir, files.at(-1)), { readonly: true });
  const n = copy.prepare("SELECT COUNT(*) AS n FROM predictions").get().n;
  copy.close();
  assert.equal(n, getDb().prepare("SELECT COUNT(*) AS n FROM predictions").get().n);
});
