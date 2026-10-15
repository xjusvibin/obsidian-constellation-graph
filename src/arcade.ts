import { RelayChannel, cleanRelayUrl, type PostFn } from "./relay";

/**
 * The arcade run: flying alone against waves of practice drones for three minutes. The score is waves cleared and drones shot;
 * when time is up an arcade-style screen asks for a name (if it is a high score) and shows the table.
 * The table is kept on this computer. A pilot can also choose to put one score on the public board (a topic on the relay, like the
 * room list): only a name and the score go out, scores there are not verified, and the relay only keeps them for about half a day.
 */
export const RUN_SECONDS = 180;
export const TABLE_SIZE = 10;
export const NAME_MAX = 12;

export interface ScoreEntry { name: string; score: number; waves: number; kills: number; at: number }

export const runScore = (waves: number, kills: number): number => waves * 1000 + kills * 100;

/** Arcade names: capital letters, digits, space, dot, dash and underscore, up to twelve; never empty. */
export function cleanScoreName(input: unknown): string {
  const s = typeof input === "string" ? input.toUpperCase().replace(/[^A-Z0-9 ._-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim() : "";
  return s || "PILOT";
}

const isCount = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** The fewest drones a pilot must have shot to have cleared this many waves (wave n has min(8, 1 + n) drones). */
export function minKills(waves: number): number { let n = 0; for (let i = 1; i <= waves; i++) n += Math.min(8, 1 + i); return n; }

/** Does a score hang together? The score must follow from the waves and kills, and the kills must fit the waves. It cannot stop a determined faker, only a careless one. */
export function plausible(e: { score: number; waves: number; kills: number }): boolean {
  return isCount(e.waves, 40) && isCount(e.kills, 400) && e.score === runScore(e.waves, e.kills) && e.kills >= minKills(e.waves) && e.kills <= minKills(e.waves) + 8;
}

function validEntry(v: unknown): v is ScoreEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as ScoreEntry;
  return typeof e.name === "string" && e.name === cleanScoreName(e.name) && Number.isSafeInteger(e.at) && e.at >= 0 && plausible(e);
}

const order = (a: ScoreEntry, b: ScoreEntry): number => b.score - a.score || a.at - b.at; // a tie keeps the older score on top

/** Read the stored table: only good entries, best first, at most ten. */
export function sanitizeTable(raw: unknown): ScoreEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(validEntry).map(e => ({ name: e.name, score: e.score, waves: e.waves, kills: e.kills, at: e.at })).sort(order).slice(0, TABLE_SIZE);
}

export function qualifies(table: readonly ScoreEntry[], score: number): boolean {
  return score > 0 && (table.length < TABLE_SIZE || score > table[table.length - 1].score);
}

/** Put a score in the table. Returns the new table and the place it took (1 is the top), or 0 if it did not make it. */
export function insertScore(table: readonly ScoreEntry[], entry: ScoreEntry): { table: ScoreEntry[]; rank: number } {
  const next = [...table, entry].sort(order).slice(0, TABLE_SIZE);
  const i = next.indexOf(entry);
  return { table: next, rank: i < 0 ? 0 : i + 1 };
}

// ---------------------------------------------------------------- the public board

export const SCORES_TOPIC = "starfield-scores-v1";
export const SCORES_KEEP_SECONDS = 43_200; // the relay keeps messages about twelve hours
const MAX_TEXT = 200;
const MAX_STORED = 300;

export function scoreMessage(e: ScoreEntry): string { return JSON.stringify({ v: 1, n: e.name, w: e.waves, k: e.kills, s: e.score }); }

/** Read one board message: only the exact shape, a clean name, and a score that hangs together. */
export function parseScoreMessage(text: string, now: number): ScoreEntry | null {
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  let v: unknown; try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as { v?: unknown; n?: unknown; w?: unknown; k?: unknown; s?: unknown };
  if (o.v !== 1 || typeof o.n !== "string" || !isCount(o.w, 40) || !isCount(o.k, 400) || !isCount(o.s, 99999)) return null;
  const e: ScoreEntry = { name: cleanScoreName(o.n), score: o.s, waves: o.w, kills: o.k, at: now };
  return plausible(e) && e.score > 0 ? e : null;
}

/** The scores heard lately: the same name and score twice counts once, the table is capped, and only the best ten are shown. */
export class PublicBoard {
  private rows = new Map<string, ScoreEntry>();

  ingest(text: string, now: number): boolean {
    const e = parseScoreMessage(text, now); if (!e) return false;
    const key = `${e.name}|${e.score}`;
    if (this.rows.has(key)) return false;
    if (this.rows.size >= MAX_STORED) { let worst = ""; let low = Infinity; for (const [k, r] of this.rows) if (r.score < low) { low = r.score; worst = k; } if (e.score <= low) return false; this.rows.delete(worst); }
    this.rows.set(key, e); return true;
  }

  top(): ScoreEntry[] { return [...this.rows.values()].sort(order).slice(0, TABLE_SIZE); }
  clear(): void { this.rows.clear(); }
}

/** Put one score on the public board. Only the name and the score are sent. */
export async function submitScore(relayUrl: string, post: PostFn, entry: ScoreEntry): Promise<void> {
  const base = cleanRelayUrl(relayUrl); if (!base) throw new Error("The relay address in the settings is not valid.");
  if (!plausible(entry)) throw new Error("That score does not look right, so it was not sent.");
  await new RelayChannel(base, SCORES_TOPIC, post, () => undefined, () => undefined).publish(scoreMessage(entry));
}

/** Read the public board while a screen shows it. Returns the function that stops reading. */
export function watchScores(relayUrl: string, onRows: (rows: ScoreEntry[]) => void, onProblem: (text: string) => void): () => void {
  const base = cleanRelayUrl(relayUrl);
  if (!base) { onProblem("The relay address in the settings is not valid."); return () => undefined; }
  const board = new PublicBoard();
  const channel = new RelayChannel(base, SCORES_TOPIC, async () => 0, text => { if (board.ingest(text, Date.now())) onRows(board.top()); }, onProblem);
  channel.start(SCORES_KEEP_SECONDS);
  return () => { channel.stop(); board.clear(); };
}
