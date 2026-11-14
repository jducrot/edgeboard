import type { Metadata } from "next";
import { reconcilePending } from "@/app/actions";
import { RetroForm } from "@/components/RetroForm";
import { listPredictions } from "@/lib/db";
import type { GameSnapshot, PredictionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Review" };

function outcome(p: PredictionRow): string {
  if (p.reconciledAtUtc === null) return "Awaiting result";
  return p.pickCorrect ? "Correct" : "Incorrect";
}

function SnapshotSummary({ p }: { p: PredictionRow }) {
  let snap: GameSnapshot | null = null;
  try {
    snap = JSON.parse(p.snapshotJson) as GameSnapshot;
  } catch {
    return null;
  }
  if (!snap?.game) return null;
  const inj = (items: { athlete: string; status: string }[] | undefined) =>
    !items || items.length === 0
      ? "none listed"
      : items.map((i) => `${i.athlete} (${i.status})`).join(", ");
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer rounded py-1 font-medium underline underline-offset-4">
        Inputs snapshotted at prediction time
      </summary>
      <dl className="mt-2 space-y-1">
        <div>
          <dt className="inline font-semibold">Line: </dt>
          <dd className="inline">
            {snap.odds
              ? `${snap.odds.details ?? "no spread"}, total ${snap.odds.overUnder ?? "–"} (${snap.odds.provider})`
              : "none posted"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">
            {snap.game.away.abbreviation} form:{" "}
          </dt>
          <dd className="inline">
            {snap.awayForm
              ? `${snap.awayForm.wins}-${snap.awayForm.losses}, last 10: ${snap.awayForm.lastTen ?? "–"}, diff ${snap.awayForm.pointDifferential ?? "–"}`
              : "–"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">
            {snap.game.home.abbreviation} form:{" "}
          </dt>
          <dd className="inline">
            {snap.homeForm
              ? `${snap.homeForm.wins}-${snap.homeForm.losses}, last 10: ${snap.homeForm.lastTen ?? "–"}, diff ${snap.homeForm.pointDifferential ?? "–"}`
              : "–"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">
            {snap.game.away.abbreviation} injuries:{" "}
          </dt>
          <dd className="inline">{inj(snap.awayInjuries)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">
            {snap.game.home.abbreviation} injuries:{" "}
          </dt>
          <dd className="inline">{inj(snap.homeInjuries)}</dd>
        </div>
      </dl>
    </details>
  );
}

export default async function ReviewPage() {
  await reconcilePending();
  const predictions = listPredictions();

  const graded = predictions.filter((p) => p.reconciledAtUtc !== null);
  const correct = graded.filter((p) => p.pickCorrect === 1).length;

  return (
    <>
      <h1 className="text-2xl font-bold">Prediction review</h1>

      <p className="mt-2">
        {predictions.length === 0
          ? "No predictions logged yet. Pick a game on the Slate page to start."
          : `Record so far: ${correct} correct of ${graded.length} graded (${predictions.length - graded.length} awaiting results).`}
      </p>

      <ul className="mt-6 grid list-none gap-4 p-0">
        {predictions.map((p) => {
          const result = outcome(p);
          return (
            <li key={p.id}>
              <article
                aria-labelledby={`pred-${p.id}-heading`}
                className="rounded-lg border border-zinc-300 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <h2 id={`pred-${p.id}-heading`} className="text-lg font-bold">
                  {p.gameLabel} — {p.gameDateEt}
                </h2>
                <p className="mt-1">
                  <span className="font-semibold">Pick:</span> {p.pickTeam} to win
                  {p.predictedMargin !== null ? ` by ${p.predictedMargin}` : ""}
                  {", confidence "}
                  {p.confidence}/5.{" "}
                  <span className="font-semibold">Line at prediction:</span>{" "}
                  {p.lineAtPrediction ?? "none posted"}
                </p>
                <p className="mt-1">
                  <span className="font-semibold">Result:</span>{" "}
                  {p.reconciledAtUtc !== null &&
                  p.finalAwayScore !== null &&
                  p.finalHomeScore !== null
                    ? `${result} — final ${p.finalAwayScore}–${p.finalHomeScore}`
                    : result}
                </p>
                <p className="mt-1 text-sm">
                  <span className="font-semibold">Your reasoning:</span>{" "}
                  {p.reasoning}
                </p>

                <SnapshotSummary p={p} />

                {p.reconciledAtUtc !== null ? (
                  p.retroAtUtc !== null ? (
                    <div className="mt-3 border-t border-zinc-300 pt-3 text-sm dark:border-zinc-700">
                      <h3 className="font-semibold">Retrospective</h3>
                      <p className="mt-1">
                        {p.retroTags
                          ? (JSON.parse(p.retroTags) as string[]).join(", ")
                          : ""}
                        {p.retroNotes ? ` — ${p.retroNotes}` : ""}
                      </p>
                    </div>
                  ) : (
                    <RetroForm predictionId={p.id} />
                  )
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </>
  );
}
