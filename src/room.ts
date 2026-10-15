import { deriveRoomKeys, makeRoomCode, parseRoomCode, seal, unseal, type RoomKeys } from "./netcrypto";
import { RelayChannel, cleanRelayUrl, type PostFn } from "./relay";

export interface RoomMember { id: string; name: string; joinedAt: number; slot: number }
export const ROOM_CAPACITY = 4;
/**
 * The room protocol version. Every hello carries the sender's, and the roster answer carries the oldest one this room still
 * accepts. A pilot who is too old is told (if they can read it) to update; a pilot whose plugin is older than the room's
 * minimum is refused, rather than joining a room they would half understand. Bump PROTOCOL when messages change; raise MIN_PROTOCOL
 * only when an old pilot could no longer play safely.
 */
export const PROTOCOL = 2;
export const MIN_PROTOCOL = 1;
const UPDATE_TEXT = "This room needs a different version of Starfield Graph. Everyone in a room should update to the latest version, then try again.";

export interface RoomCallbacks {
  /** The list of pilots changed (this includes you). */
  roster(members: RoomMember[], selfId: string): void;
  /** A connection-set-up message from another pilot. */
  signal(from: string, data: unknown): void;
  status(text: string, error?: boolean): void;
}

/** Where sealed messages go and come from. The real one is a public relay; tests use an in-memory stand-in. */
export interface RoomTransport { publish(text: string): Promise<void>; start(sinceSeconds?: number): void; stop(): void }
export type TransportFactory = (topic: string, onText: (text: string) => void, onProblem: (text: string) => void) => RoomTransport;

const NAME_MAX = 24;
const JOIN_TIMEOUT_MS = 20_000;
const HELLO_RETRY_MS = [4_000, 10_000];
const uuid = /^[0-9a-f-]{36}$/i;

/** Pilots whose names are shown to others: printable, no markup, never empty. */
export function cleanName(input: unknown): string {
  const s = typeof input === "string" ? input.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, NAME_MAX) : "";
  return s || "Pilot";
}

function validMembers(value: unknown): value is RoomMember[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROOM_CAPACITY) return false;
  const ids = new Set<string>(), slots = new Set<number>();
  for (const m of value) {
    if (!m || typeof m !== "object") return false;
    const x = m as RoomMember;
    if (typeof x.id !== "string" || !uuid.test(x.id) || ids.has(x.id) || typeof x.name !== "string" || x.name.length > NAME_MAX
      || !Number.isSafeInteger(x.joinedAt) || !Number.isInteger(x.slot) || x.slot < 0 || x.slot >= ROOM_CAPACITY || slots.has(x.slot)) return false;
    ids.add(x.id); slots.add(x.slot);
  }
  return true;
}

/**
 * A room of up to four pilots that finds its members through a relay. The relay is only a mailbox: every message is sealed
 * with a key made from the room code. The pilot who has been in the room longest answers newcomers and hands out the
 * four places (and if they leave, the next one takes over), so there is no server to run and nobody is in charge of the game.
 */
export class RelayRoom {
  private keys: RoomKeys | null = null;
  private transport: RoomTransport | null = null;
  private roomCode = "";
  private id = "";
  private name = "";
  private list: RoomMember[] = [];
  private closed = true;
  private pending: { resolve: () => void; reject: (e: Error) => void; timers: number[] } | null = null;
  private seenNonces = new Set<string>();

  constructor(private relayUrl: string, private cb: RoomCallbacks, private makeTransport?: TransportFactory, private post?: PostFn) {}

  get code(): string { return this.roomCode; }
  get selfId(): string { return this.id; }
  get members(): RoomMember[] { return this.list; }
  get active(): boolean { return !this.closed && !!this.id && this.list.some(m => m.id === this.id); }

  async create(name: string): Promise<string> {
    await this.open(makeRoomCode(), name);
    const me: RoomMember = { id: this.id, name: this.name, joinedAt: Date.now(), slot: 0 };
    this.list = [me]; this.cb.roster(this.list, this.id);
    return this.roomCode;
  }

  async join(codeInput: string, name: string): Promise<void> {
    const code = parseRoomCode(codeInput);
    if (!code) throw new Error("That is not a room code. It is ten letters and numbers, like ABCDE-FGHJK.");
    await this.open(code, name);
    const wait = new Promise<void>((resolve, reject) => {
      const timers: number[] = [];
      this.pending = { resolve, reject, timers };
      void this.sendHello();
      for (const t of HELLO_RETRY_MS) timers.push(window.setTimeout(() => { if (this.pending) void this.sendHello(); }, t));
      timers.push(window.setTimeout(() => this.failPending("Nobody answered. Check the code, and that the pilot who made the room is still online and in the plugin."), JOIN_TIMEOUT_MS));
    });
    await wait;
  }

  private async open(code: string, name: string): Promise<void> {
    if (!this.closed) throw new Error("Leave the current room before joining another.");
    const base = cleanRelayUrl(this.relayUrl);
    if (!base) throw new Error("The relay address must start with https:// (or http://localhost for testing). Check the multiplayer settings.");
    if (typeof crypto?.subtle === "undefined") throw new Error("This version of Obsidian cannot do the encryption multiplayer needs.");
    this.name = cleanName(name); this.id = crypto.randomUUID(); this.roomCode = code; this.list = []; this.closed = false; this.seenNonces.clear();
    this.keys = await deriveRoomKeys(code);
    const post = this.post;
    if (!this.makeTransport && !post) throw new Error("Network access is not available here, so rooms cannot be made.");
    const make = this.makeTransport ?? ((topic, onText, onProblem) => new RelayChannel(base, topic, post as PostFn, onText, onProblem));
    this.transport = make(this.keys.topic, text => void this.onText(text), text => this.cb.status(text, true));
    this.transport.start(8);
  }

  /** Send a connection-set-up message to one pilot. */
  signal(to: string, data: object): void { void this.send({ k: "signal", to, from: this.id, data }); }

  /** A pilot has dropped (their direct connection died): forget them, and tell everyone else who is still reachable. */
  dropMember(id: string): void {
    if (!this.list.some(m => m.id === id)) return;
    this.list = this.list.filter(m => m.id !== id);
    this.cb.roster(this.list, this.id);
  }

  leave(): void {
    if (this.closed) return;
    if (this.id && this.list.length > 1) void this.send({ k: "bye", id: this.id }).catch(() => undefined);
    this.failPending("Left the room.");
    this.closed = true;
    const t = this.transport; this.transport = null;
    window.setTimeout(() => t?.stop(), 600); // let the goodbye go out first
    this.list = []; this.id = ""; this.roomCode = ""; this.keys = null;
  }

  // ----------------------------------------------------------------- messages

  private async send(body: Record<string, unknown>): Promise<void> {
    const keys = this.keys, transport = this.transport; // held here, so a goodbye still goes out while the room is being closed
    if (!keys || !transport) return;
    const text = await seal(keys, { v: 1, n: crypto.randomUUID(), ...body });
    await transport.publish(text);
  }

  private sendHello(): Promise<void> {
    return this.send({ k: "hello", id: this.id, name: this.name, at: Date.now(), pv: PROTOCOL }).catch(e => this.failPending(e instanceof Error ? e.message : "Could not reach the relay."));
  }

  private failPending(message: string): void {
    const p = this.pending; if (!p) return;
    this.pending = null; p.timers.forEach(t => window.clearTimeout(t));
    p.reject(new Error(message));
    this.closed = true; this.transport?.stop(); this.transport = null; this.id = ""; this.roomCode = ""; this.keys = null; this.list = [];
  }

  /** The pilot who has been here longest is the one who answers newcomers. */
  private get coordinator(): RoomMember | undefined {
    return [...this.list].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0];
  }

  private async onText(text: string): Promise<void> {
    if (this.closed || !this.keys) return;
    const msg = await unseal(this.keys, text) as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object" || msg.v !== 1 || typeof msg.k !== "string" || typeof msg.n !== "string" || msg.n.length > 64) return;
    if (this.seenNonces.has(msg.n)) return;
    this.seenNonces.add(msg.n); if (this.seenNonces.size > 400) this.seenNonces.delete(this.seenNonces.values().next().value as string);

    switch (msg.k) {
      case "hello": return this.onHello(msg);
      case "roster": return this.onRoster(msg);
      case "mismatch": if (msg.to === this.id) this.failPending(UPDATE_TEXT); return;
      case "full": if (msg.to === this.id) this.failPending("That room already has four pilots."); return;
      case "signal": if (msg.to === this.id && typeof msg.from === "string" && uuid.test(msg.from) && this.list.some(m => m.id === msg.from)) this.cb.signal(msg.from, msg.data); return;
      case "bye": if (typeof msg.id === "string") this.dropMember(msg.id); return;
    }
  }

  private onHello(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "string" || !uuid.test(msg.id) || msg.id === this.id || !this.active || this.coordinator?.id !== this.id) return;
    const pv = typeof msg.pv === "number" && Number.isInteger(msg.pv) ? msg.pv : 1; // a plugin from before the version existed is protocol 1
    if (pv < MIN_PROTOCOL) { void this.send({ k: "mismatch", to: msg.id }); return; }
    const known = this.list.find(m => m.id === msg.id);
    if (!known) {
      if (this.list.length >= ROOM_CAPACITY) { void this.send({ k: "full", to: msg.id }); return; }
      const used = new Set(this.list.map(m => m.slot)), slot = [0, 1, 2, 3].find(s => !used.has(s));
      if (slot === undefined) { void this.send({ k: "full", to: msg.id }); return; }
      this.list = [...this.list, { id: msg.id, name: cleanName(msg.name), joinedAt: Date.now(), slot }];
      this.cb.roster(this.list, this.id);
    }
    void this.send({ k: "roster", members: this.list, pv: PROTOCOL, min: MIN_PROTOCOL }); // a repeated hello just gets the roster again
  }

  private onRoster(msg: Record<string, unknown>): void {
    if (!validMembers(msg.members)) return;
    const members = msg.members;
    if (!members.some(m => m.id === this.id)) return;
    if (typeof msg.min === "number" && msg.min > PROTOCOL) { this.failPending(UPDATE_TEXT); return; } // the room has moved on from this version
    const changed = JSON.stringify(members) !== JSON.stringify(this.list);
    this.list = members;
    if (this.pending) { const p = this.pending; this.pending = null; p.timers.forEach(t => window.clearTimeout(t)); p.resolve(); }
    if (changed) this.cb.roster(this.list, this.id);
  }
}
