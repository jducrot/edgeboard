// Projected starting five from the team's last five games, with a scoring
// trend per starter, a marker for recent lineup entries, and the facts
// needed to flag absences that have no injury listing.
//
// Why five games, not one: a player who sits a game for rest is missing
// from that box score entirely. Reading only the last game drops him from
// the lineup until he plays again, even when he starts every game he plays.

import {
  getAthleteGamelog,
  getGameSummary,
  getTeamCompletedGames,
  getTeamRosterIds,
  toEtDateString,
} from "./espn.mjs";
import { playedGames } from "./impact.mjs";

const WINDOW = 5;
// Weights by a player's OWN appearances, most recent first. Counting his
// appearances rather than team games means rest nights do not erode a
// regular starter's standing, while a starter moved to the bench loses it
// within two or three games.
const START_WEIGHTS = [1, 0.85, 0.7, 0.55, 0.4];

/** Every player in one game's box score for this team. */
function boxRows(summary, teamId) {
  const teamBox = (summary.boxscore?.players ?? []).find(
    (p) => String(p.team?.id) === String(teamId),
  );
  const block = teamBox?.statistics?.[0];
  const labels = block?.names ?? block?.labels ?? [];
  const iMin = labels.indexOf("MIN");
  return (block?.athletes ?? [])
    .map((a) => ({
      id: String(a.athlete?.id ?? ""),
      name: a.athlete?.displayName ?? "Unknown",
      pos: a.athlete?.position?.abbreviation ?? null,
      started: a.starter === true,
      played: !a.didNotPlay,
      min: iMin >= 0 && Array.isArray(a.stats) ? Number(a.stats[iMin]) || 0 : 0,
    }))
    .filter((r) => r.id);
}

function shortEtDate(isoUtc) {
  const ymd = toEtDateString(isoUtc); // YYYY-MM-DD in ET
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

/**
 * Rank everyone who appeared in the window. Returns players in projected
 * lineup order, each with the facts the card and absence checks need.
 */
function rankPlayers(summaries, games, teamId, rosterIds) {
  const players = new Map();
  summaries.forEach((summary, gi) => {
    if (!summary) return;
    for (const r of boxRows(summary, teamId)) {
      if (!players.has(r.id)) {
        players.set(r.id, { id: r.id, name: r.name, pos: r.pos, apps: [] });
      }
      if (r.played) players.get(r.id).apps.push({ gi, started: r.started, min: r.min });
    }
  });

  const ranked = [];
  for (const p of players.values()) {
    if (rosterIds && !rosterIds.has(p.id)) continue; // Traded or waived.
    if (p.apps.length === 0) continue;
    p.apps.sort((a, b) => a.gi - b.gi); // Most recent first.
    const score = p.apps.reduce(
      (s, a, k) => s + (a.started ? START_WEIGHTS[k] ?? 0 : 0),
      0,
    );
    const starts = p.apps.filter((a) => a.started).length;
    const totalMin = p.apps.reduce((s, a) => s + a.min, 0);
    // Consecutive most-recent team games he did not appear in.
    let missedRecent = 0;
    while (missedRecent < games.length && !p.apps.some((a) => a.gi === missedRecent)) {
      missedRecent++;
    }
    ranked.push({
      id: p.id,
      name: p.name,
      pos: p.pos,
      score,
      totalMin,
      avgMin: totalMin / p.apps.length,
      missedRecent,
      // Oldest game in the current missed streak, for "since <date>".
      missedSince:
        missedRecent > 0 ? shortEtDate(games[missedRecent - 1].dateUtc) : null,
      // Started the most recent game, but rarely before: often injury cover.
      newToLineup:
        p.apps[0]?.gi === 0 && p.apps[0].started && starts <= 2 && p.apps.length >= 3,
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.totalMin - a.totalMin);
  return ranked;
}

function avg(list) {
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** Attempts from a "made-attempted" cell like "10-16". */
function attempts(cell) {
  const n = Number(String(cell ?? "").split("-")[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Raw per-36 components over the player's recent appearances, for the
 * slate-normalized offense and defensive-activity indices.
 */
function playerComponents(gamelog, teamGames) {
  const { played, idx } = playedGames(gamelog);
  const rows = teamGames
    .filter((g) => played.has(g.eventId))
    .map((g) => played.get(g.eventId))
    .slice(0, 10);
  if (rows.length < 3) return null;

  let min = 0, pts = 0, ast = 0, to = 0, stl = 0, blk = 0, reb = 0, fga = 0, fta = 0;
  for (const r of rows) {
    min += Number(r[idx.min]) || 0;
    pts += Number(r[idx.pts]) || 0;
    ast += Number(r[idx.ast]) || 0;
    to += idx.to >= 0 ? Number(r[idx.to]) || 0 : 0;
    stl += idx.stl >= 0 ? Number(r[idx.stl]) || 0 : 0;
    blk += idx.blk >= 0 ? Number(r[idx.blk]) || 0 : 0;
    reb += Number(r[idx.reb]) || 0;
    fga += idx.fg >= 0 ? attempts(r[idx.fg]) : 0;
    fta += idx.ft >= 0 ? attempts(r[idx.ft]) : 0;
  }
  if (min < 36) return null;
  const per36 = (v) => (v / min) * 36;
  const tsDenom = 2 * (fga + 0.44 * fta);
  return {
    pts36: per36(pts),
    astNet36: per36(ast) - per36(to),
    ts: tsDenom > 0 ? pts / tsDenom : null,
    stl36: per36(stl),
    blk36: per36(blk),
    reb36: per36(reb),
  };
}

function trendLine(gamelog, teamGames) {
  const { played, idx } = playedGames(gamelog);
  const pts = teamGames
    .filter((g) => played.has(g.eventId))
    .map((g) => Number(played.get(g.eventId)[idx.pts]))
    .filter((n) => Number.isFinite(n));
  if (pts.length < 3) return null;

  const recent = pts.slice(0, Math.min(5, pts.length));
  const prior = pts.slice(recent.length, recent.length + 5);
  const r = avg(recent);
  const p = prior.length >= 3 ? avg(prior) : null;
  const f = (n) => (Math.round(n * 10) / 10).toString();

  if (p === null) {
    return `${f(r)} pts over the last ${recent.length}.`;
  }
  const delta = r - p;
  if (delta >= 4 || (p > 0 && delta / p >= 0.25)) {
    return `Hot: ${f(r)} pts over the last ${recent.length}, up from ${f(p)} before that.`;
  }
  if (delta <= -4 || (p > 0 && delta / p <= -0.25)) {
    return `Cold: ${f(r)} pts over the last ${recent.length}, down from ${f(p)} before that.`;
  }
  return `Steady around ${f(r)} pts over the last ${recent.length}.`;
}

// One team's starters are asked for by several cards across the slates;
// compute once per build process per last-game.
const memo = new Map();

export async function teamStarters(teamId) {
  const completed = await getTeamCompletedGames(teamId);
  if (completed.length < 2) return null;
  const key = `${teamId}:${completed[0].eventId}`;
  if (memo.has(key)) return memo.get(key);

  const work = (async () => {
    const games = completed.slice(0, WINDOW);
    const [summaries, rosterIds] = await Promise.all([
      Promise.all(games.map((g) => getGameSummary(g.eventId).catch(() => null))),
      getTeamRosterIds(teamId),
    ]);
    const ranked = rankPlayers(summaries, games, teamId, rosterIds);
    const startersRanked = ranked.filter((p) => p.score > 0).slice(0, 5);
    if (startersRanked.length === 0) return null;
    // Fill to five by minutes if the window somehow has fewer starters.
    for (const p of ranked) {
      if (startersRanked.length >= 5) break;
      if (!startersRanked.includes(p)) startersRanked.push(p);
    }
    // Deep enough to backfill a lineup with several starters out at once.
    const bench = ranked.filter((p) => !startersRanked.includes(p)).slice(0, 8);

    const enrich = (list) => Promise.all(
      list.map(async (p) => {
        let trend = null;
        let raw = null;
        try {
          const gamelog = await getAthleteGamelog(p.id);
          trend = trendLine(gamelog, completed.slice(0, 12));
          raw = playerComponents(gamelog, completed.slice(0, 12));
        } catch {
          trend = null;
        }
        return {
          id: p.id,
          name: p.name,
          pos: p.pos,
          trend,
          raw,
          indexLine: null, // filled in after slate-wide normalization
          newToLineup: p.newToLineup,
          missedRecent: p.missedRecent,
          missedSince: p.missedSince,
          avgMin: p.avgMin,
        };
      }),
    );
    const [starters, benchRows] = await Promise.all([enrich(startersRanked), enrich(bench)]);
    // Rotation players (20+ minutes) who missed recent games, whoever they
    // are, so the card can flag absences outside the lineup too.
    const absentees = ranked
      .filter((p) => p.missedRecent > 0 && p.avgMin >= 20)
      .map((p) => ({
        id: p.id,
        name: p.name,
        missedRecent: p.missedRecent,
        missedSince: p.missedSince,
      }));
    return { starters, bench: benchRows, absentees };
  })();

  memo.set(key, work);
  return work;
}
