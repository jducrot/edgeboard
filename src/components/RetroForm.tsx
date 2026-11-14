"use client";

import { useActionState, useId } from "react";
import { saveRetroAction, type ActionResult } from "@/app/actions";
import { RETRO_TAGS } from "@/lib/types";

export function RetroForm({ predictionId }: { predictionId: number }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    saveRetroAction,
    null,
  );
  const uid = useId();
  const notesId = `${uid}-notes`;
  const messageId = `${uid}-message`;

  return (
    <form action={formAction} className="mt-3 border-t border-zinc-300 pt-3 dark:border-zinc-700">
      <input type="hidden" name="predictionId" value={predictionId} />
      <fieldset>
        <legend className="font-semibold">
          Retrospective: why did this land the way it did?
        </legend>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {RETRO_TAGS.map((tag) => (
            <label key={tag} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={`tag:${tag}`}
                className="size-5 accent-indigo-700"
              />
              <span>{tag}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-2">
        <label htmlFor={notesId} className="block text-sm font-medium">
          Notes (what would you track or weigh differently next time?)
        </label>
        <textarea
          id={notesId}
          name="notes"
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
        {pending ? "Saving…" : state?.ok ? "Retrospective saved" : "Save retrospective"}
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
