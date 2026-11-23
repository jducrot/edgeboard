// EdgeBoard server: serves the Eleventy output, handles the form POSTs
// (predict, predict/update, retro, refresh), and rebuilds the site when data changes.
// Built-in Node modules only.

// Must stay the first import: it stops the app on an unsupported Node
// version before the database driver loads and can crash.
import "./scripts/check-node.mjs";
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
  picksOpen,
  pruneCache,
  slateDateEt,
  toEtDateString,
} from "./lib/espn.mjs";
import {
  getPrediction,
  insertPrediction,
  listPredictionsForGame,
  saveRetro,
  updatePrediction,
} from "./lib/db.mjs";
import { teamAnalytics } from "./lib/teamstats.mjs";
import { teamStarters } from "./lib/starters.mjs";
import { reconcileStartersAndInjuries } from "./lib/lineup.mjs";
import { syncHistory } from "./lib/history.mjs";
import { createBuildQueue } from "./lib/build-queue.mjs";
import { backupPicks } from "./lib/backup.mjs";
import { picksCsv } from "./lib/export.mjs";
import { CACHE_DIR, DATA_DIR, OUT_DIR, ROOT } from "./lib/paths.mjs";
import { syncPicks } from "./lib/picksync.mjs";
import { openBrowser } from "./lib/open-browser.mjs";

// Eleventy finds its config and the site folder relative to the current
// folder, so work from the app's own folder wherever it was started from.
process.chdir(ROOT);

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PORT must be a whole number from 1 to 65535, but it is set to "${process.env.PORT}".`);
  process.exit(1);
}
// Only this computer can reach the app. Set HOST (and EDGEBOARD_ALLOWED_HOSTS)
// only if you deliberately want other devices on your network to reach it.
const HOST = process.env.HOST || "127.0.0.1";
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.EDGEBOARD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);
const OUT = OUT_DIR;
const STATUS_FILE = path.join(DATA_DIR, "status.json");
// Earlier versions kept the status in the download cache.
const OLD_STATUS_FILE = path.join(CACHE_DIR, "edgeboard-status.json");
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
// EDGEBOARD_DEBUG=1 prints the page builder's full technical output.
const DEBUG = process.env.EDGEBOARD_DEBUG === "1";
// For tests and development: skip the lineup-history download.
const HISTORY_SYNC_ENABLED = process.env.EDGEBOARD_NO_HISTORY_SYNC !== "1";
// Pages rebuild on request once the last build is older than this. Nothing
// runs while nobody is looking, so an idle server makes no ESPN requests.
const STALE_AFTER_MS = Number(process.env.EDGEBOARD_STALE_MS) || 5 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const HISTORY_SYNC_EVERY_MS = 60 * 60 * 1000;
// While ESPN is unreachable, try again at most this often.
const OFFLINE_RETRY_MS = 60 * 1000;
// How long a page request waits for a refresh in progress before showing
// the pages already built.
const WAIT_FOR_BUILD_MS = 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------- building ------------------------------- */

let lastBuiltAt = 0;
let lastBackupAt = 0;
let lastPrunedAt = 0;

// Connection status, kept across restarts so the footer can say when data
// was last really downloaded, even if the app starts offline.
const status = {
  offline: false, // The last attempt could not reach ESPN.
  lastAttemptAt: 0,
  lastOnlineAt: null, // ISO time of the last successful contact with ESPN.
  buildFailed: false, // The last build threw; older pages are being shown.
};
for (const file of [STATUS_FILE, OLD_STATUS_FILE]) {
  try {
    status.lastOnlineAt = JSON.parse(await fs.readFile(file, "utf8")).lastOnlineAt ?? null;
    break;
  } catch {
    // First run, or not saved here.
  }
}

async function saveStatus() {
  try {
    await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true });
    await fs.writeFile(STATUS_FILE, JSON.stringify({ lastOnlineAt: status.lastOnlineAt }));
  } catch {
    // Not critical.
  }
}

/** A quick check that ESPN answers, so pages can say honestly when it does not. */
async function espnReachable() {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${slateDateEt(0)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function doBuild() {
  status.lastAttemptAt = Date.now();
  const online = await espnReachable();
  status.offline = !online;
  if (online) {
    status.lastOnlineAt = new Date().toISOString();
    saveStatus();
  }
  // Read by site/_data/meta.js for the footer.
  globalThis.edgeboardStatus = { offline: status.offline, lastOnlineAt: status.lastOnlineAt };

  // Picks from your other computer come in before the pages are built, and
  // picks saved here go out. Does nothing unless data/sync is set up.
  const synced = await syncPicks({ online });
  if (synced?.imported) console.log(`Pick sync: ${synced.imported} ${synced.imported === 1 ? "pick" : "picks"} from your other computer.`);

  // Offline, the build still runs: expired cached data is used where it
  // exists, and the page notice says so.
  const started = Date.now();
  const builderOutput = [];
  const capture = (...parts) => builderOutput.push(parts.join(" "));
  let built = false;
  try {
    const elev = new Eleventy("site", OUT, { quietMode: true });
    elev.logger.overrideLogger({ log: capture, info: capture, warn: capture, error: capture, debug: capture });
    await elev.write();
    built = true;
  } catch (e) {
    status.buildFailed = true;
    if (DEBUG) console.error(builderOutput.join("\n"));
    throw e;
  } finally {
    if (DEBUG && built) console.log(builderOutput.join("\n"));
  }
  status.buildFailed = false;
  lastBuiltAt = Date.now();
  console.log(
    `Rebuilt in ${((lastBuiltAt - started) / 1000).toFixed(1)}s${status.offline ? " (offline: using saved data)" : ""}`,
  );
  // Clean the cache only after a build with live data, never before one:
  // offline, those old files are what keeps the app working.
  if (online && Date.now() - lastPrunedAt > PRUNE_EVERY_MS) prune();
}

/** One plain sentence about why a refresh failed. */
function plainReason(e) {
  if (status.offline) return "ESPN could not be reached";
  return String(e?.message ?? e).split("\n")[0].slice(0, 160);
}

const DEBUG_HINT = DEBUG ? "" : " (Set EDGEBOARD_DEBUG=1 for technical details.)";

function logRefreshFailure(e) {
  console.error(
    `Refresh failed: ${plainReason(e)}. Showing the last pages built; it will try again on your next page load.${status.offline ? "" : DEBUG_HINT}`,
  );
  if (DEBUG) console.error(e);
}

const builds = createBuildQueue(doBuild);
const { rebuild, rebuildAfterChange } = builds;

/** Back up the picks once a day; never blocks a page. */
function backupInBackground() {
  lastBackupAt = Date.now();
  backupPicks()
    .then((file) => {
      if (file) console.log(`Backed up your picks to ${path.relative(ROOT, file)}`);
    })
    .catch((e) => console.error("Backup failed:", e.message ?? e));
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

let lastHistorySyncAt = 0;

/**
 * Keep lineup history current, in the background: the first run fills in
 * last season (under a minute); later runs fetch only new games. Pages
 * rebuild when new games land, so cohesion appears without a restart.
 */
function syncHistoryInBackground() {
  lastHistorySyncAt = Date.now();
  if (!HISTORY_SYNC_ENABLED) return;
  syncHistory({ log: (m) => console.log(m) })
    .then(async ({ fetched, failed }) => {
      if (failed > 0) console.log(`Lineup history: ${failed} games will retry on the next sync.`);
      if (fetched > 0) await rebuildAfterChange();
    })
    .catch((e) =>
      console.error(
        `Lineup history could not update (${status.offline ? "ESPN could not be reached" : String(e?.message ?? e).split("\n")[0]}). It will try again within the hour.`,
      ),
    );
}

const pagesExist = () =>
  fs.access(path.join(OUT, "review", "index.html")).then(() => true, () => false);

/** Before serving a page: refresh if stale, without leaving the tab blank. */
async function ensureFresh() {
  if (Date.now() - lastBackupAt > BACKUP_EVERY_MS) backupInBackground();
  if (!status.offline && Date.now() - lastHistorySyncAt > HISTORY_SYNC_EVERY_MS) {
    syncHistoryInBackground();
  }
  const stale = Date.now() - lastBuiltAt > STALE_AFTER_MS;
  const retryTooSoon =
    (status.offline || status.buildFailed) && Date.now() - status.lastAttemptAt < OFFLINE_RETRY_MS;
  if (!builds.current() && (!stale || retryTooSoon)) return;

  const build = (builds.current() ?? rebuild()).catch((e) => {
    console.error("Refresh failed; showing the last pages built:", e.message ?? e);
  });
  if (await pagesExist()) {
    await Promise.race([build, new Promise((r) => setTimeout(r, WAIT_FOR_BUILD_MS))]);
  } else {
    await build;
  }
}

function fmtEtTime(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** A plain-text notice at the top of every page while data cannot refresh. */
function statusNotice() {
  if (!status.offline && !status.buildFailed) return null;
  const tried = fmtEtTime(new Date(status.lastAttemptAt).toISOString());
  const reason = status.offline ? "ESPN could not be reached" : "The latest refresh failed";
  const asOf = status.lastOnlineAt
    ? `You are seeing data last downloaded ${fmtEtTime(status.lastOnlineAt)} ET.`
    : "You are seeing the most recent data saved on this computer.";
  return `${reason} (last tried ${tried} ET). ${asOf} It will try again when you load a page, at most once a minute.`;
}

/**
 * Only answer requests addressed to this app's own address. Blocks a
 * hostile website from reading the app through a hostname trick (DNS
 * rebinding).
 */
function hostAllowed(req) {
  return ALLOWED_HOSTS.has(String(req.headers.host ?? "").toLowerCase());
}

/**
 * Only accept form submissions made from the app's own pages. Blocks other
 * websites from submitting hidden forms to the app (cross-site request
 * forgery). Browsers mark same-site requests; older ones send Origin or
 * Referer instead. A request that proves nothing is refused.
 */
function fromOwnPages(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin";
  for (const header of [req.headers.origin, req.headers.referer]) {
    if (!header) continue;
    try {
      const u = new URL(header);
      return u.protocol === "http:" && ALLOWED_HOSTS.has(u.host.toLowerCase());
    } catch {
      return false;
    }
  }
  return false;
}

// Browser safety rules. The app runs no JavaScript at all, so scripts are
// refused outright, and no other site may show the app inside a frame.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** Same-site path from the Referer header, or the home page. */
function backPath(req) {
  try {
    const ref = new URL(req.headers.referer ?? "");
    // A path starting with // would send the browser to another site.
    if (ref.host === req.headers.host && ref.pathname.startsWith("/") && !ref.pathname.startsWith("//")) {
      return ref.pathname;
    }
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
<main class="shell">
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

/** Validate the pick fields shared by the save and update forms. */
function parsePickForm(form) {
  const gameId = form.get("gameId").trim();
  const slateDate = form.get("slateDate").trim();
  const pick = form.get("pick");
  const marginRaw = form.get("predictedMargin").trim();
  const confidence = Number(form.get("confidence"));
  const reasoning = form.get("reasoning").trim();

  if (!/^\d+$/.test(gameId) || !/^\d{8}$/.test(slateDate)) {
    return { error: "Missing or invalid game reference." };
  }
  const values = { gameId, slateDate, pick, confidence, reasoning, predictedMargin: null };
  if (pick !== "home" && pick !== "away") {
    return { values, error: "Choose which team you expect to win." };
  }
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return { values, error: "Confidence must be between 1 and 5." };
  }
  if (reasoning.length < 10) {
    return {
      values,
      error: "Write at least a sentence of reasoning. Future you needs it for the retrospective.",
    };
  }
  if (marginRaw !== "") {
    const m = Number(marginRaw);
    if (!Number.isInteger(m) || m < 1 || m > 60) {
      return { values, error: "Predicted margin must be a whole number between 1 and 60." };
    }
    values.predictedMargin = m;
  }
  return { values };
}

/** The game as it stands right now, or an error if it cannot be picked. */
async function pickableGame(gameId, slateDate) {
  const games = await getScoreboard(slateDate);
  const game = games.find((g) => g.id === gameId);
  if (!game) return { error: "Could not find that game on the slate." };
  if (!picksOpen(game)) {
    return { error: "This game has started, or its scheduled start time has passed. Picks close at the scheduled start." };
  }
  return { game };
}

/**
 * Freeze everything the card showed at the moment of the decision,
 * including both projected lineups, for retrospectives and for the
 * "changed since your pick" comparison.
 */
async function buildSnapshot(game, slateDate) {
  const [odds, form_, injuries, rest, homeStats10, awayStats10, homeTs, awayTs] =
    await Promise.all([
      // Each lookup is enrichment: if one fails, the pick still saves and
      // the snapshot records that piece as unknown.
      getOdds(game.id).catch(() => null),
      getTeamFormByTeamId().catch(() => new Map()),
      getInjuriesByTeamId().catch(() => new Map()),
      getRestByTeamId(slateDate).catch(() => new Map()),
      teamAnalytics(game.home.id).catch(() => null),
      teamAnalytics(game.away.id).catch(() => null),
      teamStarters(game.home.id).catch(() => null),
      teamStarters(game.away.id).catch(() => null),
    ]);
  const homeInjuries = injuries.get(game.home.id) ?? [];
  const awayInjuries = injuries.get(game.away.id) ?? [];
  const lineupNames = (ts, inj) =>
    reconcileStartersAndInjuries(ts, { all: inj }).starters?.map((s) => s.name) ?? null;
  return {
    game,
    odds,
    homeForm: form_.get(game.home.id) ?? null,
    awayForm: form_.get(game.away.id) ?? null,
    homeInjuries,
    awayInjuries,
    homeRest: rest.get(game.home.id) ?? null,
    awayRest: rest.get(game.away.id) ?? null,
    homeStats10,
    awayStats10,
    homeLineup: lineupNames(homeTs, homeInjuries),
    awayLineup: lineupNames(awayTs, awayInjuries),
    capturedAtUtc: new Date().toISOString(),
  };
}

/** Back to the game's card on its slate, so the page flow is not lost. */
function cardHref(slateDate, gameId, anchor = "pick") {
  return `/slate/${encodeURIComponent(slateDate)}/#${anchor}-${encodeURIComponent(gameId)}`;
}

async function handlePredict(form, res) {
  const { values, error } = parsePickForm(form);
  const back = values ? cardHref(values.slateDate, values.gameId, "game") : "/";
  const fail = (msg) =>
    sendError(res, 400, "Prediction not saved", msg, back, "Back to the game");
  if (error) return fail(error);
  const { gameId, slateDate, pick } = values;

  // A pick already saved for this game. The same pick sent twice (a double
  // click) just returns to the card; a different one is refused.
  const existingPick = () => listPredictionsForGame(gameId)[0] ?? null;
  const answerExisting = async (existing) => {
    if (existing.pick === pick && existing.reasoning === values.reasoning) {
      await rebuildAfterChange().catch(logRefreshFailure);
      return redirect(res, cardHref(slateDate, gameId));
    }
    return fail("You already have a pick for this game. Open View game details on its card to update it.");
  };
  const before = existingPick();
  if (before) return answerExisting(before);
  const { game, error: gameError } = await pickableGame(gameId, slateDate);
  if (gameError) return fail(gameError);

  const snapshot = await buildSnapshot(game, slateDate);
  // Check again: another request for this game may have saved while this
  // one waited on ESPN. The check and the insert below are synchronous and
  // back to back, so no other request can run between them.
  const raced = existingPick();
  if (raced) return answerExisting(raced);
  insertPrediction({
    gameId,
    gameDateEt: toEtDateString(game.dateUtc),
    gameLabel: game.shortName,
    pick,
    pickTeam: pick === "home" ? game.home.abbreviation : game.away.abbreviation,
    predictedMargin: values.predictedMargin,
    confidence: values.confidence,
    reasoning: values.reasoning,
    lineAtPrediction: snapshot.odds?.details ?? null,
    snapshotJson: JSON.stringify(snapshot),
  });

  // Saved either way; if the refresh fails, the page notice explains.
  await rebuildAfterChange().catch(logRefreshFailure);
  redirect(res, cardHref(slateDate, gameId));
}

async function handleUpdate(form, res) {
  const id = Number(form.get("predictionId"));
  const { values, error } = parsePickForm(form);
  const back = values ? cardHref(values.slateDate, values.gameId) : "/";
  const fail = (msg) =>
    sendError(res, 400, "Pick not updated", msg, back, "Back to the game");
  if (error) return fail(error);
  const { gameId, slateDate, pick } = values;

  const existing = Number.isInteger(id) && id > 0 ? getPrediction(id) : null;
  if (!existing || existing.game_id !== gameId) {
    return fail("Could not find that pick.");
  }
  const { game, error: gameError } = await pickableGame(gameId, slateDate);
  if (gameError) return fail(gameError);

  const snapshot = await buildSnapshot(game, slateDate);
  updatePrediction(id, {
    pick,
    pickTeam: pick === "home" ? game.home.abbreviation : game.away.abbreviation,
    predictedMargin: values.predictedMargin,
    confidence: values.confidence,
    reasoning: values.reasoning,
    lineAtPrediction: snapshot.odds?.details ?? null,
    snapshotJson: JSON.stringify(snapshot),
  });

  // Saved either way; if the refresh fails, the page notice explains.
  await rebuildAfterChange().catch(logRefreshFailure);
  redirect(res, cardHref(slateDate, gameId));
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
  // Saved either way; if the refresh fails, the page notice explains.
  await rebuildAfterChange().catch(logRefreshFailure);
  redirect(res, "/review/");
}

/* ----------------------------- static serving ---------------------------- */

// On Windows, names like CON or NUL.html open a device instead of a file,
// and reading one can hang the server.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

async function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath);
  if (rel.endsWith("/")) rel += "index.html";
  // Serve only the kinds of files the site is made of.
  if (!MIME[path.extname(rel).toLowerCase()] || rel.split("/").some((s) => WINDOWS_DEVICE.test(s))) {
    return sendError(res, 404, "Not found", "That page does not exist.");
  }
  const file = path.resolve(OUT, "." + rel);
  if (!file.startsWith(OUT + path.sep) && file !== OUT) {
    return sendError(res, 404, "Not found", "That page does not exist.");
  }
  let data;
  try {
    data = await fs.readFile(file);
  } catch {
    if (rel.endsWith("index.html") && !(await pagesExist())) {
      return sendError(
        res,
        503,
        "No data yet",
        "EdgeBoard has not been able to download any data yet. Check your internet connection. It will try again when you reload this page, at most once a minute.",
        "/",
        "Try again",
      );
    }
    return sendError(res, 404, "Not found", "That page does not exist.");
  }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const notice = type.startsWith("text/html") ? statusNotice() : null;
  if (notice) {
    data = Buffer.from(
      data
        .toString("utf8")
        .replace(
          '<main id="main" class="shell">',
          `<main id="main" class="shell">\n<p class="status-notice"><strong>Data not current:</strong> ${esc(notice)}</p>`,
        ),
    );
  }
  res.writeHead(200, { "content-type": type });
  res.end(data);
}

/* --------------------------------- server -------------------------------- */

async function handleRequest(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (!hostAllowed(req)) {
    return sendError(res, 403, "Not allowed", "EdgeBoard only answers requests addressed to localhost.");
  }
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
    decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, "Bad request", "That address is not valid.");
  }
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/") {
        return redirect(res, `/slate/${slateDateEt(0)}/`);
      }
      if (url.pathname === "/export.csv") {
        const stamp = new Intl.DateTimeFormat("en-CA").format(new Date());
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="edgeboard-picks-${stamp}.csv"`,
          "cache-control": "no-store",
        });
        return res.end(req.method === "HEAD" ? undefined : picksCsv());
      }
      const isPage = url.pathname.endsWith("/") || url.pathname.endsWith(".html");
      if (isPage) await ensureFresh();
      return await serveStatic(url.pathname, res);
    }
    if (req.method === "POST") {
      if (!fromOwnPages(req)) {
        return sendError(
          res,
          403,
          "Not allowed",
          "This form was not sent from EdgeBoard's own pages, so it was ignored. If you did submit it, reload the page and try again.",
        );
      }
      const form = parseForm(await readBody(req));
      if (url.pathname === "/predict") return await handlePredict(form, res);
      if (url.pathname === "/predict/update") return await handleUpdate(form, res);
      if (url.pathname === "/retro") return await handleRetro(form, res);
      if (url.pathname === "/refresh") {
        await rebuildAfterChange().catch(logRefreshFailure);
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
}

/* -------------------------------- startup -------------------------------- */

// Start serving right away when pages from an earlier run exist, and
// refresh in the background. Only a first-ever run waits for a build, and
// even then a failed build (offline) does not stop the server.
// Claim the port before doing any work, so a second copy started by
// mistake stops at once instead of building over the first one's pages.
const listeners = [http.createServer(handleRequest)];
await new Promise((resolve) => {
  listeners[0].once("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`
Port ${PORT} is already in use, so EdgeBoard cannot start.

EdgeBoard is probably already running in another terminal window. Use that
one, or stop it with Ctrl+C there. To run a second copy anyway, pick
another port:

  Mac and Linux:          PORT=${PORT + 1} npm run dev
  Windows (PowerShell):   $env:PORT=${PORT + 1}; npm run dev
`);
    } else {
      console.error(`EdgeBoard could not listen on port ${PORT} (${e.code ?? e.message}).`);
    }
    process.exit(1);
  });
  listeners[0].listen(PORT, HOST, resolve);
});
// "localhost" can resolve to the IPv6 address ::1 first on some systems,
// so listen there too when staying local. Harmless if IPv6 is unavailable.
if (HOST === "127.0.0.1") {
  const v6 = http.createServer(handleRequest);
  v6.on("error", () => {});
  v6.listen(PORT, "::1");
  listeners.push(v6);
}
console.log(`EdgeBoard running at http://localhost:${PORT}`);
if (HOST === "127.0.0.1") {
  console.log("Only this computer can reach it.");
} else {
  console.log(`Listening on ${HOST}: other devices on your network may reach it.`);
  console.log("There is no password, so anyone who can reach it can read and change your picks.");
}
const window =
  STALE_AFTER_MS >= 60_000
    ? `${Math.round(STALE_AFTER_MS / 60_000)} minutes`
    : `${Math.round(STALE_AFTER_MS / 1000)} seconds`;
console.log(`Pages refresh on visit when older than ${window}, or use the Refresh button.`);

// `npm run dev` passes --open. Pages not built yet are fine: the browser's
// request waits for the first build.
if (process.argv.includes("--open") && process.env.EDGEBOARD_NO_OPEN !== "1") {
  openBrowser(`http://localhost:${PORT}`);
}

backupInBackground();

// Lineup history syncs after the first refresh, once we know ESPN answers.
const syncIfOnline = () => {
  if (!status.offline) syncHistoryInBackground();
};
if (await pagesExist()) {
  console.log("Serving the last pages built; refreshing in the background.");
  rebuild().then(syncIfOnline, logRefreshFailure);
} else {
  console.log("Building pages for the first time (pages load as soon as it finishes).");
  rebuild().then(syncIfOnline, (e) =>
    console.error(
      `Could not build pages yet: ${plainReason(e)}${status.offline ? ", and nothing has been downloaded on this computer" : ""}. EdgeBoard is running and will try again when you load a page.${status.offline ? "" : DEBUG_HINT}`,
    ),
  );
}
