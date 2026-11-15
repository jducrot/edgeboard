// What happens with no internet. The app must never crash, must say
// plainly that data is not current, and must keep your picks working.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeSandbox, startServer, request, postForm, findOpenGame } from "./harness.mjs";

test("a brand-new copy started offline explains itself instead of crashing", async () => {
  // Nothing downloaded and nothing built, as on a fresh clone.
  const sandbox = await makeSandbox({ withHistory: false, emptyCache: true });
  const server = await startServer(sandbox, { offline: true });
  try {
    const slate = await request(server, "/review/");
    assert.equal(slate.status, 503);
    assert.match(slate.body, /No data yet/);
    assert.match(slate.body, /Check your internet connection/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(server.exited(), null, "the server must keep running");
  } finally {
    await server.stop();
    await sandbox.cleanup();
  }
});

test("restarting offline serves saved data with an honest notice, and picks still save", async (t) => {
  const sandbox = await makeSandbox();
  // First run online, to build pages and record when data was downloaded.
  const online = await startServer(sandbox);
  const game = await findOpenGame(online);
  await online.stop();
  const { lastOnlineAt } = JSON.parse(await fs.readFile(path.join(sandbox.data, "status.json"), "utf8"));
  assert.ok(lastOnlineAt, "the last download time is recorded");

  const offline = await startServer(sandbox, { offline: true });
  try {
    const started = Date.now();
    const page = await request(offline, "/review/");
    assert.ok(Date.now() - started < 5000, "pages from the earlier run are served promptly");
    assert.equal(page.status, 200);
    // The notice appears once the first offline refresh attempt finishes.
    let body = page.body;
    for (let i = 0; i < 100 && !body.includes("status-notice"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = (await request(offline, "/review/")).body;
    }
    assert.match(body, /<p class="status-notice"><strong>Data not current:<\/strong> ESPN could not be reached/);
    assert.match(body, /You are seeing data last downloaded /);
    assert.match(body, /Data from ESPN public APIs, last downloaded /);
    assert.equal(offline.exited(), null);

    if (!game) return t.skip("no open game to test an offline save with");
    const saved = await postForm(offline, "/predict", {
      gameId: game.gameId,
      slateDate: game.slateDate,
      pick: "away",
      predictedMargin: "3",
      confidence: "2",
      reasoning: "Offline test: saved with no internet",
    });
    assert.equal(saved.status, 303, `offline save failed: ${saved.body.slice(0, 300)}`);
    const card = await request(offline, game.path);
    assert.match(card.body, new RegExp(`id="pick-${game.gameId}"`), "the saved pick appears on its card");
  } finally {
    await offline.stop();
    await sandbox.cleanup();
  }
});
