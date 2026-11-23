// Your track record: how your graded picks compare with the market and the
// stats on the same games, and where your picks go right or wrong. Built
// from your own saved picks and each pick's frozen snapshot.

const pct = (a, b) => (b ? (100 * a) / b : null);

/** The spread at the moment of the pick, from the home team's side. */
function homeLineAtPick(row, snap) {
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(row.line_at_prediction ?? "");
  const home = snap?.game?.home?.abbreviation;
  if (!m || !home) return null;
  return m[1] === home ? Number(m[2]) : -Number(m[2]);
}

/**
 * The Line check's side, rebuilt from the snapshot: last-10 net ratings
 * scaled for pace, home court, and back-to-backs. Fresh absences are left
 * out, because the snapshot does not keep the injury tiers they need.
 */
function statsSide(snap) {
  const h = snap?.homeStats10;
  const a = snap?.awayStats10;
  if (!h || !a) return null;
  let m = ((h.net - a.net) * ((h.pace + a.pace) / 2)) / 100 + 2.5;
  if (snap.homeRest?.backToBack && !snap.awayRest?.backToBack) m -= 2;
  if (snap.awayRest?.backToBack && !snap.homeRest?.backToBack) m += 2;
  return m === 0 ? null : m > 0 ? "home" : "away";
}

/**
 * `rows` are saved picks (database rows). `usualAt(spread)` gives the
 * percent of games underdogs usually win at that spread, from the research.
 */
export function trackRecord(rows, { usualAt } = {}) {
  const graded = rows
    .filter((r) => r.reconciled_at_utc && r.final_home_score != null && r.final_away_score != null)
    .map((r) => {
      let snap = null;
      try {
        snap = JSON.parse(r.snapshot_json);
      } catch {
        // An unreadable snapshot just leaves the comparisons out.
      }
      const homeWon = r.final_home_score > r.final_away_score;
      const homeLine = homeLineAtPick(r, snap);
      const fav = homeLine ? (homeLine > 0 ? "home" : "away") : null;
      const ats = homeLine == null ? null : r.final_home_score - r.final_away_score - homeLine;
      return {
        right: r.pick_correct === 1,
        pick: r.pick,
        confidence: r.confidence,
        homeWon,
        homeLine,
        fav,
        stats: statsSide(snap),
        covered: ats == null || ats === 0 ? null : (r.pick === "home") === ats > 0,
      };
    });
  const tally = (list, ok = (x) => x.right) => ({ games: list.length, right: list.filter(ok).length, pct: pct(list.filter(ok).length, list.length) });
  const lined = graded.filter((g) => g.fav);
  const withStats = graded.filter((g) => g.stats);
  const onDog = lined.filter((g) => g.pick !== g.fav);
  const usual = usualAt && onDog.length ? onDog.reduce((t, g) => t + usualAt(Math.abs(g.homeLine)), 0) / onDog.length : null;
  return {
    graded: graded.length,
    you: tally(graded),
    market: tally(lined, (g) => (g.fav === "home") === g.homeWon),
    stats: tally(withStats, (g) => (g.stats === "home") === g.homeWon),
    byConfidence: [1, 2, 3, 4, 5].map((c) => ({ confidence: c, ...tally(graded.filter((g) => g.confidence === c)) })),
    favorite: tally(lined.filter((g) => g.pick === g.fav)),
    underdog: { ...tally(onDog), usualPct: usual },
    home: tally(graded.filter((g) => g.pick === "home")),
    away: tally(graded.filter((g) => g.pick === "away")),
    againstSpread: tally(graded.filter((g) => g.covered != null), (g) => g.covered),
  };
}
