// EdgeBoard server: serves the Eleventy output, handles the three form
// POSTs (predict, retro, refresh), and rebuilds the site when data changes.
// Built-in Node modules only.

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import Eleventy from "@11ty/eleventy";
import {
  getInjuriesByTeamId,
  getOdds,
  getRestByTeamId,
  getScoreboard,
  getTeamFormByTeamId,
  pruneCache,
  slateDateEt,
  toEtDateString,
} from "./lib/espn.mjs";
import {
  getPrediction,
  insertPrediction,
  listPredictionsForGame,
  saveRetro,
} from "./lib/db.mjs";
import { teamAnalytics } from "./lib/teamstats.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const OUT = path.resolve("_site");
// Pages rebuild on request once the last build is older than this. Nothing
// runs while nobody is looking, so an idle server makes no ESPN requests.
const STALE_AFTER_MS = Number(process.env.EDGEBOARD_STALE_MS) || 5 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------- building ------------------------------- */

let building = null;
let lastBuiltAt = 0;
let lastPrunedAt = 0;

async function rebuild() {
  // Coalesce concurrent requests into one build.
  if (building) return building;
  building = (async () => {
    const started = Date.now();
    const elev = new Eleventy("site", "_site", { quietMode: true });
    await elev.write();
    lastBuiltAt = Date.now();
    console.log(`Rebuilt in ${((lastBuiltAt - started) / 1000).toFixed(1)}s`);
  })().finally(() => {
    building = null;
  });
  return building;
}

async function prune() {
  lastPrunedAt = Date.now();
  try {
    const { fetchRemoved, summaryRemoved } = await pruneCache();
    if (fetchRemoved + summaryRemoved > 0) {
      console.log(`Cache pruned: ${fetchRemoved} expired responses, ${summaryRemoved} old summaries.`);
    }
  } catch (e) {
    console.error("Cache prune failed:", e);
  }
}

/** Called before serving a page: rebuild if stale, prune at most daily. */
async function ensureFresh() {
  if (Date.now() - lastPrunedAt > PRUNE_EVERY_MS) prune(); // Background.
  if (Date.now() - lastBuiltAt <= STALE_AFTER_MS) return;
  try {
    await rebuild();
  } catch (e) {
    // ESPN down or similar: serve the last good build rather than an error.
    console.error("Rebuild failed; serving the previous build:", e);
  }
}

/** Same-site path from the Referer header, or the home page. */
function backPath(req) {
  try {
    const ref = new URL(req.headers.referer ?? "");
    if (ref.host === req.headers.host) return ref.pathname;
  } catch {
    // Missing or malformed header.
  }
  return "/";
}

/* ------------------------------ html helpers ---------------------------- */

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function messagePage(title, body, backHref, backLabel) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | EdgeBoard</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="shell" style="padding-block:1.5rem">
<h1>${esc(title)}</h1>
<p>${esc(body)}</p>
<p><a href="${esc(backHref)}">${esc(backLabel)}</a></p>
</main>
</body>
</html>`;
}

function sendError(res, status, title, body, backHref = "/", backLabel = "Back to the slate") {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(messagePage(title, body, backHref, backLabel));
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

/* ------------------------------ body parsing ----------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return {
    get: (k) => params.get(k) ?? "",
    getAll: (k) => params.getAll(k),
  };
}

/* ------------------------------- handlers ------------------------------- */

async function handlePredict(form, res) {
  const gameId = form.get("gameId").trim();
  const slateDate = form.get("slateDate").trim();
  const pick = form.get("pick");
  const marginRaw = form.get("predictedMargin").trim();
  const confidence = Number(form.get("confidence"));
  const reasoning = form.get("reasoning").trim();
  const backHref = `/slate/${encodeURIComponent(slateDate)}/`;

  const fail = (msg) =>
    sendError(res, 400, "Prediction not saved", msg, backHref, "Back to the slate");

  if (!/^\d+$/.test(gameId) || !/^\d{8}$/.test(slateDate)) {
    return fail("Missing or invalid game reference.");
  }
  if (pick !== "home" && pick !== "away") {
    return fail("Choose which team you expect to win.");
  }
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return fail("Confidence must be between 1 and 5.");
  }
  if (reasoning.length < 10) {
    return fail(
      "Write at least a sentence of reasoning. Future you needs it for the retrospective.",
    );
  }
  let predictedMargin = null;
  if (marginRaw !== "") {
    const m = Number(marginRaw);
    if (!Number.isInteger(m) || m < 1 || m > 60) {
      return fail("Predicted margin must be a whole number between 1 and 60.");
    }
    predictedMargin = m;
  }
  if (listPredictionsForGame(gameId).length > 0) {
    return fail("You already logged a prediction for this game.");
  }

  const games = await getScoreboard(slateDate);
  const game = games.find((g) => g.id === gameId);
  if (!game) return fail("Could not find that game on the slate.");
  if (game.statusState !== "pre") {
    return fail("This game has already started. Predictions lock at tipoff.");
  }

  const [odds, form_, injuries, rest, homeStats10, awayStats10] = await Promise.all([
    getOdds(gameId),
    getTeamFormByTeamId(),
    getInjuriesByTeamId(),
    getRestByTeamId(slateDate),
    teamAnalytics(game.home.id).catch(() => null),
    teamAnalytics(game.away.id).catch(() => null),
  ]);

  const snapshot = {
    game,
    odds,
    homeForm: form_.get(game.home.id) ?? null,
    awayForm: form_.get(game.away.id) ?? null,
    homeInjuries: injuries.get(game.home.id) ?? [],
    awayInjuries: injuries.get(game.away.id) ?? [],
    homeRest: rest.get(game.home.id) ?? null,
    awayRest: rest.get(game.away.id) ?? null,
    homeStats10,
    awayStats10,
    capturedAtUtc: new Date().toISOString(),
  };

  insertPrediction({
    gameId,
    gameDateEt: toEtDateString(game.dateUtc),
    gameLabel: game.shortName,
    pick,
    pickTeam: pick === "home" ? game.home.abbreviation : game.away.abbreviation,
    predictedMargin,
    confidence,
    reasoning,
    lineAtPrediction: odds?.details ?? null,
    snapshotJson: JSON.stringify(snapshot),
  });

  await rebuild();
  redirect(res, "/review/");
}

async function handleRetro(form, res) {
  const id = Number(form.get("predictionId"));
  const notes = form.get("notes").trim();
  const fail = (msg) =>
    sendError(res, 400, "Notes not saved", msg, "/review/", "Back to the review page");

  if (!Number.isInteger(id) || id < 1 || !getPrediction(id)) {
    return fail("Missing or unknown prediction reference.");
  }
  if (notes.length === 0) {
    return fail("Write a note before saving.");
  }
  saveRetro(id, notes);
  await rebuild();
  redirect(res, "/review/");
}

/* ----------------------------- static serving ---------------------------- */

async function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(OUT, "." + rel);
  if (!file.startsWith(OUT + path.sep) && file !== OUT) {
    return sendError(res, 404, "Not found", "That page does not exist.");
  }
  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    sendError(res, 404, "Not found", "That page does not exist.");
  }
}

/* --------------------------------- server -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/") {
        return redirect(res, `/slate/${slateDateEt(0)}/`);
      }
      const isPage = url.pathname.endsWith("/") || url.pathname.endsWith(".html");
      if (isPage) await ensureFresh();
      return await serveStatic(url.pathname, res);
    }
    if (req.method === "POST") {
      const form = parseForm(await readBody(req));
      if (url.pathname === "/predict") return await handlePredict(form, res);
      if (url.pathname === "/retro") return await handleRetro(form, res);
      if (url.pathname === "/refresh") {
        await rebuild();
        return redirect(res, backPath(req));
      }
      return sendError(res, 404, "Not found", "That action does not exist.");
    }
    res.writeHead(405, { allow: "GET, HEAD, POST" });
    res.end();
  } catch (err) {
    console.error(err);
    sendError(
      res,
      500,
      "Something went wrong",
      "The server hit an unexpected error. Check the terminal output, then try again.",
    );
  }
});

await prune();
console.log("Building site…");
await rebuild();

server.listen(PORT, () => {
  console.log(`EdgeBoard running at http://localhost:${PORT}`);
  const window =
    STALE_AFTER_MS >= 60_000
      ? `${Math.round(STALE_AFTER_MS / 60_000)} minutes`
      : `${Math.round(STALE_AFTER_MS / 1000)} seconds`;
  console.log(`Pages refresh on visit when older than ${window}, or use the Refresh button.`);
});
