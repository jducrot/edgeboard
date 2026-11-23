// Research results shown on the Insights page, already worded and
// formatted, so the template only lays them out.

import { cohesionIndex, cohesionBacktest } from "../../lib/cohesion.mjs";
import { predictorStudy, verdicts, BREAK_EVEN, SIGNALS } from "../../lib/predictors.mjs";
import { upsetAnatomy } from "../../lib/anatomy.mjs";

function anatomySection() {
  const a = upsetAnatomy();
  if (!a.upsets) return null;
  const p0 = (n) => (n == null ? "–" : `${n.toFixed(0)}%`);
  const pts = (n) => (n == null ? "–" : `${Math.abs(n).toFixed(1)} points`);
  return {
    games: count(a.games),
    upsets: count(a.upsets),
    battles: a.battles.map((b) => ({ label: b.label, inUpsets: p0(b.inUpsets), inLosses: p0(b.inLosses), winWhenWon: p0(b.winWhenWon) })),
    shotInUpsets: p0(a.battles[0].inUpsets),
    dogAbove: pts(a.dogAboveUsual),
    favBelow: pts(a.favBelowUsual),
    swingInUpsets: p0(a.swingInUpsets),
    swingInLosses: p0(a.swingInLosses),
    withoutShooting: count(a.withoutShooting),
    withoutShootingTov: p0(a.withoutShootingTov),
    withoutShootingOrb: p0(a.withoutShootingOrb),
    within5: p0(a.closeWithin5),
    within10: p0(a.closeWithin10),
    under7: p0(a.under7),
  };
}

const pct = (n) => (n === null || n === undefined ? "–" : `${n.toFixed(1)}%`);
const range = (lo, hi) => (lo === null || lo === undefined ? "–" : `${lo.toFixed(1)} to ${hi.toFixed(1)}%`);
const count = (n) => n.toLocaleString("en-US");

function cohesionSection(index, study) {
  const bt = cohesionBacktest(index);
  const group = (key) => bt.groups.find((g) => g.key === key);
  const large = group("large");
  const small = group("small");
  const typical = index.typicalPair !== null ? Math.round(index.typicalPair) : 18;
  // A worked example whose gap always lands in the large third.
  const exampleHigh = typical + Math.ceil(bt.cutoffs.large) + 5;
  const asUnderdog = study?.upsetSignals.find((s) => s.key === "cohesion");
  return {
    verdict: bt.verdict,
    caution: bt.caution,
    breakEven: bt.breakEven.toFixed(1),
    typical,
    smallCutoff: bt.cutoffs.small.toFixed(0),
    largeCutoff: bt.cutoffs.large.toFixed(0),
    example: { low: typical, high: exampleHigh, gap: exampleHigh - typical },
    large: { won: pct(large.wonPct), cover: pct(large.coverPct) },
    small: { won: pct(small.wonPct) },
    underdog: asUnderdog?.games
      ? { won: pct(asUnderdog.wonPct), games: count(asUnderdog.games), usual: pct(asUnderdog.usualPct) }
      : null,
    groups: bt.groups.map((g) => ({
      label: g.label,
      games: count(g.games),
      cover: pct(g.coverPct),
      range: range(g.low, g.high),
      won: pct(g.wonPct),
    })),
  };
}

function lineCheckVerdict(bands) {
  const clears = bands.filter((b) => b.ats.atsLow !== null && b.ats.atsLow > BREAK_EVEN);
  if (clears.length) {
    return `"${clears[0].label}" has covered ${pct(clears[0].ats.atsPct)}, and even the low end of its range clears the ${BREAK_EVEN.toFixed(1)}% needed to profit. Promising, but with three groups tested, one can look this good by luck.`;
  }
  return `None of the three verdicts clears the ${BREAK_EVEN.toFixed(1)}% needed to profit, not even strong disagreement. When the stats and the line disagree, treat it as a reason to look closer, not as a bet on its own.`;
}

function watchSection(watch) {
  if (!watch?.signals?.length) return null;
  const covered = (t) => (t.atsGames ? `${pct(t.atsPct)} of ${count(t.atsGames)}` : "No games yet");
  const dogs = (u) => (u.games ? `${pct(u.wonPct)} of ${count(u.games)} (usual ${pct(u.usualPct)})` : "None yet");
  return {
    seasons: watch.seasons,
    ready: watch.signals.filter((s) => s.ready).length,
    rows: watch.signals.map((s) => ({
      name: s.name,
      flag: s.flag,
      lastCovered: covered(s.last.ats),
      currentCovered: covered(s.current.ats),
      lastDogs: dogs(s.last.upset),
      status: s.text,
    })),
  };
}

function upsetRow(s, total) {
  return {
    label: s.label,
    where: s.where,
    group: s.group,
    games: count(s.games),
    won: pct(s.wonPct),
    usual: pct(s.usualPct),
    standing: s.standing,
    caught: `${count(s.won)} of ${count(total)}`,
  };
}

function predictorSection(study) {
  if (!study || study.games === 0) return null;
  const by = (key) => study.upsetSignals.find((s) => s.key === key);
  const record = by("record");
  return {
    games: count(study.games),
    lineGames: count(study.lineGames),
    totalUpsets: count(study.totalUpsets),
    breakEven: BREAK_EVEN.toFixed(1),
    statCount: study.statCount,
    stats: SIGNALS.filter((s) => s.stat).map((s) => ({ label: s.label, where: s.where })),
    verdicts: verdicts(study),
    usualAt35: pct(study.usualAt(3.5)),
    record: record ? upsetRow(record, study.totalUpsets) : null,
    lineCheckDog: {
      won: pct(study.lineCheckUpsets.dog.wonPct),
      games: count(study.lineCheckUpsets.dog.games),
      usual: pct(study.lineCheckUpsets.dog.usualPct),
    },
    lineCheckFavorite: {
      won: pct(study.lineCheckUpsets.favorite.wonPct),
      games: count(study.lineCheckUpsets.favorite.games),
    },
    upsets: study.upsetSignals.map((s) => upsetRow(s, study.totalUpsets)),
    stack: study.stack.map((b) => ({
      label: b.label,
      games: count(b.games),
      won: pct(b.wonPct),
      usual: pct(b.usualPct),
      standing: b.standing,
    })),
    bySpread: study.bySpread.map((b) => ({ label: b.label, games: count(b.games), won: pct(b.wonPct) })),
    winners: study.winners.map((s) => ({
      label: s.label,
      where: s.where,
      group: s.group,
      games: count(s.games),
      won: pct(s.wonPct),
      ats: pct(s.atsPct),
      atsRange: range(s.atsLow, s.atsHigh),
    })),
    watch: watchSection(study.watch),
    lineCheckVerdict: lineCheckVerdict(study.lineCheck),
    lineCheck: study.lineCheck.map((b) => ({
      label: b.label,
      games: count(b.ats.atsGames),
      cover: pct(b.ats.atsPct),
      range: range(b.ats.atsLow, b.ats.atsHigh),
    })),
  };
}

export default function () {
  try {
    const index = cohesionIndex();
    if (index.gamesCovered === 0) return { cohesion: null, predictors: null };
    const study = predictorStudy();
    return { cohesion: cohesionSection(index, study), predictors: predictorSection(study), anatomy: anatomySection() };
  } catch {
    return { cohesion: null, predictors: null };
  }
}
