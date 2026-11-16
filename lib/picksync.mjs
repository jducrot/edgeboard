// Syncing picks between computers through a private git repository.
//
// The live database is never shared. Each pick is also kept as one small
// JSON file, named by its permanent id, in a clone of the private repo at
// data/sync (or EDGEBOARD_SYNC_DIR). Each sync pulls, brings in picks from
// other computers, writes out local picks that changed, commits, and
// pushes. One file per pick means two computers almost never edit the same
// file. Results are not synced: every computer grades picks itself.
//
// Sync is on only when data/sync is a git clone. Without it, nothing here
// runs and EdgeBoard works exactly as before.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SYNC_DIR } from "./paths.mjs";
import { listPredictions, importPrediction, applyRemotePrediction, setSyncNote, getDb } from "./db.mjs";

const PICKS_DIR = path.join(SYNC_DIR, "picks");
const BRANCH = "main";

export const syncEnabled = () => fs.existsSync(path.join(SYNC_DIR, ".git"));

function git(args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // A fixed identity, so commits work even where git has no name set,
      // and your email never lands in the history.
      ["-C", SYNC_DIR, "-c", "user.name=EdgeBoard", "-c", "user.email=edgeboard@localhost", ...args],
      // Never stop to ask for a password: the server has no one to answer.
      { timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout))),
    );
  });
}

/** The fields a pick is shared with. Grades are left out on purpose. */
export function toRecord(row) {
  return {
    uid: row.uid,
    gameId: row.game_id,
    gameDateEt: row.game_date_et,
    gameLabel: row.game_label,
    pick: row.pick,
    pickTeam: row.pick_team,
    predictedMargin: row.predicted_margin ?? null,
    confidence: row.confidence,
    reasoning: row.reasoning,
    lineAtPrediction: row.line_at_prediction ?? null,
    snapshotJson: row.snapshot_json,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc ?? null,
    retroTags: row.retro_tags ?? null,
    retroNotes: row.retro_notes ?? null,
    retroAtUtc: row.retro_at_utc ?? null,
  };
}

/** When a pick last changed: saved, updated, or given notes. */
export const changedAt = (r) =>
  [r.createdAtUtc, r.updatedAtUtc, r.retroAtUtc].filter(Boolean).sort().at(-1) ?? "";

const earlier = (a, b) => a.createdAtUtc < b.createdAtUtc || (a.createdAtUtc === b.createdAtUtc && a.uid < b.uid);

function conflictNote(kept, other) {
  const when = (iso) =>
    new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `This game was also picked on another computer before the two synced: ${other.pickTeam}${other.predictedMargin ? ` by ${other.predictedMargin}` : ""} because ${other.reasoning}. The earlier pick, saved ${when(kept.createdAtUtc)} ET, is the one kept.`;
}

/**
 * What to do with picks from the repository, given the local ones. Pure, so
 * it can be tested. Both computers reach the same answer: the newer version
 * of a pick wins, and when each computer picked the same game, the pick
 * saved first is kept and the other is described in a note.
 */
export function planImport(localRecords, incoming) {
  const byUid = new Map(localRecords.map((r) => [r.uid, { ...r }]));
  const byGame = new Map(localRecords.map((r) => [r.gameId, byUid.get(r.uid)]));
  const actions = [];
  for (const rec of [...incoming].sort((a, b) => (earlier(a, b) ? -1 : 1))) {
    const same = byUid.get(rec.uid);
    if (same) {
      if (changedAt(rec) > changedAt(same)) {
        actions.push({ type: "update", uid: rec.uid, record: rec });
        Object.assign(same, rec);
      }
      continue;
    }
    const rival = byGame.get(rec.gameId);
    if (!rival) {
      actions.push({ type: "insert", record: rec });
      const copy = { ...rec };
      byUid.set(rec.uid, copy);
      byGame.set(rec.gameId, copy);
    } else if (earlier(rec, rival)) {
      // The other computer's pick came first: it replaces the local one.
      actions.push({ type: "replace", uid: rival.uid, record: rec, note: conflictNote(rec, rival) });
      byUid.delete(rival.uid);
      const copy = { ...rec };
      byUid.set(rec.uid, copy);
      byGame.set(rec.gameId, copy);
    } else {
      actions.push({ type: "note", uid: rival.uid, note: conflictNote(rival, rec) });
    }
  }
  return actions;
}

function readRepoPicks() {
  if (!fs.existsSync(PICKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(PICKS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(PICKS_DIR, name), "utf8"));
      if (r?.uid && r.gameId && (r.pick === "home" || r.pick === "away")) out.push(r);
    } catch {
      // A damaged file is skipped, never fatal.
    }
  }
  return out;
}

function applyActions(actions) {
  const d = getDb();
  const idOf = (uid) => d.prepare("SELECT id FROM predictions WHERE uid = ?").get(uid)?.id;
  d.transaction(() => {
    for (const a of actions) {
      if (a.type === "insert") importPrediction(a.record);
      if (a.type === "update") applyRemotePrediction(idOf(a.uid), a.record);
      if (a.type === "replace") {
        const id = idOf(a.uid);
        applyRemotePrediction(id, a.record);
        setSyncNote(id, a.note);
      }
      if (a.type === "note") setSyncNote(idOf(a.uid), a.note);
    }
  })();
}

/** Write each local pick's file when its contents changed. Returns how many. */
function exportPicks() {
  fs.mkdirSync(PICKS_DIR, { recursive: true });
  let written = 0;
  for (const row of listPredictions()) {
    const file = path.join(PICKS_DIR, `${row.uid}.json`);
    const text = `${JSON.stringify(toRecord(row), null, 2)}\n`;
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      // Not written yet.
    }
    if (current !== text) {
      fs.writeFileSync(file, text);
      written++;
    }
  }
  return written;
}

async function pull() {
  // A brand-new, empty repository has no branch yet. Name it.
  await git(["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]).catch(() => {});
  try {
    // On the rare clash (one pick edited on both computers before they
    // synced), keep this computer's file. Each computer still applies
    // whichever version changed last.
    await git(["pull", "--rebase", "-X", "theirs", "origin", BRANCH], 15_000);
  } catch (e) {
    if (/couldn't find remote ref|does not have any commits/i.test(e.stderr)) return; // empty repository
    await git(["rebase", "--abort"]).catch(() => {});
    throw e;
  }
}

let queue = Promise.resolve();
let lastProblem = null;

/** Explain a sync problem once, in plain words, until it changes. */
function report(e) {
  const reason = /Authentication failed|could not read Username|Invalid username or password/i.test(e.stderr ?? "")
    ? `GitHub needs you to sign in. In the edgeboard folder, run: git -C "${path.relative(process.cwd(), SYNC_DIR) || SYNC_DIR}" pull`
    : /Could not resolve host|unable to access|timed out|ETIMEDOUT|ENOTFOUND/i.test(`${e.stderr ?? ""} ${e.message}`)
      ? "GitHub could not be reached"
      : /ENOENT/.test(e.code ?? "") || e.code === "ENOENT"
        ? "git is not installed"
        : (e.stderr || e.message || String(e)).split("\n")[0];
  if (reason !== lastProblem) {
    console.error(`Pick sync: ${reason}. Your picks are saved on this computer and will sync next time.`);
    lastProblem = reason;
  }
}

/**
 * Pull, bring in picks from other computers, write out local changes, and
 * commit. The push runs in the background. One sync at a time. Never throws.
 */
export function syncPicks({ online = true } = {}) {
  if (!syncEnabled()) return Promise.resolve(null);
  const run = queue.then(async () => {
    const result = { imported: 0, exported: 0, pushed: false };
    try {
      if (online) await pull();
      const actions = planImport(listPredictions().map(toRecord), readRepoPicks());
      applyActions(actions);
      result.imported = actions.filter((a) => a.type !== "note").length;
      result.exported = exportPicks();
      if (result.exported > 0) {
        await git(["add", "picks"]);
        await git(["commit", "-m", `Picks: ${result.exported} saved or changed`]);
      }
      if (online) {
        const ahead = await git(["rev-list", "--count", `origin/${BRANCH}..HEAD`]).catch(() => "1");
        if (Number(ahead) > 0) {
          await git(["push", "origin", `HEAD:${BRANCH}`], 20_000);
          result.pushed = true;
        }
      }
      if (lastProblem) console.log("Pick sync: working again.");
      lastProblem = null;
    } catch (e) {
      report(e);
    }
    return result;
  });
  queue = run;
  return run;
}
