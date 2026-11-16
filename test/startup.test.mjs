// Startup problems must end in a plain explanation, never a crash dump.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeSandbox, startServer, runUntilExit, hasStackTrace } from "./harness.mjs";

test("too-old Node: stops before anything loads, with the fix spelled out", async () => {
  const sandbox = await makeSandbox({ withHistory: false });
  try {
    const { code, log } = await runUntilExit(sandbox, { env: { EDGEBOARD_MIN_NODE: "99" } });
    assert.equal(code, 1);
    assert.match(log, /EdgeBoard needs Node 99 or newer/);
    assert.match(log, /npm install/);
    assert.doesNotMatch(log, /EdgeBoard running/);
    assert.ok(!hasStackTrace(log), log);
    // Nothing ran: not even the daily backup.
    assert.deepEqual(await fs.readdir(sandbox.data), []);
  } finally {
    await sandbox.cleanup();
  }
});

test("second copy on the same port: stops at once with a plain message", async () => {
  const sandbox = await makeSandbox({ withHistory: false });
  const first = await startServer(sandbox, { offline: true });
  const second = await makeSandbox({ withHistory: false });
  try {
    const { code, log } = await runUntilExit(second, { port: first.port });
    assert.equal(code, 1);
    assert.match(log, new RegExp(`Port ${first.port} is already in use`));
    assert.match(log, /PORT=\d+ npm run dev/);
    assert.match(log, /\$env:PORT=\d+; npm run dev/);
    assert.ok(!hasStackTrace(log), log);
    assert.equal(first.exited(), null, "the first copy keeps running");
    // It stopped before doing any work: no pages, no backup.
    await assert.rejects(fs.access(path.join(second.out, "review", "index.html")));
    assert.deepEqual(await fs.readdir(second.data), []);
  } finally {
    await first.stop();
    await sandbox.cleanup();
    await second.cleanup();
  }
});

test("a mistyped PORT: stops with a plain message instead of picking a random port", async () => {
  const sandbox = await makeSandbox({ withHistory: false });
  try {
    const { code, log } = await runUntilExit(sandbox, { port: "300O" });
    assert.equal(code, 1);
    assert.match(log, /PORT must be a whole number from 1 to 65535, but it is set to "300O"/);
    assert.ok(!hasStackTrace(log), log);
    assert.deepEqual(await fs.readdir(sandbox.data), []);
  } finally {
    await sandbox.cleanup();
  }
});
