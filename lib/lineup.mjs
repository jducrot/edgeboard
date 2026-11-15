// Reconciles a team's projected lineup (lib/starters.mjs) with its injury
// report. Shared by the slate pages and by the server's prediction
// snapshots, so a saved pick freezes exactly the lineup the card showed.

/**
 * A player appears in exactly one list. Starters listed Out move to the
 * injury list only (the last game's lineup is stale for them); starters
 * on the report as day-to-day stay starters with the injury noted inline
 * and leave the injury list.
 */
export function reconcileStartersAndInjuries(ts, injView) {
  if (!ts?.starters?.length) return { starters: null, injView, unaccounted: [], unlisted: [] };
  const isOut = (i) => (i.status ?? "").toLowerCase() === "out";
  const matches = (i, s) =>
    (i.athleteId && i.athleteId === s.id) || i.athlete === s.name;
  const note = (inj) =>
    `on the injury report: ${inj.status}${inj.injuryType ? ` (${inj.injuryType.toLowerCase()})` : ""}`;

  // A missed game with no injury listing: rest, personal reasons, or news
  // the report has not caught. Either way, availability is unconfirmed.
  const absenceNote = (p) => {
    if (!p.missedRecent) return null;
    return p.missedRecent === 1
      ? `sat the last game (${p.missedSince}) with no injury listed; status for this game unconfirmed`
      : `has missed the last ${p.missedRecent} games (since ${p.missedSince}) with no injury listed; status unconfirmed`;
  };
  const annotate = (p, extra = {}) => {
    const inj = injView.all.find((i) => matches(i, p));
    if (inj) return { ...p, ...extra, gtdNote: note(inj) };
    return { ...p, ...extra, absenceNote: absenceNote(p) };
  };

  const kept = [];
  for (const s of ts.starters) {
    const inj = injView.all.find((i) => matches(i, s));
    if (inj && isOut(inj)) continue; // Out: injury list only.
    kept.push(annotate(s));
  }

  // A lineup always has five: backfill removed starters with the next
  // players in the five-game ranking, marked as projected.
  for (const b of ts.bench ?? []) {
    if (kept.length >= 5) break;
    if (kept.some((k) => k.id === b.id)) continue;
    const inj = injView.all.find((i) => matches(i, b));
    if (inj && isOut(inj)) continue;
    kept.push(annotate(b, { projected: true }));
  }

  const remainingInjuries = injView.all.filter((i) => {
    const inLineup = kept.some((s) => matches(i, s));
    return !inLineup || isOut(i); // Shown-in-lineup GTD players leave the injury list.
  });

  // Rotation players outside the lineup who also vanished without a listing.
  const unaccounted = (ts.absentees ?? [])
    .filter((a) => !kept.some((k) => k.id === a.id))
    .filter((a) => !injView.all.some((i) => matches(i, a)))
    .map((a) => ({ name: a.name, note: absenceNote(a) }));

  // Everyone whose availability is unconfirmed, for the Line check.
  const unlisted = [
    ...kept.filter((k) => k.absenceNote).map((k) => k.name),
    ...unaccounted.map((u) => u.name),
  ];

  return {
    starters: kept.length > 0 ? kept : null,
    injView: { ...injView, all: remainingInjuries, count: remainingInjuries.length },
    unaccounted,
    unlisted,
  };
}
