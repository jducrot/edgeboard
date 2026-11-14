import Link from "next/link";
import { GameCard } from "@/components/GameCard";
import { listPredictions } from "@/lib/db";
import {
  getInjuriesByTeamId,
  getOdds,
  getRestByTeamId,
  getScoreboard,
  getTeamFormByTeamId,
  slateDateEt,
} from "@/lib/espn";

export const dynamic = "force-dynamic";

function labelFor(yyyymmdd: string): string {
  const d = new Date(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00Z`,
  );
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export default async function SlatePage({
  searchParams,
}: PageProps<"/">) {
  const sp = await searchParams;
  const requested = typeof sp.date === "string" ? sp.date : undefined;
  const today = slateDateEt();
  const date = requested && /^\d{8}$/.test(requested) ? requested : today;

  const [games, form, injuries, rest] = await Promise.all([
    getScoreboard(date),
    getTeamFormByTeamId(),
    getInjuriesByTeamId(),
    getRestByTeamId(date),
  ]);
  const oddsList = await Promise.all(games.map((g) => getOdds(g.id)));
  const predicted = new Set(listPredictions().map((p) => p.gameId));

  const dayNav = [
    { date: slateDateEt(-1), label: "Yesterday" },
    { date: today, label: "Today" },
    { date: slateDateEt(1), label: "Tomorrow" },
  ];

  return (
    <>
      <h1 className="text-2xl font-bold">NBA slate: {labelFor(date)}</h1>

      <nav aria-label="Slate date" className="mt-3">
        <ul className="flex flex-wrap gap-2">
          {dayNav.map((d) => (
            <li key={d.date}>
              <Link
                href={`/?date=${d.date}`}
                aria-current={d.date === date ? "page" : undefined}
                className={`inline-block min-h-11 rounded border px-4 py-2 font-medium focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 dark:focus-visible:outline-indigo-300 ${
                  d.date === date
                    ? "border-indigo-700 bg-indigo-700 text-white dark:border-indigo-300 dark:bg-indigo-300 dark:text-zinc-950"
                    : "border-zinc-400 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {d.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {games.length === 0 ? (
        <p className="mt-6">No NBA games on this date.</p>
      ) : (
        <ul className="mt-6 grid list-none gap-4 p-0 lg:grid-cols-2">
          {games.map((g, i) => (
            <li key={g.id}>
              <GameCard
                game={g}
                odds={oddsList[i]}
                homeForm={form.get(g.home.id) ?? null}
                awayForm={form.get(g.away.id) ?? null}
                homeInjuries={injuries.get(g.home.id) ?? []}
                awayInjuries={injuries.get(g.away.id) ?? []}
                homeRest={rest.get(g.home.id) ?? null}
                awayRest={rest.get(g.away.id) ?? null}
                slateDate={date}
                hasPrediction={predicted.has(g.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
