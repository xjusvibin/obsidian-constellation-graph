/** Rounds in a room: first to a number of kills, or the most kills when the time is up. The host starts one; every computer keeps its own count from the kill messages, so they agree. */
export interface RoundMsg { mode: "kills" | "time"; n: number; secs: number }

export const ROUND_PRESETS: { key: string; label: string; round: RoundMsg | null }[] = [
  { key: "free", label: "Free flight (no round)", round: null },
  { key: "k5", label: "First to 5 kills", round: { mode: "kills", n: 5, secs: 0 } },
  { key: "k10", label: "First to 10 kills", round: { mode: "kills", n: 10, secs: 0 } },
  { key: "t3", label: "Three minutes, most kills", round: { mode: "time", n: 0, secs: 180 } },
  { key: "t5", label: "Five minutes, most kills", round: { mode: "time", n: 0, secs: 300 } },
];

export function validRound(v: unknown): v is RoundMsg {
  if (!v || typeof v !== "object") return false;
  const r = v as RoundMsg;
  if (r.mode === "kills") return Number.isSafeInteger(r.n) && r.n >= 3 && r.n <= 50 && r.secs === 0;
  if (r.mode === "time") return r.n === 0 && Number.isSafeInteger(r.secs) && r.secs >= 30 && r.secs <= 1800;
  return false;
}

export function describeRound(r: RoundMsg): string { return r.mode === "kills" ? `first to ${r.n} kills` : `${Math.round(r.secs / 60 * 10) / 10} minutes, most kills`; }

export interface Tally { id: string; kills: number; deaths: number }

/** Who wins: the most kills, then the fewest deaths. More than one id means a draw. */
export function roundWinners(tallies: readonly Tally[]): string[] {
  if (!tallies.length) return [];
  const best = [...tallies].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
  return tallies.filter(t => t.kills === best.kills && t.deaths === best.deaths).map(t => t.id);
}

/** Has a first-to-N round been won? */
export function reachedTarget(r: RoundMsg, tallies: readonly Tally[]): boolean { return r.mode === "kills" && tallies.some(t => t.kills >= r.n); }
