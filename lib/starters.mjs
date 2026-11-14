// Starting five, read from the team's most recent completed game, with a
// scoring trend for each starter and a marker for players who entered the
// lineup recently (often injury cover).

import {
  getAthleteGamelog,
  getGameSummary,
  getTeamCompletedGames,
} from "./espn.mjs";
import { playedGames } from "./impact.mjs";

function startersFromSummary(summary, teamId) {
  const teamBox = (summary.boxscore?.players ?? []).find(
    (p) => String(p.team?.id) === String(teamId),
  );
  const athletes = teamBox?.statistics?.[0]?.athletes ?? [];
  return athletes
    .filter((a) => a.starter === true)
    .map((a) => ({
      id: String(a.athlete?.id ?? ""),
      name: a.athlete?.displayName ?? "Unknown",
      pos: a.athlete?.position?.abbreviation ?? null,
    }))
    .filter((s) => s.id);
}

function avg(list) {
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
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
    const current = startersFromSummary(lastSummary, teamId);
    if (current.length === 0) return null;
    const earlierIds = new Set(
      startersFromSummary(refSummary, teamId).map((s) => s.id),
    );

    const rows = await Promise.all(
      current.map(async (s) => {
        let trend = null;
        try {
          trend = trendLine(await getAthleteGamelog(s.id), completed.slice(0, 12));
        } catch {
          trend = null;
        }
        return {
          name: s.name,
          pos: s.pos,
          trend,
          newToLineup: !earlierIds.has(s.id),
        };
      }),
    );
    return rows;
  })();

  memo.set(key, work);
  return work;
}
