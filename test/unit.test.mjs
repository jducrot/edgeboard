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

test("lineup history keeps each team's box-score totals and never loses a saved line", async () => {
  const { historyDb, syncGameDetails } = await import("../lib/history.mjs");
  const d = historyDb();
  d.prepare(`INSERT INTO games (event_id, season, season_type, date_utc, home_id, away_id, home_score, away_score, home_line, lineups_done, box_done)
    VALUES ('900', 2027, 2, '2026-11-10T00:00Z', '1', '2', 110, 100, -4.5, 1, 0)`).run();
  const stat = (name, displayValue) => ({ name, displayValue });
  const team = (id, fg, tp, ft, orb, drb, tov) => ({
    team: { id },
    statistics: [
      stat("fieldGoalsMade-fieldGoalsAttempted", fg),
      stat("threePointFieldGoalsMade-threePointFieldGoalsAttempted", tp),
      stat("freeThrowsMade-freeThrowsAttempted", ft),
      stat("offensiveRebounds", orb),
      stat("defensiveRebounds", drb),
      stat("totalTurnovers", tov),
    ],
  });
  const summary = {
    header: { competitions: [{ competitors: [{ team: { id: "1" }, score: "110" }, { team: { id: "2" }, score: "100" }] }] },
    boxscore: { players: [], teams: [team("1", "40-85", "12-30", "18-22", "10", "35", "12"), team("2", "37-88", "9-33", "17-20", "11", "33", "15")] },
  };
  const realFetch = globalThis.fetch;
  let oddsCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/odds")) {
      oddsCalls++;
      throw new Error("odds unavailable");
    }
    return new Response(JSON.stringify(summary), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await syncGameDetails("900");
  } finally {
    globalThis.fetch = realFetch;
  }
  const rows = d.prepare("SELECT * FROM team_box WHERE event_id = '900' ORDER BY team_id").all();
  assert.deepEqual(
    rows.map(({ team_id, pts, fgm, fga, tpm, tpa, fta, orb, drb, tov }) => [team_id, pts, fgm, fga, tpm, tpa, fta, orb, drb, tov]),
    [
      ["1", 110, 40, 85, 12, 30, 22, 10, 35, 12],
      ["2", 100, 37, 88, 9, 33, 20, 11, 33, 15],
    ],
  );
  const game = d.prepare("SELECT home_line, box_done FROM games WHERE event_id = '900'").get();
  assert.equal(game.box_done, 1, "marked as stored");
  assert.equal(game.home_line, -4.5, "the saved line is kept");
  assert.equal(oddsCalls, 0, "the line is not downloaded again");
});

/* ------------------------- the predictor study -------------------------- */

const P = await import("../lib/predictors.mjs");

// A season where team 1 hosts team 2 again and again, one day apart.
const series = (n, homeWins) =>
  Array.from({ length: n }, (_, i) => ({
    eventId: `s${i + 1}`,
    season: 2027,
    dateUtc: new Date(Date.UTC(2026, 10, 1 + i * 2, 23)).toISOString(),
    homeId: "1",
    awayId: "2",
    homeScore: homeWins(i) ? 110 : 90,
    awayScore: homeWins(i) ? 100 : 120,
    homeLine: 4,
  }));

test("predictor study: each game is scored only from games before it", () => {
  // Team 1 wins its first 11 games by 10, then loses the 12th by 30.
  const rows = P.scoreGames(series(12, (i) => i < 11));
  assert.deepEqual(rows.map((r) => r.eventId), ["s11", "s12"], "scored once both teams have 10 games");
  const last = rows.at(-1);
  assert.equal(last.home.seasonWinPct, 1, "the 12th game's loss is not counted before it is played");
  assert.equal(last.home.lastMargin, 10);
  assert.equal(last.homeMargin, -30, "the result being predicted");
});

test("predictor study: wins, underdog wins, and covers are counted correctly", () => {
  const row = (homeMargin, homeLine) => ({ homeMargin, homeLine });
  const t = P.tally([
    { row: row(8, 5), side: "home" }, // favorite wins and covers
    { row: row(3, 5), side: "home" }, // favorite wins, does not cover
    { row: row(5, 5), side: "home" }, // push: left out of the spread count
    { row: row(-2, 5), side: "away" }, // underdog wins
    { row: row(4, 5), side: "away" }, // underdog loses but covers
  ]);
  assert.equal(t.games, 5);
  assert.equal(t.wonPct, 80);
  assert.equal(t.dogGames, 2);
  assert.equal(t.dogWonPct, 50);
  assert.equal(t.atsGames, 4);
  assert.equal(t.atsPct, 75);
});

test("predictor study: the Line check replay follows the card's own rules", () => {
  const team = (net, restDays = 1, freshMissing = 0) => ({ stats: { net, pace: 100 }, restDays, freshMissing, seasonMargin: 0 });
  assert.equal(P.statsMargin({ home: team(5), away: team(-5) }), 12.5, "net gap at 100 possessions, plus 2.5 home court");
  assert.equal(P.statsMargin({ home: team(5, 0), away: team(-5) }), 10.5, "home back-to-back costs 2");
  assert.equal(P.statsMargin({ home: team(5), away: team(-5, 1, 1) }), 15.5, "a fresh absence costs 3");
  assert.equal(P.statsMargin({ home: team(5), away: team(-5, 1, 4) }), 18.5, "absences are capped at 6");
});

test("predictor study: back-to-backs are judged on Eastern dates", () => {
  const games = series(11, () => true);
  // The 11th game: 7:30 PM Eastern on November 21, which is already
  // November 22 in UTC. Then a game at 6 PM Eastern on November 22.
  games[10].dateUtc = "2026-11-22T00:30:00Z";
  games.push({ ...games[10], eventId: "s12", dateUtc: "2026-11-22T23:00:00Z" });
  const last = P.scoreGames(games).at(-1);
  assert.equal(last.home.restDays, 0, "consecutive Eastern days are a back-to-back");
});

// Close games (1.5-point spreads) where underdogs win half the time, and
// long shots (12 points) where they win 1 in 10.
const spreadGames = () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ homeLine: 1.5, homeMargin: i % 2 ? 4 : -4 });
  for (let i = 0; i < 200; i++) rows.push({ homeLine: 12, homeMargin: i % 10 === 0 ? -3 : 15 });
  return rows;
};

test("upsets: the usual underdog rate is fitted by spread size", () => {
  const usual = P.underdogCurve(spreadGames());
  assert.ok(Math.abs(usual(1.5) - 0.5) < 0.02, `close games: ${usual(1.5)}`);
  assert.ok(Math.abs(usual(12) - 0.1) < 0.02, `long shots: ${usual(12)}`);
  assert.ok(usual(6) < usual(3), "bigger spreads, fewer upsets");
});

test("upsets: a signal that only backs close-game underdogs gets no credit for it", () => {
  const rows = spreadGames();
  const usual = P.underdogCurve(rows);
  const closeOnly = P.upsetTally(rows.filter((r) => r.homeLine === 1.5), usual);
  // Its underdogs won 50%, far above the 30% of all underdogs, but exactly
  // what underdogs at that spread always do.
  assert.equal(closeOnly.wonPct, 50);
  assert.equal(closeOnly.standing, "About the usual rate");
  // Long shots that won 3 times as often as usual do stand out.
  const longShots = rows.filter((r) => r.homeLine === 12).slice(0, 60);
  for (const r of longShots.slice(0, 18)) r.homeMargin = -3;
  assert.equal(P.upsetTally(longShots, usual).standing, "Clearly more than usual");
});

test("upsets: the words for a gap follow fixed chance bars", () => {
  assert.equal(P.standing(2.0), "Clearly more than usual", "past about 1 in 40 by chance");
  assert.equal(P.standing(1.9), "More than usual, but could be chance");
  assert.equal(P.standing(1.0), "More than usual, but could be chance");
  assert.equal(P.standing(0.5), "About the usual rate");
  assert.equal(P.standing(-1.2), "Fewer than usual");
});

test("upsets: findings name a clear signal only past the chance bar, and list the ones that did nothing", () => {
  const sig = (key, label, z) => ({ key, label, z, games: 300, won: 120, wonPct: 40, usualPct: 35, diff: 5, standing: P.standing(z) });
  const base = {
    upsetPct: 31,
    lineGames: 1200,
    statCount: 13,
    bySpread: [{ label: "Under 3.5 points", wonPct: 50 }, { label: "10 points or more", wonPct: 15 }],
    stack: [{ label: "None", games: 100, wonPct: 15, usualPct: 19 }, { label: "7 or more", games: 150, wonPct: 46, usualPct: 41 }],
  };
  const none = P.verdicts({ ...base, upsetSignals: [sig("net", "Net rating", 1.5), sig("rest", "Rest", 0.1)] });
  assert.match(none.join(" "), /No single signal's underdogs have won clearly more often/);
  assert.match(none.join(" "), /One signal leans that way/);
  assert.match(none.join(" "), /No help at all for spotting upsets so far: "Rest"/);
  const clear = P.verdicts({ ...base, upsetSignals: [sig("net", "Net rating", 2.5)] });
  assert.match(clear.join(" "), /Clearly more upsets than usual: "Net rating"/);
  assert.doesNotMatch(clear.join(" "), /market/i, "no verdict about the market");
});

test("upsets: the Line check note says which side the stats back", () => {
  const study = {
    lineCheckUpsets: {
      dog: { games: 250, wonPct: 44.8, usualPct: 40.5 },
      favorite: { games: 949, wonPct: 27.9, usualPct: 29.1 },
    },
  };
  assert.equal(
    P.lineCheckNote(study, -2, 5),
    "The stats back the underdog here. In past games like that, the underdog won 45% of 250, against 41% usual at those spreads.",
  );
  assert.match(P.lineCheckNote(study, 8, 5), /^The stats back the favorite here\. In past games like that, the underdog won 28% of 949, against 29% usual/);
  assert.equal(P.lineCheckNote(study, 0, 5), null, "no note for a dead-even stats margin");
});

test("installs need no compiler: dependency install scripts stay off", async () => {
  const npmrc = await fs.readFile(new URL("../.npmrc", import.meta.url), "utf8");
  // Without this, npm compiles the database driver from source on a fresh
  // install, which fails on Windows unless Visual Studio is installed.
  assert.match(npmrc, /^ignore-scripts=true$/m);
  // ignore-scripts also skips "pre" and "post" scripts, so none may exist:
  // they would silently never run.
  const { scripts } = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const skipped = Object.keys(scripts).filter((name) => /^(pre|post)/.test(name));
  assert.deepEqual(skipped, []);
  assert.match(scripts.test, /--import \.\/scripts\/check-node\.mjs/, "npm test still checks the Node version first");
});
