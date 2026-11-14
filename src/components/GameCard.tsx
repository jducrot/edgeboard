import type {
  GameSummary,
  InjuryItem,
  OddsSnapshot,
  RestInfo,
  TeamForm,
} from "@/lib/types";
import { PredictionForm } from "./PredictionForm";

function fmt(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? "–" : n.toFixed(digits);
}

function restLabel(rest: RestInfo | null): string {
  if (!rest) return "4+ days rest";
  if (rest.backToBack) return "Back-to-back (0 days rest)";
  if (rest.daysOfRest === 1) return "1 day rest";
  return `${rest.daysOfRest} days rest`;
}

function MovementNote({ odds }: { odds: OddsSnapshot }) {
  const notes: string[] = [];
  if (
    odds.openTotal !== null &&
    odds.currentTotal !== null &&
    odds.openTotal !== odds.currentTotal
  ) {
    const dir = odds.currentTotal < odds.openTotal ? "down" : "up";
    notes.push(`Total moved ${dir} from ${odds.openTotal} to ${odds.currentTotal}`);
  }
  if (
    odds.openAwaySpread !== null &&
    odds.currentAwaySpread !== null &&
    odds.openAwaySpread !== odds.currentAwaySpread
  ) {
    notes.push(
      `Away spread moved from ${odds.openAwaySpread} to ${odds.currentAwaySpread}`,
    );
  }
  if (notes.length === 0) return null;
  return (
    <p className="mt-1 text-sm font-medium text-amber-900 dark:text-amber-300">
      Line movement: {notes.join(". ")}.
    </p>
  );
}

function InjuryList({ team, items }: { team: string; items: InjuryItem[] }) {
  const notable = items.filter((i) => i.status.toLowerCase() !== "day-to-day");
  const dtd = items.length - notable.length;
  return (
    <div>
      <h4 className="font-semibold">{team} injuries</h4>
      {items.length === 0 ? (
        <p className="text-sm">No players listed.</p>
      ) : (
        <>
          <ul className="mt-1 space-y-1 text-sm">
            {(notable.length > 0 ? notable : items).slice(0, 4).map((i) => (
              <li key={`${i.athlete}-${i.status}`}>
                <span className="font-medium">{i.athlete}</span>
                {i.position ? ` (${i.position})` : ""} — {i.status}
                {i.comment ? `. ${i.comment}` : ""}
              </li>
            ))}
          </ul>
          {items.length > 4 || (notable.length > 0 && dtd > 0) ? (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer rounded py-1 font-medium underline underline-offset-4">
                Full list ({items.length} players)
              </summary>
              <ul className="mt-1 space-y-1">
                {items.map((i) => (
                  <li key={`all-${i.athlete}-${i.status}`}>
                    <span className="font-medium">{i.athlete}</span>
                    {i.position ? ` (${i.position})` : ""} — {i.status}
                    {i.comment ? `. ${i.comment}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

export function GameCard({
  game,
  odds,
  homeForm,
  awayForm,
  homeInjuries,
  awayInjuries,
  homeRest,
  awayRest,
  slateDate,
  hasPrediction,
}: {
  game: GameSummary;
  odds: OddsSnapshot | null;
  homeForm: TeamForm | null;
  awayForm: TeamForm | null;
  homeInjuries: InjuryItem[];
  awayInjuries: InjuryItem[];
  homeRest: RestInfo | null;
  awayRest: RestInfo | null;
  slateDate: string;
  hasPrediction: boolean;
}) {
  const isFinal = game.statusState === "post";
  const headingId = `game-${game.id}-heading`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-lg border border-zinc-300 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <h2 id={headingId} className="text-lg font-bold">
        {game.away.displayName} at {game.home.displayName}
      </h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {game.statusDetail}
        {isFinal && game.home.score !== undefined && game.away.score !== undefined
          ? ` — ${game.away.abbreviation} ${game.away.score}, ${game.home.abbreviation} ${game.home.score}`
          : ""}
      </p>

      {odds ? (
        <div className="mt-3">
          <h3 className="sr-only">Betting line</h3>
          <p className="text-sm">
            <span className="font-semibold">{odds.provider}:</span>{" "}
            {odds.details ?? "No spread posted"}
            {odds.overUnder !== null ? `, total ${odds.overUnder}` : ""}
            {odds.awayMoneyline !== null && odds.homeMoneyline !== null
              ? `. Moneyline: ${game.away.abbreviation} ${odds.awayMoneyline > 0 ? "+" : ""}${odds.awayMoneyline}, ${game.home.abbreviation} ${odds.homeMoneyline > 0 ? "+" : ""}${odds.homeMoneyline}`
              : ""}
          </p>
          <MovementNote odds={odds} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
          No betting line posted yet.
        </p>
      )}

      <h3 className="sr-only">Team comparison</h3>
      <table className="mt-3 w-full border-collapse text-sm">
        <caption className="sr-only">
          Season form comparison for {game.away.displayName} and {game.home.displayName}
        </caption>
        <thead>
          <tr className="border-b border-zinc-300 text-left dark:border-zinc-700">
            <th scope="col" className="py-1 pr-2 font-semibold">
              Signal
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              {game.away.abbreviation} (away)
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              {game.home.abbreviation} (home)
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th scope="row" className="py-1 pr-2 text-left font-medium">
              Record
            </th>
            <td className="px-2 py-1">{game.away.record ?? "–"}</td>
            <td className="px-2 py-1">{game.home.record ?? "–"}</td>
          </tr>
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th scope="row" className="py-1 pr-2 text-left font-medium">
              Points for / against
            </th>
            <td className="px-2 py-1">
              {fmt(awayForm?.avgPointsFor)} / {fmt(awayForm?.avgPointsAgainst)}
            </td>
            <td className="px-2 py-1">
              {fmt(homeForm?.avgPointsFor)} / {fmt(homeForm?.avgPointsAgainst)}
            </td>
          </tr>
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th scope="row" className="py-1 pr-2 text-left font-medium">
              Last 10 / streak
            </th>
            <td className="px-2 py-1">
              {awayForm?.lastTen ?? "–"} / {awayForm?.streak ?? "–"}
            </td>
            <td className="px-2 py-1">
              {homeForm?.lastTen ?? "–"} / {homeForm?.streak ?? "–"}
            </td>
          </tr>
          <tr>
            <th scope="row" className="py-1 pr-2 text-left font-medium">
              Rest
            </th>
            <td className="px-2 py-1">{restLabel(awayRest)}</td>
            <td className="px-2 py-1">{restLabel(homeRest)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <InjuryList team={game.away.displayName} items={awayInjuries} />
        <InjuryList team={game.home.displayName} items={homeInjuries} />
      </div>

      {game.statusState === "pre" ? (
        hasPrediction ? (
          <p className="mt-4 border-t border-zinc-300 pt-4 text-sm font-medium dark:border-zinc-700">
            Prediction logged for this game. See it on the Review page.
          </p>
        ) : (
          <PredictionForm game={game} slateDate={slateDate} />
        )
      ) : null}
    </article>
  );
}
