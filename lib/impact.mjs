// Injury impact: how much a listed player normally contributes, and whether
// their absence is new (production goes missing tonight) or already priced
// into the team's recent results.

import { getAthleteGamelog, getTeamCompletedGames } from "./espn.mjs";

export function playedGames(gamelog) {
  // Map of eventId -> stats array, across season types and categories.
  const labels = gamelog.labels ?? [];
  const idx = {
    min: labels.indexOf("MIN"),
    reb: labels.indexOf("REB"),
    ast: labels.indexOf("AST"),
    pts: labels.indexOf("PTS"),
  };
  const played = new Map();
  for (const st of gamelog.seasonTypes ?? []) {
    for (const cat of st.categories ?? []) {
      for (const ev of cat.events ?? []) {
        if (ev.eventId && Array.isArray(ev.stats)) {
          played.set(String(ev.eventId), ev.stats);
        }
      }
    }
  }
  return { played, idx };
}

function avgOf(rows, idx, key) {
  const vals = rows
    .map((r) => Number(r[idx[key]]))
    .filter((n) => Number.isFinite(n));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Compute a succinct impact description for one injured player.
 * Returns { value, context } strings, either of which may be null.
 */
export async function playerImpact(athleteId, teamId) {
  const [gamelog, teamGames] = await Promise.all([
    getAthleteGamelog(athleteId),
    getTeamCompletedGames(teamId),
  ]);
  const { played, idx } = playedGames(gamelog);

  // Only consider this team's games the player could have appeared in.
  const recentTeamGames = teamGames.slice(0, 10);
  const playedRows = recentTeamGames
    .filter((g) => played.has(g.eventId))
    .map((g) => played.get(g.eventId));

  if (played.size === 0 || playedRows.length === 0) {
    return {
      value: null,
      context: "Has not appeared in the team's recent games, so the absence changes little.",
      tier: null,
      pts: null,
      missedStreak: null,
    };
  }

  const pts = avgOf(playedRows, idx, "pts");
  const reb = avgOf(playedRows, idx, "reb");
  const ast = avgOf(playedRows, idx, "ast");
  const min = avgOf(playedRows, idx, "min");

  let tier = "Deep bench";
  if ((min ?? 0) >= 28 || (pts ?? 0) >= 15) tier = "Key player";
  else if ((min ?? 0) >= 20 || (pts ?? 0) >= 8) tier = "Rotation player";

  const f = (n) => (n === null ? "–" : (Math.round(n * 10) / 10).toString());
  const value = `${tier}: ${f(pts)} pts, ${f(reb)} reb, ${f(ast)} ast in ${f(min)} min (when playing, last ${playedRows.length} appearances).`;

  // Absence streak: consecutive most-recent team games without an appearance.
  let missedStreak = 0;
  let missedWins = 0;
  for (const g of recentTeamGames) {
    if (played.has(g.eventId)) break;
    missedStreak++;
    if (g.won) missedWins++;
  }

  let context;
  if (missedStreak === 0) {
    const lastRow = played.get(recentTeamGames[0]?.eventId);
    const lastPts = lastRow ? Number(lastRow[idx.pts]) : null;
    context = `New absence: played the team's last game${Number.isFinite(lastPts) ? ` (${lastPts} pts)` : ""}, so this production goes missing tonight.`;
  } else {
    context = `Already missed the last ${missedStreak === 1 ? "game" : `${missedStreak} games`}; the team went ${missedWins}-${missedStreak - missedWins} in that span, so recent form already reflects the absence.`;
  }

  return { value, context, tier, pts, missedStreak };
}
