// Charts drawn when pages are built: plain SVG geometry for the templates,
// with no JavaScript in the page. Each chart comes with a one-sentence
// summary that names it, for the visible caption and for screen readers.

/** What each confidence level promises: 1 is a coin flip, 5 is a lock. */
export const promiseAt = (c) => 50 + (c - 1) * 12.5;

const W = 320;
const H = 236;
// Values and pick counts sit under the bars, next to the confidence number,
// so no line or bar ever crosses a label.
const PLOT = { left: 40, right: 12, top: 12, bottom: 76 };

/**
 * Bars for how often you were right at each confidence level, and the
 * dashed line of what each level promises. `levels` are
 * [{ confidence, games, right, pct }] for 1 to 5.
 */
export function confidenceChart(levels) {
  const plotW = W - PLOT.left - PLOT.right;
  const plotH = H - PLOT.top - PLOT.bottom;
  const slot = plotW / 5;
  const yOf = (p) => PLOT.top + plotH * (1 - p / 100);
  const xMid = (c) => PLOT.left + slot * (c - 0.5);
  const bars = levels.map((l) => {
    const has = l.games > 0;
    const top = has ? yOf(l.pct) : yOf(0);
    return {
      confidence: l.confidence,
      x: round(xMid(l.confidence) - slot * 0.3),
      width: round(slot * 0.6),
      y: round(top),
      height: round(yOf(0) - top),
      labelX: round(xMid(l.confidence)),
      value: has ? `${Math.round(l.pct)}%` : "none",
      count: has ? `${l.right} of ${l.games}` : "",
      has,
    };
  });
  const promise = [1, 2, 3, 4, 5].map((c) => `${round(xMid(c))},${round(yOf(promiseAt(c)))}`).join(" ");
  const grid = [0, 50, 100].map((p) => ({ p, y: round(yOf(p)), label: `${p}%` }));
  const axisY = round(yOf(0));
  return {
    width: W,
    height: H,
    left: PLOT.left,
    right: W - PLOT.right,
    axisY,
    xLabelY: axisY + 16,
    valueY: axisY + 32,
    countY: axisY + 46,
    titleY: H - 4,
    bars,
    promise,
    grid,
  };
}

/** The visible summary, which also names the chart. */
export function confidenceSummary(levels) {
  const used = levels.filter((l) => l.games > 0);
  if (used.length === 0) return "Confidence chart: no graded picks yet.";
  const parts = used.map((l) => `${Math.round(l.pct)}% at ${l.confidence} (${l.right} of ${l.games})`);
  // Only levels with a few picks count toward the verdict: one lucky pick
  // must not decide whether your confidence means something.
  const solid = used.filter((l) => l.games >= 3);
  const climbs = solid.every((l, i) => i === 0 || l.pct >= solid[i - 1].pct);
  const verdict =
    solid.length < 2
      ? "Too few picks at most levels to see a pattern yet."
      : climbs
        ? "Your record climbs with your confidence, which is what a well-calibrated record does."
        : "Your record does not climb steadily with your confidence yet.";
  return `Confidence chart: you were right ${parts.join(", ")}. ${verdict}`;
}

function round(n) {
  return Math.round(n * 10) / 10;
}
