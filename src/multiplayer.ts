/**
 * Multiplayer: up to four pilots in one shared flight space, each flying their own constellation.
 *
 * The anonymous topology, the position frames, the chunked transfers and the checks on everything a remote pilot can send
 * are adapted from the multiplayer work by j117mw3 in pull request #1 (https://github.com/xjusvibin/obsidian-constellation-graph/pull/1),
 * with thanks. The connection set-up and the flight and combat rules are different: pilots find each other through a public
 * relay using messages sealed with the room code (see room.ts), then talk directly over WebRTC. There is no server, nobody
 * is in charge of the game, every pilot flies their own ship with full physics, and a pilot's own computer decides whether
 * they have been hit.
 *
 * What is shared: the shape of your constellation (anonymous points, links and group colours) and where your ship is.
 * Never: note titles, paths, tags or contents.
 */

import { LossMeter } from "./netstats";
import { LobbyBrowser, LobbyPublisher, type Listing } from "./lobby";
import { validBurst, validGrab, validMissile, type BurstMsg, type MissileMsg } from "./powerups";
import type { GraphData, RawNode, SimNode } from "./types";
import { RelayRoom, type RoomMember, type TransportFactory } from "./room";
import type { PostFn } from "./relay";

export const MAX_SHARED_NODES = 20_000;
export const MAX_SHARED_LINKS = 100_000;
const MAX_COORDINATE = 1_000_000;
const MAGIC = 0x43475031; // CGP1
const POSITION_HEADER_BYTES = 16;
const POSITION_CHUNK_MAGIC = 0x43474331; // CGC1
const POSITION_CHUNK_HEADER_BYTES = 24;
const POSITION_CHUNK_BYTES = 12_000;
const TOPOLOGY_CHUNK_CHARS = 12_000;
const MAX_TOPOLOGY_CHARS = 16 * 1024 * 1024;
const OFFER_GATHER_MS = 3500;
const DISCONNECT_GRACE_MS = 8000;

export interface AnonymousGroup { color: string; count: number }
export interface AnonymousNode { id: string; group: number; degree: number }
export interface AnonymousTopology { revision: number; nodes: AnonymousNode[]; groups: AnonymousGroup[]; links: [string, string][] }

/** Where a pilot's ship is and how it is doing. Sent about twenty times a second. */
export interface Pose { p: [number, number, number]; q: [number, number, number, number]; v: [number, number, number]; hp: number; en: number; bo: boolean; ac: boolean; pr: boolean; sh?: number; sd?: number; cl?: number }
/** A blaster bolt: where it started and which way it flies. */
export interface ShotMsg { id: string; o: [number, number, number]; d: [number, number, number]; w?: 0 | 1; s?: number }
/** "You hit me." Sent by the pilot who was hit, so the shooter can show the impact. */
export interface HitMsg { shooter: string; target: string; shotId: string; at: [number, number, number] }

/** Build a deliberately lossy network representation. File IDs and all note labels stop here. */
export function makeAnonymousTopology(data: GraphData, ids: Map<string, string>, revision: number): AnonymousTopology {
  if (data.nodes.length > MAX_SHARED_NODES || data.links.length > MAX_SHARED_LINKS)
    throw new Error(`This room supports up to ${MAX_SHARED_NODES.toLocaleString()} stars and ${MAX_SHARED_LINKS.toLocaleString()} links per vault.`);
  const active = new Set(data.nodes.map(n => n.id));
  for (const key of [...ids.keys()]) if (!active.has(key)) ids.delete(key);
  for (const node of data.nodes) if (!ids.has(node.id)) ids.set(node.id, `n-${crypto.randomUUID()}`);
  const groups = data.groups.map(g => ({ color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : "#8b93a7", count: Math.max(0, Math.min(data.nodes.length, Math.floor(g.count))) }));
  const byId = new Map<string, RawNode>(data.nodes.map(n => [n.id, n]));
  const groupIndex = new Map(data.groups.map((g, i) => [g.key, i]));
  const nodes = data.nodes.map(n => ({ id: ids.get(n.id)!, group: Math.max(0, Math.min(Math.max(0, groups.length - 1), groupIndex.get(n.group) ?? 0)), degree: Math.max(0, Math.min(MAX_SHARED_NODES, Math.floor(n.deg))) }));
  const links: [string, string][] = [];
  for (const link of data.links) {
    if (!byId.has(link.source) || !byId.has(link.target)) continue;
    const a = ids.get(link.source), b = ids.get(link.target);
    if (a && b && a !== b) links.push([a, b]);
  }
  return { revision, nodes, groups, links };
}

/** Binary position frame: protocol magic, topology revision, count, then xyz float32 triples. */
export function encodePositions(nodes: readonly SimNode[], topology: AnonymousTopology, sequence: number): ArrayBuffer {
  if (nodes.length !== topology.nodes.length) throw new Error("The graph changed while its position frame was being built.");
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff) throw new Error("Invalid position frame sequence.");
  const buffer = new ArrayBuffer(POSITION_HEADER_BYTES + nodes.length * 12);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true); view.setUint32(4, topology.revision, true); view.setUint32(8, nodes.length, true);
  view.setUint32(12, sequence, true);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], o = POSITION_HEADER_BYTES + i * 12;
    for (const v of [n.x, n.y, n.z]) if (!Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) throw new Error("A constellation position is outside the room's coordinate limit.");
    view.setFloat32(o, n.x, true); view.setFloat32(o + 4, n.y, true); view.setFloat32(o + 8, n.z, true);
  }
  return buffer;
}

export function decodePositions(buffer: ArrayBuffer, topology: AnonymousTopology): { sequence: number; positions: Float32Array } | null {
  if (buffer.byteLength < POSITION_HEADER_BYTES || buffer.byteLength > POSITION_HEADER_BYTES + MAX_SHARED_NODES * 12) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const sequence = view.getUint32(12, true);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== topology.revision || count !== topology.nodes.length || !sequence || buffer.byteLength !== POSITION_HEADER_BYTES + count * 12) return null;
  const result = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    const v = view.getFloat32(POSITION_HEADER_BYTES + i * 4, true);
    if (!Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) return null;
    result[i] = v;
  }
  return { sequence, positions: result };
}

export function encodePositionChunks(nodes: readonly SimNode[], topology: AnonymousTopology, sequence: number): ArrayBuffer[] {
  const frame = encodePositions(nodes, topology, sequence), bytes = new Uint8Array(frame);
  const total = Math.ceil(bytes.length / POSITION_CHUNK_BYTES), chunks: ArrayBuffer[] = [];
  for (let index = 0; index < total; index++) {
    const from = index * POSITION_CHUNK_BYTES, size = Math.min(POSITION_CHUNK_BYTES, bytes.length - from);
    const chunk = new ArrayBuffer(POSITION_CHUNK_HEADER_BYTES + size), view = new DataView(chunk);
    view.setUint32(0, POSITION_CHUNK_MAGIC, true); view.setUint32(4, topology.revision, true); view.setUint32(8, sequence, true);
    view.setUint32(12, index, true); view.setUint32(16, total, true); view.setUint32(20, bytes.length, true);
    new Uint8Array(chunk, POSITION_CHUNK_HEADER_BYTES).set(bytes.subarray(from, from + size)); chunks.push(chunk);
  }
  return chunks;
}

export function validTopology(value: unknown): value is AnonymousTopology {
  if (!value || typeof value !== "object") return false;
  const t = value as AnonymousTopology;
  if (!Number.isSafeInteger(t.revision) || t.revision < 1 || !Array.isArray(t.nodes) || !Array.isArray(t.groups) || !Array.isArray(t.links) || t.nodes.length > MAX_SHARED_NODES || t.links.length > MAX_SHARED_LINKS || t.groups.length > 128) return false;
  const ids = new Set<string>();
  for (const n of t.nodes) {
    if (!n || typeof n.id !== "string" || !/^n-[0-9a-f-]{36}$/i.test(n.id) || ids.has(n.id) || !Number.isInteger(n.group) || n.group < 0 || n.group >= Math.max(1, t.groups.length) || !Number.isInteger(n.degree) || n.degree < 0 || n.degree > MAX_SHARED_NODES) return false;
    ids.add(n.id);
  }
  for (const g of t.groups) if (!g || typeof g.color !== "string" || !/^#[0-9a-f]{6}$/i.test(g.color) || !Number.isInteger(g.count) || g.count < 0 || g.count > MAX_SHARED_NODES) return false;
  for (const l of t.links) if (!Array.isArray(l) || l.length !== 2 || !ids.has(l[0]) || !ids.has(l[1]) || l[0] === l[1]) return false;
  return true;
}

const finite3 = (v: unknown, max: number): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max);

export function validPose(value: unknown): value is Pose {
  if (!value || typeof value !== "object") return false;
  const p = value as Pose;
  return finite3(p.p, MAX_COORDINATE) && finite3(p.v, 20_000)
    && Array.isArray(p.q) && p.q.length === 4 && p.q.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1.01) && p.q.some(x => x !== 0)
    && typeof p.hp === "number" && Number.isFinite(p.hp) && p.hp >= 0 && p.hp <= 100 && typeof p.en === "number" && Number.isFinite(p.en) && p.en >= 0 && p.en <= 1
    && typeof p.bo === "boolean" && typeof p.ac === "boolean" && typeof p.pr === "boolean"
    && (p.sh === undefined || (Number.isInteger(p.sh) && p.sh >= 0 && p.sh <= 2))
    && (p.cl === undefined || (Number.isInteger(p.cl) && p.cl >= 0 && p.cl <= 8))
    && (p.sd === undefined || (typeof p.sd === "number" && Number.isFinite(p.sd) && p.sd >= 0 && p.sd <= 100));
}
export function validShot(value: unknown): value is ShotMsg {
  if (!value || typeof value !== "object") return false;
  const s = value as ShotMsg;
  return typeof s.id === "string" && s.id.length <= 64 && finite3(s.o, MAX_COORDINATE) && finite3(s.d, 1.01) && (s.w === undefined || s.w === 0 || s.w === 1)
    && (s.s === undefined || (typeof s.s === "number" && Number.isFinite(s.s) && s.s >= 0 && s.s <= 20_000));
}
export function validHit(value: unknown, self: string): value is HitMsg {
  if (!value || typeof value !== "object") return false;
  const h = value as HitMsg;
  return typeof h.shooter === "string" && typeof h.target === "string" && h.shooter === self && typeof h.shotId === "string" && h.shotId.length <= 64 && finite3(h.at, MAX_COORDINATE);
}

export interface SessionOptions { relayUrl: string; stun: string[]; turn?: { url: string; username: string; credential: string }; post?: PostFn }
export type LinkState = "connecting" | "connected" | "lost";

const PING_EVERY_MS = 2000;

export interface SessionCallbacks {
  status(text: string, error?: boolean): void;
  members(members: RoomMember[], selfId: string): void;
  link(id: string, state: LinkState): void;
  topology(id: string, topology: AnonymousTopology): void;
  positions(id: string, positions: Float32Array): void;
  pose(id: string, pose: Pose): void;
  shot(id: string, shot: ShotMsg): void;
  hit(from: string, hit: HitMsg): void;
  /** A pilot was destroyed (by another pilot's bolt, or null if unknown). Only the pilot who was hit reports it. */
  kill(victim: string, killer: string | null): void;
  /** The round-trip time to a pilot, in milliseconds (measured every couple of seconds). */
  ping(id: string, ms: number, loss: number): void;
  /** Another pilot fired a missile, broke one of their folded groups into meteors, or picked up a pickup. */
  missile(from: string, missile: MissileMsg): void;
  burst(from: string, burst: BurstMsg): void;
  grab(from: string, pickup: number): void;
  removed(id: string): void;
}

interface PositionAssembly { revision: number; sequence: number; totalBytes: number; chunks: Array<Uint8Array | undefined>; received: number; createdAt: number }
interface Peer {
  pc: RTCPeerConnection; control?: RTCDataChannel; live?: RTCDataChannel; topology?: AnonymousTopology;
  meter: LossMeter; positionSequence: number; lastPositionSequence: number; lastPoseSequence: number;
  topologySend: { revision: number; json: string; next: number; total: number } | null;
  topologyReceive: { revision: number; total: number; parts: string[]; bytes: number; received: number } | null;
  positionReceive: Map<number, PositionAssembly>; graceTimer?: number; connected: boolean;
}

/** The set of direct connections to the other pilots in a room, and everything sent over them. */
export class MultiplayerSession {
  private room: RelayRoom | null = null;
  private roster: RoomMember[] = [];
  private readonly peers = new Map<string, Peer>();
  private readonly ids = new Map<string, string>();
  private topology: AnonymousTopology | null = null;
  private revision = 0;
  private pumpTimer = 0;
  private pingTimer = 0;
  private publisher: LobbyPublisher | null = null;
  private pingSeq = 0;
  private poseSequence = 0;
  private closed = true;

  constructor(
    private cb: SessionCallbacks,
    private graph: () => { data: GraphData; nodes: readonly SimNode[] },
    private options: () => SessionOptions,
    private makeTransport?: TransportFactory,
  ) {}

  get active(): boolean { return !this.closed && !!this.room?.active; }
  get code(): string { return this.room?.code ?? ""; }
  get selfId(): string { return this.room?.selfId ?? ""; }
  get members(): RoomMember[] { return this.roster; }

  /** The pilot who has been in the room longest: the one who answers newcomers, and the only one who can remove a pilot. */
  private hostId(): string { return this.roster.reduce<RoomMember | null>((a, m) => (!a || m.joinedAt < a.joinedAt ? m : a), null)?.id ?? ""; }
  get isHost(): boolean { return this.active && this.hostId() === this.selfId; }

  /** Is this room on the public board? */
  get listed(): boolean { return !!this.publisher; }

  /** Put the room on the public board (anyone can then find its code and join), or take it off. Only the host can. */
  setListed(on: boolean): void {
    this.publisher?.stop(); this.publisher = null;
    const o = this.options();
    if (!on || !this.isHost || !o.post) return;
    this.publisher = new LobbyPublisher(o.relayUrl, o.post, () => {
      if (!this.active || !this.roster.length || !this.isHost) return null;
      const host = this.roster.find(m => m.id === this.selfId);
      return { code: this.code, name: `${host?.name ?? "Pilot"}'s room`.slice(0, 24), pilots: this.roster.length };
    });
    this.publisher.start();
  }

  /** Watch the public board. Returns the function that stops watching. */
  browse(onRooms: (rooms: Listing[]) => void, onProblem: (text: string) => void): () => void {
    const o = this.options();
    if (!o.post) { onProblem("Network access is not available here."); return () => undefined; }
    const b = new LobbyBrowser(o.relayUrl, o.post, () => this.code, onRooms, onProblem);
    b.start();
    return () => b.stop();
  }

  /** The host removes a pilot from the room. They can come back with the code (a listed room is public), so this is not a ban. */
  kick(id: string): void { if (this.isHost && id !== this.selfId) this.sendTo(id, { t: "kick" }); }
  get slot(): number { return this.roster.find(m => m.id === this.selfId)?.slot ?? 0; }

  async create(name: string): Promise<string> {
    const code = await this.start(r => r.create(name));
    return code || this.code;
  }
  async join(code: string, name: string): Promise<void> { await this.start(r => r.join(code, name).then(() => "")); }

  private async start(action: (room: RelayRoom) => Promise<string>): Promise<string> {
    if (this.active) throw new Error("Leave the current room before joining another.");
    if (!window.RTCPeerConnection) throw new Error("This version of Obsidian cannot make the direct connections multiplayer needs.");
    this.closed = false;
    window.clearInterval(this.pingTimer); this.pingTimer = window.setInterval(() => this.pingAll(), PING_EVERY_MS);
    const opts = this.options();
    const room = this.room = new RelayRoom(opts.relayUrl, {
      roster: (members, selfId) => this.onRoster(members, selfId),
      signal: (from, data) => void this.onSignal(from, data),
      status: (text, error) => this.cb.status(text, error),
    }, this.makeTransport, opts.post);
    try { return await action(room); }
    catch (e) { this.closed = true; this.room = null; throw e; }
  }

  // ----------------------------------------------------------------- the roster and the connections

  private onRoster(members: RoomMember[], selfId: string): void {
    this.roster = members;
    for (const id of [...this.peers.keys()]) if (!members.some(m => m.id === id)) { this.removePeer(id); this.cb.removed(id); }
    this.cb.members(members, selfId);
    for (const m of members) if (m.id !== selfId && !this.peers.has(m.id) && selfId < m.id) void this.connectPeer(m.id, true); // the lower id makes the offer
    this.updateStatus();
  }

  private rtcConfig(): RTCConfiguration {
    const o = this.options(), servers: RTCIceServer[] = o.stun.filter(u => /^stuns?:/i.test(u)).slice(0, 4).map(urls => ({ urls }));
    if (o.turn && /^turns?:/i.test(o.turn.url)) servers.push({ urls: o.turn.url, username: o.turn.username, credential: o.turn.credential }); // your own TURN server, if you have set one up
    return { iceServers: servers };
  }

  private newPeer(id: string): Peer {
    const pc = new RTCPeerConnection(this.rtcConfig());
    const peer: Peer = { pc, meter: new LossMeter(), positionSequence: 0, lastPositionSequence: 0, lastPoseSequence: 0, topologySend: null, topologyReceive: null, positionReceive: new Map(), connected: false };
    this.peers.set(id, peer);
    this.cb.link(id, "connecting");
    pc.ondatachannel = e => this.bindChannel(id, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { window.clearTimeout(peer.graceTimer); peer.connected = true; this.cb.link(id, "connected"); this.updateStatus(); }
      else if (pc.connectionState === "failed" || pc.connectionState === "closed") this.lose(id);
      else if (pc.connectionState === "disconnected") { window.clearTimeout(peer.graceTimer); peer.graceTimer = window.setTimeout(() => this.lose(id), DISCONNECT_GRACE_MS); }
    };
    return peer;
  }

  private waitForGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { pc.removeEventListener("icegatheringstatechange", check); window.clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = window.setTimeout(done, OFFER_GATHER_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private async connectPeer(id: string, offer: boolean): Promise<void> {
    if (this.peers.has(id) || !this.active) return;
    const peer = this.newPeer(id);
    if (!offer) return;
    this.bindChannel(id, peer.pc.createDataChannel("constellation-control", { ordered: true }));
    this.bindChannel(id, peer.pc.createDataChannel("constellation-live", { ordered: false, maxRetransmits: 0 }));
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await this.waitForGathering(peer.pc);
      this.room?.signal(id, { description: { type: "offer", sdp: peer.pc.localDescription?.sdp ?? "" } });
    } catch { this.cb.status(`Could not start a connection to ${this.nameOf(id)}.`, true); this.lose(id); }
  }

  private async onSignal(from: string, data: unknown): Promise<void> {
    if (!this.active || !data || typeof data !== "object") return;
    const d = (data as { description?: { type?: unknown; sdp?: unknown } }).description;
    if (!d || (d.type !== "offer" && d.type !== "answer") || typeof d.sdp !== "string" || d.sdp.length > 60_000) return;
    try {
      if (d.type === "offer") {
        if (this.selfId < from) return; // only the lower id makes offers; ignore a confused one
        if (!this.peers.has(from)) this.newPeer(from); else if (this.peers.get(from)!.pc.signalingState !== "stable") return;
        const peer = this.peers.get(from)!;
        await peer.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await this.waitForGathering(peer.pc);
        this.room?.signal(from, { description: { type: "answer", sdp: peer.pc.localDescription?.sdp ?? "" } });
      } else {
        const peer = this.peers.get(from);
        if (peer && peer.pc.signalingState === "have-local-offer") await peer.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
      }
    } catch { this.cb.status(`The connection to ${this.nameOf(from)} could not be set up.`, true); this.lose(from); }
  }

  private lose(id: string): void {
    const peer = this.peers.get(id); if (!peer) return;
    this.removePeer(id);
    this.cb.link(id, "lost"); this.cb.removed(id);
    this.room?.dropMember(id);
    this.cb.status(`Connection to ${this.nameOf(id)} was lost. They can rejoin with the room code.`, true);
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id); if (!peer) return;
    window.clearTimeout(peer.graceTimer);
    peer.control?.close(); peer.live?.close(); peer.pc.close(); this.peers.delete(id);
  }

  private bindChannel(id: string, dc: RTCDataChannel): void {
    const peer = this.peers.get(id); if (!peer) { dc.close(); return; }
    if (dc.label === "constellation-control") { peer.control = dc; dc.binaryType = "arraybuffer"; }
    else if (dc.label === "constellation-live") { peer.live = dc; dc.binaryType = "arraybuffer"; }
    else { dc.close(); return; }
    dc.onopen = () => {
      if (dc.label === "constellation-control" && this.topology) this.queueTopology(id, this.topology);
      this.updateStatus();
    };
    dc.onmessage = event => this.onPeerMessage(id, event.data, dc.label === "constellation-control" ? "control" : "live");
    dc.onclose = () => {
      if (dc.label !== "constellation-control") { peer.live = undefined; return; }
      peer.control = undefined;
      // the other pilot closed the connection (they left, or their game closed): after a moment, treat them as gone
      window.setTimeout(() => { if (this.peers.get(id) === peer && !peer.control && this.active) this.lose(id); }, 1500);
    };
  }

  private nameOf(id: string): string { return this.roster.find(m => m.id === id)?.name ?? "the other pilot"; }

  private updateStatus(): void {
    if (!this.active) return;
    const expected = this.roster.filter(m => m.id !== this.selfId).length;
    const linked = [...this.peers.values()].filter(p => p.connected && p.control?.readyState === "open").length;
    if (!expected) this.cb.status(`Room ${this.formatted()} is open. Waiting for other pilots.`);
    else this.cb.status(linked === expected ? `Connected to ${linked} ${linked === 1 ? "pilot" : "pilots"}.` : `${linked} of ${expected} connections ready.`);
  }

  private formatted(): string { const c = this.code; return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c; }

  // ----------------------------------------------------------------- what is received

  private onPeerMessage(id: string, data: unknown, lane: "control" | "live"): void {
    const peer = this.peers.get(id); if (!peer) return;
    if (data instanceof ArrayBuffer) {
      const topology = peer.topology; if (!topology) return;
      const frame = this.acceptPositionChunk(peer, data, topology);
      if (frame && frame.sequence > peer.lastPositionSequence) { peer.lastPositionSequence = frame.sequence; this.cb.positions(id, frame.positions); }
      return;
    }
    if (typeof data !== "string" || data.length > (lane === "control" ? 20_000 : 4_000)) return;
    let msg: unknown; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (lane === "live") {
      if (m.t === "pose" && Number.isSafeInteger(m.seq) && (m.seq as number) > peer.lastPoseSequence && validPose(m.pose)) { peer.lastPoseSequence = m.seq as number; this.cb.pose(id, m.pose); }
      return;
    }
    if (m.t === "shot" && validShot(m.shot)) { this.cb.shot(id, m.shot); return; }
    if (m.t === "hit" && validHit(m.hit, this.selfId) && m.hit.target === id) { this.cb.hit(id, m.hit); return; }
    if (m.t === "kick") { if (this.hostId() === id) this.leave("You were removed from the room by its host."); return; }
    if (m.t === "missile" && validMissile(m.missile)) { this.cb.missile(id, m.missile); return; }
    if (m.t === "burst" && validBurst(m.burst)) { this.cb.burst(id, m.burst); return; }
    if (m.t === "grab" && validGrab(m.id)) { this.cb.grab(id, m.id); return; }
    if (m.t === "ping" && Number.isSafeInteger(m.n) && typeof m.at === "number" && Number.isFinite(m.at)) { this.sendTo(id, { t: "pong", n: m.n, at: m.at }); return; }
    if (m.t === "pong" && typeof m.at === "number" && Number.isFinite(m.at)) {
      const rtt = performance.now() - m.at;
      if (Number.isSafeInteger(m.n)) peer.meter.pong(m.n as number);
      if (rtt >= 0 && rtt < 20_000) this.cb.ping(id, Math.round(rtt), peer.meter.loss);
      return;
    }
    if (m.t === "kill") { const by = m.by; if (by === null || (typeof by === "string" && by.length > 0 && by.length <= 64 && by !== id)) this.cb.kill(id, by); return; }
    if (m.type === "topology-chunk") this.acceptTopologyChunk(id, peer, m);
  }

  private acceptTopologyChunk(id: string, peer: Peer, m: Record<string, unknown>): void {
    if (!Number.isSafeInteger(m.revision) || (m.revision as number) < 1
      || !Number.isInteger(m.index) || !Number.isInteger(m.total) || (m.index as number) < 0 || (m.total as number) < 1
      || (m.total as number) > Math.ceil(MAX_TOPOLOGY_CHARS / TOPOLOGY_CHUNK_CHARS) || (m.index as number) >= (m.total as number)
      || typeof m.data !== "string" || m.data.length > TOPOLOGY_CHUNK_CHARS) return;
    if (peer.topology && (m.revision as number) <= peer.topology.revision) return;
    let transfer = peer.topologyReceive;
    if (!transfer || transfer.revision !== m.revision || transfer.total !== m.total) {
      if (transfer && (m.revision as number) < transfer.revision) return;
      transfer = { revision: m.revision as number, total: m.total as number, parts: new Array<string>(m.total as number), bytes: 0, received: 0 };
      peer.topologyReceive = transfer;
    }
    const index = m.index as number;
    if (transfer.parts[index] !== undefined) return;
    transfer.parts[index] = m.data; transfer.bytes += m.data.length; transfer.received++;
    if (transfer.bytes > MAX_TOPOLOGY_CHARS) { peer.topologyReceive = null; return; }
    if (transfer.received < transfer.total) return;
    try {
      const value: unknown = JSON.parse(transfer.parts.join(""));
      if (!validTopology(value) || value.revision !== transfer.revision || (peer.topology && value.revision <= peer.topology.revision)) { peer.topologyReceive = null; return; }
      peer.topology = value; peer.lastPositionSequence = 0; peer.positionReceive.clear(); peer.topologyReceive = null;
      this.cb.topology(id, value);
    } catch { peer.topologyReceive = null; }
  }

  private acceptPositionChunk(peer: Peer, buffer: ArrayBuffer, topology: AnonymousTopology): { sequence: number; positions: Float32Array } | null {
    if (buffer.byteLength <= POSITION_CHUNK_HEADER_BYTES || buffer.byteLength > POSITION_CHUNK_HEADER_BYTES + POSITION_CHUNK_BYTES) return null;
    const view = new DataView(buffer), revision = view.getUint32(4, true), sequence = view.getUint32(8, true), index = view.getUint32(12, true);
    const total = view.getUint32(16, true), totalBytes = view.getUint32(20, true);
    const expectedBytes = POSITION_HEADER_BYTES + topology.nodes.length * 12;
    const expectedTotal = Math.ceil(expectedBytes / POSITION_CHUNK_BYTES);
    if (view.getUint32(0, true) !== POSITION_CHUNK_MAGIC || revision !== topology.revision || !sequence || sequence <= peer.lastPositionSequence
      || totalBytes !== expectedBytes || total !== expectedTotal || index >= total) return null;
    const offset = index * POSITION_CHUNK_BYTES, expectedChunkBytes = Math.min(POSITION_CHUNK_BYTES, totalBytes - offset);
    if (buffer.byteLength !== POSITION_CHUNK_HEADER_BYTES + expectedChunkBytes) return null;
    const now = Date.now();
    for (const [key, item] of peer.positionReceive) if (now - item.createdAt > 5000) peer.positionReceive.delete(key);
    let assembly = peer.positionReceive.get(sequence);
    if (!assembly) {
      while (peer.positionReceive.size >= 3) peer.positionReceive.delete(peer.positionReceive.keys().next().value!);
      assembly = { revision, sequence, totalBytes, chunks: new Array<Uint8Array | undefined>(total), received: 0, createdAt: now };
      peer.positionReceive.set(sequence, assembly);
    }
    if (assembly.revision !== revision || assembly.totalBytes !== totalBytes || assembly.chunks.length !== total || assembly.chunks[index]) return null;
    assembly.chunks[index] = new Uint8Array(buffer.slice(POSITION_CHUNK_HEADER_BYTES)); assembly.received++;
    if (assembly.received !== total) return null;
    const frame = new ArrayBuffer(totalBytes), bytes = new Uint8Array(frame);
    assembly.chunks.forEach((chunk, part) => { if (chunk) bytes.set(chunk, part * POSITION_CHUNK_BYTES); });
    peer.positionReceive.delete(sequence);
    const decoded = decodePositions(frame, topology);
    return decoded?.sequence === sequence ? decoded : null;
  }

  // ----------------------------------------------------------------- what is sent

  /** Share the shape of your constellation (anonymised) and where its stars are. Call it when the room starts and your world is in place. */
  publishGraph(): void {
    if (!this.active) return;
    try {
      this.topology = makeAnonymousTopology(this.graph().data, this.ids, ++this.revision);
      for (const id of this.peers.keys()) this.queueTopology(id, this.topology);
    } catch (e) {
      this.revision--;
      this.cb.status(e instanceof Error ? e.message : "Could not share this constellation.", true);
    }
  }

  private queueTopology(id: string, topology: AnonymousTopology): void {
    const peer = this.peers.get(id), control = peer?.control;
    if (!peer || !control || control.readyState !== "open") return;
    const json = JSON.stringify(topology);
    if (json.length > MAX_TOPOLOGY_CHARS) { this.cb.status("This constellation is too large to share (the limit is 16 MiB).", true); return; }
    peer.topologySend = { revision: topology.revision, json, next: 0, total: Math.ceil(json.length / TOPOLOGY_CHUNK_CHARS) };
    if (!this.pumpTimer) this.pumpTimer = window.setInterval(() => this.pump(), 8);
  }

  private pump(): void {
    let busy = false;
    for (const [id, peer] of this.peers) {
      const t = peer.topologySend, ch = peer.control;
      if (!t || !ch || ch.readyState !== "open") continue;
      busy = true;
      if (ch.bufferedAmount > 256_000) continue;
      const index = t.next++, from = index * TOPOLOGY_CHUNK_CHARS;
      try { ch.send(JSON.stringify({ type: "topology-chunk", revision: t.revision, index, total: t.total, data: t.json.slice(from, from + TOPOLOGY_CHUNK_CHARS) })); }
      catch { t.next--; continue; }
      if (t.next >= t.total) { peer.topologySend = null; this.sendPositionsTo(id); } // the shape is across; now where the stars are
    }
    if (!busy) { window.clearInterval(this.pumpTimer); this.pumpTimer = 0; }
  }

  private sendPositionsTo(id: string): void {
    const peer = this.peers.get(id), topology = this.topology, ch = peer?.control;
    if (!peer || !ch || ch.readyState !== "open" || !topology) return;
    try { for (const chunk of encodePositionChunks(this.graph().nodes, topology, ++peer.positionSequence)) ch.send(chunk); }
    catch (e) { this.cb.status(e instanceof Error ? e.message : String(e), true); }
  }

  sendPose(pose: Pose): void {
    const seq = ++this.poseSequence;
    for (const peer of this.peers.values()) {
      const ch = peer.live; if (!ch || ch.readyState !== "open" || ch.bufferedAmount > 64_000) continue;
      try { ch.send(JSON.stringify({ t: "pose", seq, pose })); } catch { /* the peer may have closed during a frame */ }
    }
  }

  sendMissile(missile: MissileMsg): void { this.sendControl({ t: "missile", missile }); }
  sendBurst(burst: BurstMsg): void { this.sendControl({ t: "burst", burst }); }
  sendGrab(id: number): void { this.sendControl({ t: "grab", id }); }
  sendShot(shot: ShotMsg): void { this.sendControl({ t: "shot", shot }); }
  /** Tell everyone you were destroyed, and by whom. */
  sendKill(by: string | null): void { this.sendControl({ t: "kill", by }); }
  sendHit(hit: HitMsg): void { const ch = this.peers.get(hit.shooter)?.control; if (ch?.readyState === "open") try { ch.send(JSON.stringify({ t: "hit", hit })); } catch { /* closing */ } }

  /** Ask every pilot to answer, so the round-trip time to each can be shown. */
  private pingAll(): void {
    if (this.closed || !this.peers.size) return;
    this.pingSeq++;
    for (const p of this.peers.values()) if (p.control?.readyState === "open") p.meter.ping(this.pingSeq);
    this.sendControl({ t: "ping", n: this.pingSeq, at: performance.now() });
  }

  private sendTo(id: string, message: object): void {
    const ch = this.peers.get(id)?.control;
    if (ch?.readyState === "open" && ch.bufferedAmount < 512_000) try { ch.send(JSON.stringify(message)); } catch { /* closing */ }
  }

  private sendControl(message: object): void {
    const text = JSON.stringify(message);
    for (const peer of this.peers.values()) { const ch = peer.control; if (ch?.readyState === "open" && ch.bufferedAmount < 512_000) try { ch.send(text); } catch { /* closing */ } }
  }

  leave(message = "Left the room."): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.pumpTimer); this.pumpTimer = 0;
    window.clearInterval(this.pingTimer); this.pingTimer = 0;
    this.publisher?.stop(); this.publisher = null;
    for (const id of [...this.peers.keys()]) { this.removePeer(id); this.cb.removed(id); }
    this.room?.leave(); this.room = null;
    this.roster = []; this.topology = null; this.ids.clear(); this.revision = 0; this.poseSequence = 0;
    this.cb.members([], "");
    this.cb.status(message);
  }
}
