// Last-10 team analytics aggregated from game box scores: possessions,
// pace, offensive and defensive ratings, Dean Oliver's Four Factors, and
// the three-point profile. Rates are computed from summed totals, not
// averaged per-game rates.

import { getGameSummary, getTeamCompletedGames } from "./espn.mjs";

function madeAtt(cell) {
  const [m, a] = String(cell ?? "").split("-").map(Number);
  return {
    made: Number.isFinite(m) ? m : 0,
    att: Number.isFinite(a) ? a : 0,
  };
}

function statsByName(teamBox) {
  const map = new Map();
  for (const s of teamBox?.statistics ?? []) map.set(s.name, s.displayValue);
  return map;
}

function extractSide(summary, teamId) {
  const teams = summary.boxscore?.teams ?? [];
  const mine = teams.find((t) => String(t.team?.id) === String(teamId));
  const theirs = teams.find((t) => String(t.team?.id) !== String(teamId));
  if (!mine || !theirs) return null;
  const comps = summary.header?.competitions?.[0]?.competitors ?? [];
  const score = (id) =>
    Number(comps.find((c) => String(c.team?.id) === String(id))?.score);
  const read = (box) => {
    const s = statsByName(box);
    const fg = madeAtt(s.get("fieldGoalsMade-fieldGoalsAttempted"));
    const tp = madeAtt(s.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
    const ft = madeAtt(s.get("freeThrowsMade-freeThrowsAttempted"));
    return {
      fgm: fg.made,
      fga: fg.att,
      tpm: tp.made,
      tpa: tp.att,
      fta: ft.att,
      orb: Number(s.get("offensiveRebounds")) || 0,
      drb: Number(s.get("defensiveRebounds")) || 0,
      to: Number(s.get("totalTurnovers")) || 0,
    };
  };
  const my = read(mine);
  const opp = read(theirs);
  my.pts = score(teamId);
  opp.pts = score(theirs.team.id);
  if (!Number.isFinite(my.pts) || !Number.isFinite(opp.pts)) return null;
  return { my, opp };
}

function sumInto(total, g) {
  for (const k of Object.keys(g)) total[k] = (total[k] ?? 0) + g[k];
}

const memo = new Map();

/** Last-10 analytics for one team, or null when fewer than 5 usable games. */
export async function teamAnalytics(teamId) {
  const completed = await getTeamCompletedGames(teamId);
  const recent = completed.slice(0, 10);
  if (recent.length < 5) return null;
  const key = `${teamId}:${recent[0].eventId}`;
  if (memo.has(key)) return memo.get(key);

  const work = (async () => {
    const my = {};
    const opp = {};
    let games = 0;
    for (const g of recent) {
      try {
        const side = extractSide(await getGameSummary(g.eventId), teamId);
        if (!side) continue;
        sumInto(my, side.my);
        sumInto(opp, side.opp);
        games++;
      } catch {
        // Skip games whose summary cannot be read.
      }
    }
    if (games < 5) return null;

    const poss = (t) => t.fga - t.orb + t.to + 0.44 * t.fta;
    const myPoss = poss(my);
    const oppPoss = poss(opp);
    if (myPoss <= 0 || oppPoss <= 0) return null;

    const pct = (n, d) => (d > 0 ? (n / d) * 100 : null);
    return {
      games,
      pace: (myPoss + oppPoss) / 2 / games,
      ortg: (my.pts / myPoss) * 100,
      drtg: (opp.pts / oppPoss) * 100,
      net: (my.pts / myPoss) * 100 - (opp.pts / oppPoss) * 100,
      efg: pct(my.fgm + 0.5 * my.tpm, my.fga),
      efgAllowed: pct(opp.fgm + 0.5 * opp.tpm, opp.fga),
      tovPct: pct(my.to, myPoss),
      tovForcedPct: pct(opp.to, oppPoss),
      orbPct: pct(my.orb, my.orb + opp.drb),
      // Share of all available rebounds, both ends of the floor.
      trbPct: pct(my.orb + my.drb, my.orb + my.drb + opp.orb + opp.drb),
      ftRate: my.fga > 0 ? my.fta / my.fga : null,
      ftRateAllowed: opp.fga > 0 ? opp.fta / opp.fga : null,
      tpaPerGame: my.tpa / games,
      tpPct: pct(my.tpm, my.tpa),
      oppTpPct: pct(opp.tpm, opp.tpa),
    };
  })();

  memo.set(key, work);
  return work;
}
