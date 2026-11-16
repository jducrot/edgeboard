// Picks saved on one computer show up on the other, through a shared git
// repository. Two throwaway copies of EdgeBoard stand in for the Mac and
// the PC, and a local bare repository stands in for the private GitHub one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeSandbox, startServer, request, postForm, findOpenGame } from "./harness.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const rows = (sandbox, gameId) => {
  const db = new Database(path.join(sandbox.data, "edgeboard.db"));
  try {
    return db.prepare("SELECT id, uid, pick, reasoning FROM predictions WHERE game_id = ?").all(gameId);
  } finally {
    db.close();
  }
};

test("a pick saved on one computer appears on the other, and updates flow back", async (t) => {
  try {
    git("--version");
  } catch {
    return t.skip("git is not installed");
  }
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "edgeboard-remote-"));
  const remote = path.join(remoteDir, "picks.git");
  git("init", "--bare", "--quiet", remote);
  const mac = await makeSandbox();
  const pc = await makeSandbox();
  for (const s of [mac, pc]) git("clone", "--quiet", remote, path.join(s.data, "sync"));
  let macServer;
  let pcServer;
  try {
    macServer = await startServer(mac);
    const game = await findOpenGame(macServer);
    if (!game) return t.skip("no games open for picks on the current slates");
    const saved = await postForm(macServer, "/predict", {
      gameId: game.gameId,
      slateDate: game.slateDate,
      pick: "home",
      confidence: "3",
      reasoning: "Saved on the Mac",
    });
    assert.equal(saved.status, 303);
    assert.match(git("--git-dir", remote, "log", "--oneline", "main"), /Picks: 1 saved or changed/, "the pick was pushed");
    const [onMac] = rows(mac, game.gameId);

    // The PC starts the next day and finds it.
    pcServer = await startServer(pc);
    const review = await request(pcServer, "/review/");
    assert.match(review.body, /Saved on the Mac/, "the Review page on the PC shows the Mac's pick");
    const [onPc] = rows(pc, game.gameId);
    assert.equal(onPc.uid, onMac.uid, "the same pick, not a copy");

    // Updated on the PC, then seen on the Mac after its next refresh.
    const updated = await postForm(pcServer, "/predict/update", {
      predictionId: String(onPc.id),
      gameId: game.gameId,
      slateDate: game.slateDate,
      pick: "away",
      confidence: "4",
      reasoning: "Changed my mind on the PC",
    });
    assert.equal(updated.status, 303, updated.body.slice(0, 300));
    assert.equal((await postForm(macServer, "/refresh", {})).status, 303);
    const [after] = rows(mac, game.gameId);
    assert.deepEqual([after.pick, after.reasoning], ["away", "Changed my mind on the PC"]);
    assert.equal(rows(mac, game.gameId).length, 1, "still one pick for the game");
  } finally {
    await macServer?.stop();
    await pcServer?.stop();
    await mac.cleanup();
    await pc.cleanup();
    await fs.rm(remoteDir, { recursive: true, force: true });
  }
});
