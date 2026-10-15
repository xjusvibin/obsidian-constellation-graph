import { RelayChannel, cleanRelayUrl, type PostFn } from "./relay";
import { parseRoomCode } from "./netcrypto";
import { cleanName } from "./room";

/**
 * The lobby browser. There is no server: a host who turns on "List this room publicly" posts a small plain announcement to one
 * fixed public topic on the relay every few seconds, and anyone browsing reads that topic. Everything here is untrusted: any
 * announcement is checked, cleaned, rate limited and capped before it is shown, and one is never trusted to be honest.
 * An announcement holds only the room code, a name and a pilot count. Nothing about a vault is in it.
 */
export const LOBBY_TOPIC = "starfield-lobbies-v1";
export const LISTING_EVERY_MS = 15_000;  // how often a listed room announces itself
export const LISTING_TTL_MS = 45_000;    // a room not heard from for this long is no longer shown
export const MIN_GAP_MS = 10_000;        // a room that announces faster than this is ignored (spam)
export const MAX_LISTED = 30;            // never more rooms than this on screen
const MAX_TEXT = 400;

export interface Listing { code: string; name: string; pilots: number }

/** Read one announcement: only the exact shape, a valid code, a cleaned name and a pilot count from one to four. */
export function parseListing(text: string): Listing | null {
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  let v: unknown; try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as { v?: unknown; code?: unknown; name?: unknown; n?: unknown };
  if (o.v !== 1 || typeof o.code !== "string" || typeof o.name !== "string" || !Number.isInteger(o.n)) return null;
  const code = parseRoomCode(o.code), n = o.n as number;
  if (!code || n < 1 || n > 4) return null;
  return { code, name: cleanName(o.name), pilots: n };
}

export function announcement(l: Listing): string { return JSON.stringify({ v: 1, code: l.code, name: l.name, n: l.pilots }); }

/** The rooms heard lately, with the limits that keep one noisy sender from filling the screen. */
export class LobbyBoard {
  private rooms = new Map<string, { listing: Listing; seenAt: number }>();

  /** Take in one announcement. True if it changed what is listed. */
  ingest(text: string, now: number): boolean {
    const l = parseListing(text); if (!l) return false;
    const old = this.rooms.get(l.code);
    if (old && now - old.seenAt < MIN_GAP_MS) return false; // announcing faster than allowed: ignored
    if (!old && this.rooms.size >= MAX_LISTED * 2) { // the table itself is capped, dropping the oldest
      let oldest = ""; let at = Infinity;
      for (const [k, v] of this.rooms) if (v.seenAt < at) { at = v.seenAt; oldest = k; }
      this.rooms.delete(oldest);
    }
    this.rooms.set(l.code, { listing: l, seenAt: now });
    return true;
  }

  /** The rooms to show now: heard within the last 45 seconds, fullest first, at most 30. */
  list(now: number, hideCode = ""): Listing[] {
    for (const [k, v] of this.rooms) if (now - v.seenAt > LISTING_TTL_MS) this.rooms.delete(k);
    return [...this.rooms.values()].map(v => v.listing).filter(l => l.code !== hideCode && l.pilots < 4)
      .sort((a, b) => b.pilots - a.pilots || a.name.localeCompare(b.name)).slice(0, MAX_LISTED);
  }

  clear(): void { this.rooms.clear(); }
}

/** Announces one room until stopped. */
export class LobbyPublisher {
  private timer = 0;
  private channel: RelayChannel;

  constructor(relayUrl: string, post: PostFn, private current: () => Listing | null) {
    const base = cleanRelayUrl(relayUrl) ?? "";
    this.channel = new RelayChannel(base, LOBBY_TOPIC, post, () => undefined, () => undefined);
  }

  start(): void {
    this.stop();
    const send = () => { const l = this.current(); if (l) void this.channel.publish(announcement(l)).catch(() => undefined); };
    send(); this.timer = window.setInterval(send, LISTING_EVERY_MS);
  }

  stop(): void { window.clearInterval(this.timer); this.timer = 0; }
}

/** Listens to the board while a panel is showing it. */
export class LobbyBrowser {
  private channel: RelayChannel;
  private board = new LobbyBoard();
  private poll = 0;
  private last = "";

  constructor(relayUrl: string, post: PostFn, private hideCode: () => string, private onRooms: (rooms: Listing[]) => void, private onProblem: (text: string) => void) {
    const base = cleanRelayUrl(relayUrl) ?? "";
    this.channel = new RelayChannel(base, LOBBY_TOPIC, post, text => { this.board.ingest(text, Date.now()); this.emit(); }, onProblem);
  }

  start(): void {
    this.channel.start(Math.ceil(LISTING_TTL_MS / 1000)); // announcements from the last 45 seconds arrive at once
    this.poll = window.setInterval(() => this.emit(), 3000);  // rooms also drop off the list as they go quiet
    this.emit();
  }

  stop(): void { window.clearInterval(this.poll); this.poll = 0; this.channel.stop(); this.board.clear(); }

  private emit(): void {
    const rooms = this.board.list(Date.now(), this.hideCode()), key = JSON.stringify(rooms);
    if (key !== this.last) { this.last = key; this.onRooms(rooms); }
  }
}
