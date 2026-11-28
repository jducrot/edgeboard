// Injuries weighed by minutes: how much of a team's recent rotation is out
// tonight, from the injury report, measured the way the research measures it.

/**
 * Minutes a team is missing tonight: players the injury report lists as
 * Out, weighed by their share of the last 10 games. Questionable and
 * doubtful players are not counted. Null without lineup history.
 */
export function minutesOut(study, team, dateUtc, items) {
  if (!study?.minutesNow) return null;
  const out = new Map(
    (items ?? [])
      .filter((i) => i.athleteId && (i.status ?? "").toLowerCase() === "out")
      .map((i) => [String(i.athleteId), i.athlete]),
  );
  const m = study.minutesNow({ teamId: team.id, dateUtc, isOut: (id) => out.has(String(id)) });
  if (!m) return null;
  return { ...m, listedOut: out.size, players: m.players.map((p) => ({ ...p, name: out.get(String(p.id)) })) };
}

/** One sentence for the injuries section, or null when nobody is out. */
export function minutesLine(m) {
  if (!m || m.listedOut === 0) return null;
  const total = Math.round(m.missing);
  if (total === 0) {
    return "Out tonight: none of the minutes from the last 10 games, so the recent stats already reflect this roster.";
  }
  const fresh = Math.round(m.fresh);
  const when = fresh === 0 ? "none of them new since the last game" : fresh === total ? "all of them new since the last game" : `${fresh} of them new since the last game`;
  return `Out tonight: ${total} minutes a game from the last 10 games, ${when}. The recent stats still count those minutes.`;
}
