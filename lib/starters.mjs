// Starting five, read from the team's most recent completed game, with a
// scoring trend for each starter and a marker for players who entered the
// lineup recently (often injury cover).

import {
  getAthleteGamelog,
  getGameSummary,
  getTeamCompletedGames,
} from "./espn.mjs";
import { playedGames } from "./impact.mjs";

function lineupFromSummary(summary, teamId) {
  const teamBox = (summary.boxscore?.players ?? []).find(
    (p) => String(p.team?.id) === String(teamId),
  );
  const block = teamBox?.statistics?.[0];
  const labels = block?.names ?? block?.labels ?? [];
  const iMin = labels.indexOf("MIN");
  const athletes = block?.athletes ?? [];
  const toRow = (a) => ({
    id: String(a.athlete?.id ?? ""),
    name: a.athlete?.displayName ?? "Unknown",
    pos: a.athlete?.position?.abbreviation ?? null,
    min: iMin >= 0 && Array.isArray(a.stats) ? Number(a.stats[iMin]) || 0 : 0,
  });
  const starters = athletes.filter((a) => a.starter === true).map(toRow).filter((s) => s.id);
  const bench = athletes
    .filter((a) => a.starter !== true && !a.didNotPlay)
    .map(toRow)
    .filter((s) => s.id)
    .sort((a, b) => b.min - a.min)
    .slice(0, 3);
  return { starters, bench };
}

function startersFromSummary(summary, teamId) {
  return lineupFromSummary(summary, teamId).starters;
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
    const lastGame = completed[0];
    const refGame = completed[Math.min(5, completed.length - 1)];
    const [lastSummary, refSummary] = await Promise.all([
      getGameSummary(lastGame.eventId),
      getGameSummary(refGame.eventId),
    ]);
    const lineup = lineupFromSummary(lastSummary, teamId);
    const current = lineup.starters;
    if (current.length === 0) return null;
    const earlierIds = new Set(
      startersFromSummary(refSummary, teamId).map((s) => s.id),
    );

    const enrich = async (list, isBench) => Promise.all(
      list.map(async (s) => {
        let trend = null;
        let raw = null;
        try {
          const gamelog = await getAthleteGamelog(s.id);
          trend = trendLine(gamelog, completed.slice(0, 12));
          raw = playerComponents(gamelog, completed.slice(0, 12));
        } catch {
          trend = null;
        }
        return {
          id: s.id,
          name: s.name,
          pos: s.pos,
          trend,
          raw,
          indexLine: null, // filled in after slate-wide normalization
          newToLineup: !isBench && !earlierIds.has(s.id),
        };
      }),
    );
    const [rows, bench] = await Promise.all([
      enrich(current, false),
      enrich(lineup.bench, true),
    ]);
    return { starters: rows, bench };
  })();

  memo.set(key, work);
  return work;
}
