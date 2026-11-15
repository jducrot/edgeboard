// Research results shown on the Insights page.

import { cohesionIndex, cohesionBacktest } from "../../lib/cohesion.mjs";

export default function () {
  try {
    const index = cohesionIndex();
    if (index.gamesCovered === 0) return { cohesion: null };
    const bt = cohesionBacktest(index);
    const pct = (n) => (n === null ? "–" : `${n.toFixed(1)}%`);
    return {
      cohesion: {
        verdict: bt.verdict,
        caution: bt.caution,
        breakEven: bt.breakEven.toFixed(1),
        gamesCovered: bt.gamesCovered,
        groups: bt.groups.map((g) => ({
          label: g.label,
          games: g.games,
          cover: pct(g.coverPct),
          range: g.low === null ? "–" : `${g.low.toFixed(1)} to ${g.high.toFixed(1)}%`,
          won: pct(g.wonPct),
        })),
      },
    };
  } catch {
    return { cohesion: null };
  }
}
