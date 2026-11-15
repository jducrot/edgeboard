// What changed between the moment a pick was saved and now, before
// tip-off: the line, win probability, injury statuses, the projected
// lineup, and records (when a team played in between). Compares the
// snapshot frozen with the pick against the card's current data.

/** "PHI -7.5" becomes "PHI by 7.5"; other line text passes through. */
export function marginPhrase(details) {
  if (!details) return "no line posted";
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(details);
  return m ? `${m[1]} by ${m[2]}` : details;
}

function impliedProb(ml) {
  if (ml === null || ml === undefined || !Number.isFinite(ml)) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

/** Bookmaker margin removed; returns the home team's win percentage. */
function homeWinPct(odds) {
  const a = impliedProb(odds?.awayMoneyline);
  const h = impliedProb(odds?.homeMoneyline);
  if (a === null || h === null || a + h <= 0) return null;
  return Math.round((h / (a + h)) * 100);
}

const injKey = (i) => i.athleteId || i.athlete;

/**
 * @param snap  the snapshot saved with the pick
 * @param cur   { odds, homeForm, awayForm, homeInjuries, awayInjuries,
 *               homeLineup, awayLineup } (lineups are arrays of names)
 * @param game  the current game summary (for team abbreviations)
 */
export function compareToSnapshot(snap, cur, game) {
  const result = {
    items: [],
    marginWas: null,
    winProbWas: null,
    injuryNotes: new Map(), // `${side}:${key}` -> note
    newStarters: new Set(), // `${side}:${name}`
  };
  if (!snap?.game) return result;
  const abbr = { home: game.home.abbreviation, away: game.away.abbreviation };

  // The line.
  const wasDetails = snap.odds?.details ?? null;
  const nowDetails = cur.odds?.details ?? null;
  if (wasDetails !== nowDetails && nowDetails) {
    result.marginWas = marginPhrase(wasDetails);
    result.items.push(
      wasDetails
        ? `Expected margin moved from ${marginPhrase(wasDetails)} to ${marginPhrase(nowDetails)}`
        : `Line posted since your pick: ${marginPhrase(nowDetails)}`,
    );
  }
  const wasPct = homeWinPct(snap.odds);
  const nowPct = homeWinPct(cur.odds);
  if (wasPct !== null && nowPct !== null && Math.abs(nowPct - wasPct) >= 3) {
    result.winProbWas = `${abbr.home} ${wasPct}%`;
    result.items.push(
      `${abbr.home} win probability was ${wasPct}%, now ${nowPct}%`,
    );
  }

  // Injury statuses, per team.
  for (const side of ["away", "home"]) {
    const before = new Map((snap[`${side}Injuries`] ?? []).map((i) => [injKey(i), i]));
    const after = new Map((cur[`${side}Injuries`] ?? []).map((i) => [injKey(i), i]));
    for (const [k, i] of after) {
      const old = before.get(k);
      if (!old) {
        result.items.push(`${i.athlete} (${abbr[side]}) added to the injury report: ${i.status}`);
        result.injuryNotes.set(`${side}:${k}`, `Added to the report since your pick`);
      } else if ((old.status ?? "") !== (i.status ?? "")) {
        result.items.push(`${i.athlete} (${abbr[side]}) status was ${old.status}, now ${i.status}`);
        result.injuryNotes.set(`${side}:${k}`, `Status was ${old.status} at your pick, now ${i.status}`);
      }
    }
    for (const [k, i] of before) {
      if (!after.has(k)) {
        result.items.push(`${i.athlete} (${abbr[side]}) is off the injury report (was ${i.status})`);
      }
    }
  }

  // Projected lineup. Snapshots saved before lineups were recorded skip this.
  for (const side of ["away", "home"]) {
    const was = snap[`${side}Lineup`];
    const now = cur[`${side}Lineup`];
    if (!Array.isArray(was) || !Array.isArray(now)) continue;
    const added = now.filter((n) => !was.includes(n));
    const removed = was.filter((n) => !now.includes(n));
    if (added.length === 0 && removed.length === 0) continue;
    const parts = [];
    if (added.length) parts.push(`${added.join(", ")} in`);
    if (removed.length) parts.push(`${removed.join(", ")} out`);
    result.items.push(`${abbr[side]} projected lineup changed: ${parts.join("; ")}`);
    for (const n of added) result.newStarters.add(`${side}:${n}`);
  }

  // A team that played between the pick and now.
  for (const side of ["away", "home"]) {
    const was = snap[`${side}Form`];
    const now = cur[`${side}Form`];
    if (!was || !now) continue;
    if (was.wins !== now.wins || was.losses !== now.losses) {
      result.items.push(
        `${abbr[side]} played since your pick: now ${now.wins}-${now.losses} (was ${was.wins}-${was.losses})`,
      );
    }
  }

  return result;
}
