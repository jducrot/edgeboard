// Line check: a transparent stats-only estimate of the margin, compared
// against the market's spread, with every component shown. The model is
// deliberately simple: season scoring margins, home court, rest, and
// fresh key absences. It knows less than the market; the point is to see
// where and by how much they disagree.

const HOME_COURT = 2.5;
const B2B_PENALTY = 2;
const FRESH_KEY_ABSENCE = 3;
const MAX_ABSENCE_ADJ = 6;

function net(form) {
  if (!form || form.avgPointsFor === null || form.avgPointsAgainst === null) return null;
  return form.avgPointsFor - form.avgPointsAgainst;
}

function freshKeyAbsences(injuryItems) {
  return injuryItems.filter(
    (i) =>
      (i.status ?? "").toLowerCase() === "out" &&
      i.tier === "Key player" &&
      i.missedStreak === 0,
  );
}

function questionableKeys(injuryItems) {
  return injuryItems.filter(
    (i) => (i.status ?? "").toLowerCase() !== "out" && i.tier === "Key player",
  );
}

function fmtSigned(n) {
  const r = Math.round(n * 10) / 10;
  return r > 0 ? `+${r}` : `${r}`;
}

function marginPhrase(homeAbbr, awayAbbr, homeMargin) {
  const m = Math.round(Math.abs(homeMargin) * 2) / 2;
  if (m < 0.5) return "a toss-up";
  return `${homeMargin > 0 ? homeAbbr : awayAbbr} by ${m}`;
}

/**
 * All inputs are the card's own data. Returns null when there is no line
 * or not enough form data to say anything.
 */
export function lineCheck({ game, odds, homeForm, awayForm, homeRest, awayRest, homeInjuryItems, awayInjuryItems, homeStats, awayStats, unlistedAbsences = [] }) {
  const spread = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(odds?.details ?? "");
  if (!spread) return null;

  const homeAbbr = game.home.abbreviation;
  const awayAbbr = game.away.abbreviation;

  // Market margin, home perspective.
  const marketHome = spread[1] === homeAbbr ? Number(spread[2]) : -Number(spread[2]);

  // Stats margin, home perspective, built from named components. Prefer
  // possession-adjusted last-10 net ratings; fall back to season scoring
  // margins when analytics are unavailable.
  const parts = [];
  let base;
  if (homeStats && awayStats) {
    const pace = (homeStats.pace + awayStats.pace) / 2;
    base = ((homeStats.net - awayStats.net) * pace) / 100;
    parts.push(
      `last-10 net ratings (${homeAbbr} ${fmtSigned(homeStats.net)}, ${awayAbbr} ${fmtSigned(awayStats.net)} per 100, at ~${Math.round(pace)} possessions)`,
    );
  } else {
    const homeNet = net(homeForm);
    const awayNet = net(awayForm);
    if (homeNet === null || awayNet === null) return null;
    base = homeNet - awayNet;
    parts.push(
      `season scoring margins (${homeAbbr} ${fmtSigned(homeNet)} per game, ${awayAbbr} ${fmtSigned(awayNet)})`,
    );
  }
  let stats = base + HOME_COURT;
  parts.push(`home court for ${homeAbbr} (+${HOME_COURT})`);
  if (homeRest?.backToBack && !awayRest?.backToBack) {
    stats -= B2B_PENALTY;
    parts.push(`${homeAbbr}'s back-to-back (-${B2B_PENALTY})`);
  } else if (awayRest?.backToBack && !homeRest?.backToBack) {
    stats += B2B_PENALTY;
    parts.push(`${awayAbbr}'s back-to-back (-${B2B_PENALTY} for them)`);
  }

  const homeFresh = freshKeyAbsences(homeInjuryItems ?? []);
  const awayFresh = freshKeyAbsences(awayInjuryItems ?? []);
  if (homeFresh.length > 0) {
    const adj = Math.min(MAX_ABSENCE_ADJ, homeFresh.length * FRESH_KEY_ABSENCE);
    stats -= adj;
    parts.push(
      `${homeAbbr} newly without ${homeFresh.map((i) => i.athlete).join(", ")} (-${adj})`,
    );
  }
  if (awayFresh.length > 0) {
    const adj = Math.min(MAX_ABSENCE_ADJ, awayFresh.length * FRESH_KEY_ABSENCE);
    stats += adj;
    parts.push(
      `${awayAbbr} newly without ${awayFresh.map((i) => i.athlete).join(", ")} (-${adj} for them)`,
    );
  }

  const gap = stats - marketHome;
  const absGap = Math.abs(gap);
  const statsPhrase = marginPhrase(homeAbbr, awayAbbr, stats);
  const marketPhrase = marginPhrase(homeAbbr, awayAbbr, marketHome);

  let verdict;
  let meaning;
  if (absGap < 3) {
    verdict = "The line is in line with the stats.";
    meaning = "No obvious edge either way from the numbers alone.";
  } else {
    const leanTeam = gap > 0 ? homeAbbr : awayAbbr;
    const strength = absGap >= 6 ? "strongly" : "mildly";
    verdict = `The stats ${strength} disagree with the line: they lean ${leanTeam} against this number, by about ${Math.round(absGap)} points.`;
    meaning =
      "A gap like this usually means the market is pricing something the season numbers cannot see, such as tonight's lineup news or sharper injury detail. Decide which you believe before siding with the stats.";
  }

  const sentences = [
    `Market: ${marketPhrase}. Stats: ${statsPhrase}.`,
    `The stats number comes from ${parts.join(", ")}.`,
    verdict,
    meaning,
  ];

  const gtd = [...questionableKeys(homeInjuryItems ?? []), ...questionableKeys(awayInjuryItems ?? [])];
  const uncertain = [
    ...gtd.map((i) => `${i.athlete} (${i.status})`),
    ...unlistedAbsences.map((name) => `${name} (missed recent games, no injury listed)`),
  ];
  if (uncertain.length > 0) {
    sentences.push(`Unpriced uncertainty: ${uncertain.join(", ")}.`);
  }

  // The two margins, home perspective, so callers can add context.
  return { items: sentences, statsHome: stats, marketHome };
}
