// Upset Potential: the underdog's chance to win, estimated from past games,
// shown on every pregame card that has a spread, with its reasons.
//
// Most of the number is the spread itself: three in four upsets come at
// spreads under 7 points. The rest is a small nudge from what the Insights
// research found leaning toward upsets: the Line check's stats picking the
// underdog, and how many of the 13 counted stats favor it.

/** Words for the number, so the meaning never rests on color. */
export const tierOf = (pct) => (pct >= 40 ? "High" : pct >= 25 ? "Moderate" : "Low");

const r0 = (n) => Math.round(n);

/**
 * `study` is the research (predictorStudy). `spread` is the size of the
 * spread in points. `marketDogPct` is the market's own chance for the
 * underdog from the moneylines, when posted.
 */
export function upsetPotential({ study, spread, statsPickDog, backing, total, dog, fav, marketDogPct = null }) {
  if (!study?.potentialAt || !study?.usualAt || !spread) return null;
  const pct = study.potentialAt(spread, statsPickDog, backing);
  const base = study.usualAt(spread);
  const nudge = pct - base;
  const reasons = [
    `The spread: ${fav} by ${spread}. Underdogs at this spread have won about ${r0(base)}% of past games. This is most of the number, because three in four upsets come at spreads under 7 points.`,
    statsPickDog
      ? `The Line check's stats pick ${dog} to win, against the market.`
      : `The Line check's stats pick ${fav}, the favorite.`,
    `${backing} of the ${total} counted stats favor ${dog}.`,
    Math.abs(nudge) < 0.5
      ? "Together, the stats leave the estimate where the spread puts it."
      : `Together, the stats move the estimate ${nudge > 0 ? "up" : "down"} ${Math.abs(nudge).toFixed(1)} points. In the research these leans are small, and chance alone could produce them.`,
  ];
  if (marketDogPct != null) {
    const gap = pct - marketDogPct;
    reasons.push(
      `The market's own estimate, from the moneylines: ${r0(marketDogPct)}%. ${
        gap >= 3 ? "EdgeBoard rates the upset chance higher than the market does." : gap <= -3 ? "EdgeBoard rates it lower than the market does." : "About the same as EdgeBoard's."
      }`,
    );
  }
  reasons.push(
    "Why this is flagged: most upsets are decided by an unusual shooting night that no stat can see coming, so this is a chance, not a call. Even High means the favorite still wins more often than not.",
  );
  // The tier follows the number shown, so "40%" never reads "Moderate".
  return { dog, pct: r0(pct), tier: tierOf(r0(pct)), market: marketDogPct == null ? null : r0(marketDogPct), reasons };
}
