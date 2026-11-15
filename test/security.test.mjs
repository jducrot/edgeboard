// Security and data checks against a real running server in a sandbox.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { makeSandbox, startServer, request, postForm, slatePaths, findOpenGame } from "./harness.mjs";
import { wordmarkViolations } from "../lib/wordmark.mjs";

let sandbox;
let server;

before(async () => {
  sandbox = await makeSandbox();
  server = await startServer(sandbox);
});

after(async () => {
  await server?.stop();
  await sandbox?.cleanup();
});

test("only this computer can connect", async (t) => {
  const outward = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  if (outward.length === 0) return t.skip("this machine has no network address to test from");
  for (const address of outward) {
    const refused = await new Promise((resolve) => {
      const s = net.connect({ host: address, port: server.port, timeout: 2000 });
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
      s.on("timeout", () => {
        s.destroy();
        resolve(true);
      });
    });
    assert.ok(refused, `the app must not answer on ${address}`);
  }
});

test("requests addressed to another host are refused", async () => {
  const res = await request(server, "/review/", { headers: { host: "attacker.example" } });
  assert.equal(res.status, 403);
});

test("forms from other websites are refused; the app's own are accepted", async () => {
  const forged = [
    {},
    { origin: "https://evil.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { referer: "https://evil.example/page" },
  ];
  for (const headers of forged) {
    const res = await postForm(server, "/refresh", {}, headers);
    assert.equal(res.status, 403, `should refuse ${JSON.stringify(headers)}`);
  }
  const own = await postForm(server, "/refresh", {}, { "sec-fetch-site": "same-origin" });
  assert.equal(own.status, 303);
  const ownByOrigin = await postForm(server, "/refresh", {}, { origin: `http://localhost:${server.port}` });
  assert.equal(ownByOrigin.status, 303);
});

test("browser safety rules are sent with every response", async () => {
  for (const p of ["/review/", "/insights/", "/styles.css", "/export.csv", "/no-such-page/"]) {
    const { headers } = await request(server, p);
    assert.match(headers["content-security-policy"] ?? "", /default-src 'none'/, p);
    assert.match(headers["content-security-policy"] ?? "", /frame-ancestors 'none'/, p);
    assert.equal(headers["x-frame-options"], "DENY", p);
    assert.equal(headers["x-content-type-options"], "nosniff", p);
  }
});

test("a malformed address gets a clean error, not a crash", async () => {
  const res = await request(server, "/%E0%A4%A");
  assert.equal(res.status, 400);
  assert.equal((await request(server, "/insights/")).status, 200, "server still up");
});

test("text you type is shown as text, never run as code", async (t) => {
  const game = await findOpenGame(server);
  if (!game) return t.skip("no games open for picks on the current slates");
  const probe = 'Probe <script>alert(1)</script><img src=x onerror=alert(2)> "q" & done';
  const saved = await postForm(server, "/predict", {
    gameId: game.gameId,
    slateDate: game.slateDate,
    pick: "home",
    predictedMargin: "",
    confidence: "3",
    reasoning: probe,
  });
  assert.equal(saved.status, 303);
  assert.match(saved.headers.location, new RegExp(`#pick-${game.gameId}$`), "returns to the game's card");
  for (const p of [game.path, "/review/"]) {
    const { body } = await request(server, p);
    assert.ok(!body.includes("<script>alert"), `raw script tag on ${p}`);
    assert.ok(!body.includes("<img src=x"), `raw image tag on ${p}`);
    assert.ok(body.includes("Probe &lt;script&gt;alert(1)&lt;/script&gt;"), `escaped text on ${p}`);
  }
  const csv = await request(server, "/export.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"], /^text\/csv/);
  assert.match(csv.headers["content-disposition"], /attachment; filename="edgeboard-picks-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.ok(csv.body.includes("Probe <script>"), "the CSV keeps your exact text");
});

test("your picks are backed up when the app starts", async () => {
  const dir = path.join(sandbox.data, "backups");
  let files = [];
  for (let i = 0; i < 50 && files.length === 0; i++) {
    files = await fs.readdir(dir).catch(() => []);
    if (files.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(files.length, 1);
  assert.match(files[0], /^edgeboard-picks-\d{4}-\d{2}-\d{2}\.db$/);
});

test("the wordmark is exact on every page", async () => {
  for (const p of [...(await slatePaths(server)), "/review/", "/insights/"]) {
    const { body } = await request(server, p);
    assert.deepEqual(wordmarkViolations(body), [], p);
  }
});
