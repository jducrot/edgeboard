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

/* ---------------------- games that were never played --------------------- */

const { parseScoreboard, slateDateEt } = await import("../lib/espn.mjs");

// Shapes copied from ESPN's real scoreboard, trimmed to the fields read.
const espnEvent = ({ id, state, completed, name, detail, homeScore, awayScore }) => ({
  id,
  date: "2025-01-10T03:30Z",
  name: "Charlotte Hornets at Los Angeles Lakers",
  shortName: "CHA @ LAL",
  status: { type: { state, completed, name, detail } },
  competitions: [
    {
      competitors: [
        { homeAway: "home", score: homeScore, team: { id: "13", abbreviation: "LAL", displayName: "Los Angeles Lakers" } },
        { homeAway: "away", score: awayScore, team: { id: "30", abbreviation: "CHA", displayName: "Charlotte Hornets" } },
      ],
    },
  ],
});

test("a postponed game is never treated as played, and one odd event cannot break a day", () => {
  const games = parseScoreboard({
    events: [
      // ESPN reports a postponed game as over, 0-0, with completed false.
      espnEvent({ id: "1", state: "post", completed: false, name: "STATUS_POSTPONED", detail: "Postponed", homeScore: "0", awayScore: "0" }),
      espnEvent({ id: "2", state: "post", completed: true, name: "STATUS_FINAL", detail: "Final", homeScore: "112", awayScore: "104" }),
      { id: "3", status: { type: { state: "pre" } }, competitions: [{ competitors: [] }] },
      espnEvent({ id: "4", state: "pre", completed: false, name: "STATUS_SCHEDULED", detail: "7:30 PM", homeScore: "", awayScore: "" }),
    ],
  });
  assert.deepEqual(games.map((g) => g.id), ["1", "2", "4"], "the event without teams is skipped, the rest kept");
  const [postponed, final, upcoming] = games;
  assert.equal(postponed.statusState, "off");
  assert.equal(postponed.statusDetail, "Postponed");
  assert.equal(final.statusState, "post");
  assert.deepEqual([final.home.score, final.away.score], [112, 104]);
  assert.equal(upcoming.statusState, "pre");
  assert.deepEqual([upcoming.home.score, upcoming.away.score], [null, null], "an empty score is unknown, not 0");
});

test("lineup history drops postponed games stored as 0-0 by older versions", async () => {
  const Database = (await import("better-sqlite3")).default;
  const file = path.join(tmp, "history.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE games (event_id TEXT PRIMARY KEY, season INTEGER NOT NULL, season_type INTEGER NOT NULL,
    date_utc TEXT NOT NULL, home_id TEXT NOT NULL, away_id TEXT NOT NULL, home_score INTEGER, away_score INTEGER,
    home_line REAL, lineups_done INTEGER NOT NULL DEFAULT 0)`);
  const ins = old.prepare("INSERT INTO games VALUES (?, 2026, 2, '2026-01-09T01:00Z', '4', '14', ?, ?, NULL, ?)");
  ins.run("postponed", 0, 0, -1);
  ins.run("real", 110, 99, 1);
  old.close();
  const { historyDb } = await import("../lib/history.mjs");
  const ids = historyDb().prepare("SELECT event_id FROM games ORDER BY event_id").all().map((r) => r.event_id);
  assert.deepEqual(ids, ["real"]);
});

/* ----------------------------- slate dates ------------------------------ */

test("slate dates move by calendar days, even across daylight-saving changes", () => {
  const cases = [
    // 11:30 PM Saturday before clocks spring forward (Sunday March 14, 2027).
    ["2027-03-14T04:30:00Z", { "-1": "20270312", 0: "20270313", 1: "20270314" }],
    // 12:30 AM Monday right after it.
    ["2027-03-15T04:30:00Z", { "-1": "20270314", 0: "20270315", 1: "20270316" }],
    // 11:30 PM Saturday before clocks fall back (Sunday November 7, 2027).
    ["2027-11-07T03:30:00Z", { "-1": "20271105", 0: "20271106", 1: "20271107" }],
    // 12:30 AM Monday right after it.
    ["2027-11-08T05:30:00Z", { "-1": "20271107", 0: "20271108", 1: "20271109" }],
    // An ordinary evening: 9 PM Eastern is already the next day in UTC.
    ["2026-11-16T02:00:00Z", { "-1": "20261114", 0: "20261115", 1: "20261116" }],
  ];
  for (const [at, expected] of cases) {
    for (const [offset, ymd] of Object.entries(expected)) {
      assert.equal(slateDateEt(Number(offset), Date.parse(at)), ymd, `${at} with offset ${offset}`);
    }
  }
});

test("picks close at the scheduled start, even before ESPN says the game is live", async () => {
  const { picksOpen } = await import("../lib/espn.mjs");
  const start = Date.parse("2026-11-16T00:30:00Z");
  const game = { statusState: "pre", dateUtc: "2026-11-16T00:30Z" };
  assert.equal(picksOpen(game, start - 60_000), true, "a minute before the start");
  assert.equal(picksOpen(game, start), false, "at the scheduled start");
  assert.equal(picksOpen(game, start + 60_000), false, "a minute after, while the cached status still says pre");
  assert.equal(picksOpen({ ...game, statusState: "in" }, start - 60_000), false, "already live");
  assert.equal(picksOpen({ ...game, statusState: "off" }, start - 60_000), false, "postponed");
});

test("a month of lineup history is final only once it ended a few days ago", async () => {
  const { monthIsFinal } = await import("../lib/history.mjs");
  // 8 PM Eastern on November 30 is already December 1 in UTC.
  assert.equal(monthIsFinal("202611", new Date("2026-12-01T01:00:00Z")), false, "games still being played");
  assert.equal(monthIsFinal("202611", new Date("2026-12-03T23:00:00Z")), false);
  assert.equal(monthIsFinal("202611", new Date("2026-12-04T00:00:00Z")), true);
  assert.equal(monthIsFinal("202612", new Date("2027-01-04T00:00:00Z")), true, "December rolls into the next year");
  assert.equal(monthIsFinal("202612", new Date("2026-12-20T00:00:00Z")), false, "the current month");
});

test("lineups: a box score that failed to load is not counted as a missed game", async () => {
  const { rankPlayers } = await import("../lib/starters.mjs");
  const box = (starter) => ({
    boxscore: {
      players: [
        {
          team: { id: "1" },
          statistics: [
            {
              names: ["MIN", "PTS"],
              athletes: [{ athlete: { id: "9", displayName: "Test Player", position: { abbreviation: "G" } }, starter, stats: ["34", "20"] }],
            },
          ],
        },
      ],
    },
  });
  const games = [1, 2, 3].map((i) => ({ eventId: String(i), dateUtc: `2026-11-1${i}T00:00Z` }));
  // The most recent game's box score failed (null); he played the two before.
  const [p] = rankPlayers([null, box(true), box(true)], games, "1", null);
  assert.equal(p.name, "Test Player");
  assert.equal(p.missedRecent, 0, "unknown is not the same as missed");
});

test("lineups: one built around a failed download is not reused", async () => {
  const { teamStarters } = await import("../lib/starters.mjs");
  let summaryCalls = 0;
  let failNext = true;
  const espn = {
    getTeamCompletedGames: async () => [1, 2].map((i) => ({ eventId: `m${i}`, dateUtc: `2026-11-1${i}T00:00Z` })),
    getTeamRosterIds: async () => new Set(["9"]),
    getAthleteGamelog: async () => null,
    getGameSummary: async () => {
      summaryCalls++;
      if (failNext) throw new Error("simulated download failure");
      return { boxscore: { players: [] } };
    },
  };
  await teamStarters("memo-test", espn);
  const afterFirst = summaryCalls;
  failNext = false;
  await teamStarters("memo-test", espn);
  assert.ok(summaryCalls > afterFirst, "the second call downloads again instead of reusing the failed result");
  const afterSecond = summaryCalls;
  await teamStarters("memo-test", espn);
  assert.equal(summaryCalls, afterSecond, "a complete result is reused");
});

test("odd ESPN ids never reach a download address", async () => {
  const { getAthleteGamelog, getOdds } = await import("../lib/espn.mjs");
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no network in this test");
  };
  try {
    await assert.rejects(getAthleteGamelog("../../teams/1"), /Not an ESPN athlete id/);
    assert.equal(await getOdds("1/../../x"), null);
    assert.equal(calls, 0, "nothing was downloaded");
  } finally {
    globalThis.fetch = realFetch;
  }
});
