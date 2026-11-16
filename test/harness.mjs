// Shared test helpers. Every test server runs the real app against a
// throwaway data folder and output folder, never the real picks.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..");

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A temporary data and output folder, with a copy of lineup history if one exists. */
export async function makeSandbox({ withHistory = true, emptyCache = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edgeboard-test-"));
  const data = path.join(dir, "data");
  const out = path.join(dir, "site");
  await fs.mkdir(data, { recursive: true });
  if (withHistory) {
    await fs.copyFile(path.join(ROOT, "data", "history.db"), path.join(data, "history.db")).catch(() => {});
  }
  const cache = emptyCache ? path.join(dir, "cache") : null;
  return { dir, data, out, cache, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function waitFor(check, timeoutMs, describe) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting: ${describe()}`);
}

/**
 * Start the app on a free port against a sandbox. `offline` makes every
 * network request fail, `failUrls` (a pattern) fails only those, and
 * `slowUrls` makes those answer 2 seconds late. Started from the system temp folder on purpose:
 * the app must work no matter which folder it is started from.
 */
export async function startServer(sandbox, { offline = false, failUrls = null, slowUrls = null } = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    EDGEBOARD_DATA_DIR: sandbox.data,
    EDGEBOARD_OUT_DIR: sandbox.out,
    EDGEBOARD_NO_HISTORY_SYNC: "1",
  };
  if (sandbox.cache) env.EDGEBOARD_CACHE_DIR = sandbox.cache;
  if (failUrls) env.EDGEBOARD_TEST_FAIL_URLS = failUrls;
  if (slowUrls) env.EDGEBOARD_TEST_SLOW_URLS = slowUrls;
  if (offline || failUrls || slowUrls) {
    const preload = pathToFileURL(path.join(ROOT, "test", "offline-preload.mjs")).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${preload}`.trim();
  }
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: os.tmpdir(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  await waitFor(
    () => log.includes("EdgeBoard running at") || exited,
    180_000,
    () => `server start. Log so far:\n${log}`,
  );
  if (exited) throw new Error(`Server exited (${JSON.stringify(exited)}). Log:\n${log}`);
  return {
    port,
    base: `http://localhost:${port}`,
    log: () => log,
    exited: () => exited,
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve();
        child.once("exit", resolve);
        child.kill();
      }),
  };
}

/**
 * Start the app expecting it to stop on its own (for startup errors).
 * Returns its exit code and everything it printed.
 */
export async function runUntilExit(sandbox, { port, env = {}, timeoutMs = 30_000 } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PORT: String(port ?? (await freePort())),
      EDGEBOARD_DATA_DIR: sandbox.data,
      EDGEBOARD_OUT_DIR: sandbox.out,
      EDGEBOARD_NO_HISTORY_SYNC: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("did not exit");
    }, timeoutMs);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return { code, log };
}

/** True when output contains a JavaScript stack trace. */
export const hasStackTrace = (text) => /^\s+at .+\(.+:\d+:\d+\)$/m.test(text);

/** A raw HTTP request to the test server (bypasses any proxy settings). */
export function request(server, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: pathname,
        method,
        headers: { host: `localhost:${server.port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Submit a form the way the app's own pages do. */
export function postForm(server, pathname, fields, headers = { "sec-fetch-site": "same-origin" }) {
  return request(server, pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Every slate page the date navigation links to (yesterday, today, tomorrow). */
export async function slatePaths(server) {
  const first = await request(server, "/");
  const home = first.headers.location ?? "/";
  const page = await request(server, new URL(home, "http://x").pathname);
  const paths = [...page.body.matchAll(/href="(\/slate\/\d{8}\/)"/g)].map((m) => m[1]);
  return [...new Set(paths)];
}

/** A game still open for a pick, or null on a day with none. */
export async function findOpenGame(server) {
  for (const p of await slatePaths(server)) {
    const { body } = await request(server, p);
    const m = body.match(/action="\/predict" class="predict-form">\s*<input type="hidden" name="gameId" value="(\d+)">\s*<input type="hidden" name="slateDate" value="(\d{8})">/);
    if (m) return { gameId: m[1], slateDate: m[2], path: p };
  }
  return null;
}
