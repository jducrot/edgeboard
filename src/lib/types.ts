// Domain types for EdgeBoard.

export interface TeamSide {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  logo?: string;
  record?: string; // e.g. "9-4"
  homeAway: "home" | "away";
  score?: number;
  winner?: boolean;
}

export interface GameSummary {
  id: string;
  dateUtc: string; // ISO
  name: string;
  shortName: string;
  statusState: "pre" | "in" | "post";
  statusDetail: string; // e.g. "Fri, November 14th at 7:00 PM EST" or "Final"
  home: TeamSide;
  away: TeamSide;
}

export interface OddsSnapshot {
  provider: string;
  details: string | null; // e.g. "NY -7.5"
  overUnder: number | null;
  spread: number | null;
  awayMoneyline: number | null;
  homeMoneyline: number | null;
  openTotal: number | null;
  currentTotal: number | null;
  openAwaySpread: number | null;
  currentAwaySpread: number | null;
  fetchedAtUtc: string;
}

export interface InjuryItem {
  athlete: string;
  position: string | null;
  status: string; // "Out", "Day-To-Day", ...
  comment: string | null;
  dateUtc: string | null;
}

export interface TeamForm {
  teamId: string;
  abbreviation: string;
  wins: number;
  losses: number;
  avgPointsFor: number | null;
  avgPointsAgainst: number | null;
  pointDifferential: number | null;
  streak: string | null; // "W3" / "L9"
  lastTen: string | null; // "7-3"
}

export interface RestInfo {
  lastGameDateEt: string | null; // YYYY-MM-DD in ET, null if not in lookback window
  daysOfRest: number | null; // null means "more than lookback window"
  backToBack: boolean;
}

/** Everything the app knew about a game at a moment in time. */
export interface GameSnapshot {
  game: GameSummary;
  odds: OddsSnapshot | null;
  homeForm: TeamForm | null;
  awayForm: TeamForm | null;
  homeInjuries: InjuryItem[];
  awayInjuries: InjuryItem[];
  homeRest: RestInfo | null;
  awayRest: RestInfo | null;
  capturedAtUtc: string;
}

export type PickSide = "home" | "away";

export interface PredictionRow {
  id: number;
  gameId: string;
  gameDateEt: string; // YYYY-MM-DD
  gameLabel: string; // "NY @ IND"
  pick: PickSide;
  pickTeam: string; // abbreviation
  predictedMargin: number | null;
  confidence: number; // 1-5
  reasoning: string;
  lineAtPrediction: string | null; // e.g. "NY -7.5"
  snapshotJson: string;
  createdAtUtc: string;
  // reconciliation
  finalHomeScore: number | null;
  finalAwayScore: number | null;
  pickCorrect: number | null; // 0/1
  reconciledAtUtc: string | null;
  // retrospective
  retroTags: string | null; // JSON array of tags
  retroNotes: string | null;
  retroAtUtc: string | null;
}

export const RETRO_TAGS = [
  "In-game injury",
  "Lineup or rotation change",
  "Signal we were not tracking",
  "Variance / fluke",
  "Market was right",
  "My read was right",
] as const;
