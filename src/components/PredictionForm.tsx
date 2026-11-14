"use client";

import { useActionState, useId } from "react";
import { savePrediction, type ActionResult } from "@/app/actions";
import type { GameSummary } from "@/lib/types";

export function PredictionForm({
  game,
  slateDate,
}: {
  game: GameSummary;
  slateDate: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    savePrediction,
    null,
  );
  const uid = useId();
  const reasoningId = `${uid}-reasoning`;
  const marginId = `${uid}-margin`;
  const confidenceId = `${uid}-confidence`;
  const messageId = `${uid}-message`;

  return (
    <form action={formAction} className="mt-4 border-t border-zinc-300 pt-4 dark:border-zinc-700">
      <input type="hidden" name="gameId" value={game.id} />
      <input type="hidden" name="slateDate" value={slateDate} />

      <h4 className="font-semibold">Log a prediction</h4>

      <fieldset className="mt-2">
        <legend className="text-sm font-medium">Who wins?</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="pick"
              value="away"
              required
              className="size-5 accent-indigo-700"
            />
            <span>{game.away.displayName} (away)</span>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="pick"
              value="home"
              required
              className="size-5 accent-indigo-700"
            />
            <span>{game.home.displayName} (home)</span>
          </label>
        </div>
      </fieldset>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={marginId} className="block text-sm font-medium">
            Predicted margin (points, optional)
          </label>
          <input
            id={marginId}
            name="predictedMargin"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            className="mt-1 w-full rounded border border-zinc-500 bg-white px-3 py-2 dark:border-zinc-400 dark:bg-zinc-900"
          />
        </div>
        <div>
          <label htmlFor={confidenceId} className="block text-sm font-medium">
            Confidence (1 = coin flip, 5 = lock)
          </label>
          <select
            id={confidenceId}
            name="confidence"
            required
            defaultValue="3"
            className="mt-1 w-full rounded border border-zinc-500 bg-white px-3 py-2 dark:border-zinc-400 dark:bg-zinc-900"
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor={reasoningId} className="block text-sm font-medium">
          Reasoning (required, this is what the retrospective checks)
        </label>
        <textarea
          id={reasoningId}
          name="reasoning"
          required
          minLength={10}
          rows={3}
          aria-describedby={messageId}
          className="mt-1 w-full rounded border border-zinc-500 bg-white px-3 py-2 dark:border-zinc-400 dark:bg-zinc-900"
        />
      </div>

      <button
        type="submit"
        disabled={pending || state?.ok === true}
        className="mt-3 min-h-11 rounded bg-indigo-700 px-4 py-2 font-semibold text-white hover:bg-indigo-800 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 disabled:opacity-60 dark:focus-visible:outline-indigo-300"
      >
        {pending ? "Saving…" : state?.ok ? "Prediction saved" : "Save prediction and snapshot inputs"}
      </button>

      <p id={messageId} role="status" className="mt-2 min-h-6 text-sm font-medium">
        {state ? (
          <span
            className={
              state.ok
                ? "text-green-800 dark:text-green-300"
                : "text-red-800 dark:text-red-300"
            }
          >
            {state.message}
          </span>
        ) : null}
      </p>
    </form>
  );
}
