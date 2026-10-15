import type { GraphData, RawLink, RawNode, SimNode } from "./types";
import { CombatWorld, type RoomCheckpoint } from "./combat";

export const MAX_SHARED_NODES = 20_000;
export const MAX_SHARED_LINKS = 100_000;
export const ROOM_PROTOCOL = 2;
export const HOSTED_SIGNALING_URL = "wss://constellation-rooms.mrassetto.workers.dev";
const MAX_COORDINATE = 1_000_000;
const MAGIC = 0x43475031; // CGP1
const POSITION_HEADER_BYTES = 16;
const POSITION_CHUNK_MAGIC = 0x43474331; // CGC1
const POSITION_CHUNK_HEADER_BYTES = 24;
const POSITION_CHUNK_BYTES = 12_000;
const TOPOLOGY_CHUNK_CHARS = 12_000;
const MAX_TOPOLOGY_CHARS = 16 * 1024 * 1024;

export interface AnonymousGroup { color: string; count: number }
export interface AnonymousNode { id: string; group: number; degree: number }
export interface AnonymousTopology { revision: number; nodes: AnonymousNode[]; groups: AnonymousGroup[]; links: [string, string][] }
export interface AnonymousPlayer { id: string; name: string; joinedAt: number; slot: number }
export interface NavigationTarget { ownerId: string; starId: string; revision: number }
export interface Pose { position: [number, number, number]; rotation: [number, number, number, number]; velocity: [number, number, number]; health: number; energy: number; boostLocked: boolean; boostHold: number; regenDelay: number; active: boolean; respawnAt: number; protectedUntil: number }
export interface ShotSnapshot { id: string; ownerId: string; gun: number; origin: [number, number, number]; position: [number, number, number]; direction: [number, number, number] }
export interface ImpactSnapshot { id: string; position: [number, number, number]; kind: "star" | "ship" }

/** Build a deliberately lossy network representation. File IDs and all note labels stop here. */
export function makeAnonymousTopology(data: GraphData, ids: Map<string, string>, revision: number): AnonymousTopology {
  if (data.nodes.length > MAX_SHARED_NODES || data.links.length > MAX_SHARED_LINKS)
    throw new Error(`This room supports up to ${MAX_SHARED_NODES.toLocaleString()} stars and ${MAX_SHARED_LINKS.toLocaleString()} links per vault.`);
  const active = new Set(data.nodes.map(n => n.id));
  for (const key of [...ids.keys()]) if (!active.has(key)) ids.delete(key);
  for (const node of data.nodes) if (!ids.has(node.id)) ids.set(node.id, `n-${crypto.randomUUID()}`);
  const groups = data.groups.map(g => ({ color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : "#8b93a7", count: Math.max(0, Math.min(data.nodes.length, Math.floor(g.count))) }));
  const byId = new Map<string, RawNode>(data.nodes.map(n => [n.id, n]));
  const nodes = data.nodes.map(n => ({ id: ids.get(n.id)!, group: Math.max(0, Math.min(groups.length - 1, data.groups.findIndex(g => g.key === n.group))), degree: Math.max(0, Math.min(MAX_SHARED_NODES, Math.floor(n.deg))) }));
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

type SignalMessage = { type: string; [key: string]: unknown };
export type GameMessage = { type: "input"; epoch: number; input: FlightInput }
  | { type: "navigate"; epoch: number; target: NavigationTarget }
  | { type: "fire"; epoch: number; sequence: number; gun: number; aimPoint: [number, number, number] }
  | { type: "ship"; epoch: number; sequence: number; playerId: string; pose: Pose }
  | { type: "shots"; epoch: number; sequence: number; shots: ShotSnapshot[]; impacts: ImpactSnapshot[] };
export interface FlightInput { thrust: number; strafe: number; lift: number; roll: number; pitch: number; yaw: number; boost: boolean; brake: boolean; fire: boolean; active: boolean }

export interface MultiplayerCallbacks {
  status(text: string, error?: boolean): void;
  members(members: AnonymousPlayer[], selfId: string, hostId: string, epoch: number): void;
  topology(playerId: string, topology: AnonymousTopology): void;
  positions(playerId: string, positions: Float32Array): void;
  message(from: string, message: GameMessage): void;
  removed(playerId: string): void;
  authority(hostId: string, epoch: number, checkpoint: unknown): void;
  playerState(playerId: string, pose: Pose): void;
  shotState(shots: ShotSnapshot[], impacts: ImpactSnapshot[]): void;
  navigation?(target: NavigationTarget | null, state?: "selected" | "travelling" | "cancelled"): void;
}

interface PositionAssembly { revision: number; sequence: number; totalBytes: number; chunks: Array<Uint8Array | undefined>; received: number; createdAt: number }

function validTopology(value: unknown): value is AnonymousTopology {
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

function validMembers(value: unknown): value is AnonymousPlayer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  const ids = new Set<string>(), slots = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const member = item as AnonymousPlayer;
    if (typeof member.id !== "string" || !/^[0-9a-f-]{36}$/i.test(member.id) || ids.has(member.id)
      || typeof member.name !== "string" || member.name.length > 24 || !Number.isSafeInteger(member.joinedAt)
      || !Number.isInteger(member.slot) || member.slot < 0 || member.slot > 3 || slots.has(member.slot)) return false;
    ids.add(member.id); slots.add(member.slot);
  }
  return true;
}

function validIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value) || value.length > 12) return [];
  const result: RTCIceServer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const server = entry as RTCIceServer;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.length || !urls.every(url => typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url))) continue;
    if (server.username !== undefined && typeof server.username !== "string") continue;
    if (server.credential !== undefined && typeof server.credential !== "string") continue;
    result.push(server);
  }
  return result;
}

/** WebRTC mesh plus a small signaling connection. Only anonymous graph messages pass through this class. */
export class MultiplayerSession {
  private socket: WebSocket | null = null;
  private roomCode = "";
  private selfId = "";
  private hostId = "";
  private epoch = 0;
  private roster: AnonymousPlayer[] = [];
  private readonly peers = new Map<string, { pc: RTCPeerConnection; control?: RTCDataChannel; live?: RTCDataChannel; topology?: AnonymousTopology; positions?: Float32Array; positionsRevision?: number;
    signalChain: Promise<void>; pendingCandidates: RTCIceCandidateInit[];
    positionSequence: number; lastPositionSequence: number; topologySend: { revision: number; json: string; next: number; total: number } | null;
    topologyReceive: { revision: number; total: number; parts: string[]; bytes: number; received: number } | null;
    positionReceive: Map<number, PositionAssembly> }>();
  private readonly retryTimers = new Map<string, number>();
  private readonly ids = new Map<string, string>();
  private topology: AnonymousTopology | null = null;
  private revision = 0;
  private sendTimer = 0;
  private checkpointTimer = 0;
  private gameTimer = 0;
  private topologyTimer = 0;
  private world: CombatWorld | null = null;
  private lastGameStep = 0;
  private lastStateSend = 0;
  private gameResumeAt = 0;
  private stateSequence = 0;
  private positionSequence = 0;
  private lastShipSequence = new Map<string, number>();
  private lastShotSequence = 0;
  private relay: RTCIceServer[] = [];
  private iceExpiresAt = 0;
  private iceRefreshTimer = 0;
  private authorityTimer = 0;
  private relayStatus: "ready" | "pending" | "unavailable" | "quota" | "direct-only" = "pending";
  private lastIceErrorAt = 0;
  private readonly iceFailures = new Map<string, { kind: "STUN" | "TURN" | "ICE"; code: number }>();
  private lastIceRequestAt = 0;
  private closed = false;
  private opening = false;

  constructor(private callbacks: MultiplayerCallbacks, private graph: () => { data: GraphData; nodes: readonly SimNode[] }, private signalingUrl: () => string) {}
  get active(): boolean { return !!this.selfId && !this.closed; }
  get isHost(): boolean { return this.active && this.selfId === this.hostId; }
  get room(): string { return this.roomCode; }
  get localPlayerId(): string { return this.selfId; }
  get localTopology(): AnonymousTopology | null { return this.topology; }
  get members(): readonly AnonymousPlayer[] { return this.roster; }

  async create(name: string): Promise<void> { await this.open("create", name); }
  async join(code: string, name: string): Promise<void> { await this.open("join", name, code); }

  private async open(action: "create" | "join", name: string, code = ""): Promise<void> {
    if (this.active) throw new Error("Leave the current room before joining another.");
    if (this.opening) throw new Error("A room connection is already in progress.");
    if (!globalThis.RTCPeerConnection || !globalThis.WebSocket) throw new Error("This Obsidian WebView does not provide WebRTC.");
    const url = this.signalingUrl().trim();
    if (!/^wss?:\/\//i.test(url)) throw new Error("Choose Hosted rooms or enter a custom address that starts with ws:// or wss://.");
    const cleanName = name.trim().slice(0, 24);
    if (!cleanName) throw new Error("Enter a display name in plugin settings.");
    if (action === "join" && !/^[A-HJ-NP-Z2-9]{8}$/i.test(code.trim())) throw new Error("Enter the eight-character room code.");
    this.topology = makeAnonymousTopology(this.graph().data, this.ids, ++this.revision);
    this.closed = false;
    this.opening = true;
    try { await new Promise<void>((resolve, reject) => {
      const ws = this.socket = new WebSocket(url);
      const host = (() => { try { return new URL(url).host; } catch { return "the selected server"; } })();
      let settled = false;
      let timeout = 0;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; window.clearTimeout(timeout); reject(error);
      };
      timeout = window.setTimeout(() => fail(new Error(`The room service at ${host} did not respond within 15 seconds.`)), 15_000);
      ws.addEventListener("open", () => {
        if (this.socket !== ws || this.closed) return;
        ws.send(JSON.stringify(action === "create" ? { type: "create", protocol: ROOM_PROTOCOL, name: cleanName } : { type: "join", protocol: ROOM_PROTOCOL, code: code.trim().toUpperCase(), name: cleanName }));
      });
      ws.addEventListener("message", event => {
        if (this.socket !== ws || this.closed) return;
        let msg: SignalMessage;
        try { msg = JSON.parse(String(event.data)) as SignalMessage; } catch { this.callbacks.status("The signaling service sent invalid data.", true); return; }
        if (msg.type === "error") {
          window.clearTimeout(timeout);
          const error = this.roomServiceError(msg);
          if (this.active) {
            this.callbacks.status(error, true);
            if (msg.code === "rate-limited") {
              window.clearTimeout(this.iceRefreshTimer);
              this.iceRefreshTimer = window.setTimeout(() => this.requestIceConfiguration(), 60_000);
            }
            return;
          }
          fail(new Error(error)); return;
        }
        if (msg.type === "created" || msg.type === "joined") {
          if (settled) return;
          const selfId = String(msg.selfId || ""), hostId = String(msg.hostId || ""), members = msg.members;
          if (!/^[0-9a-f-]{36}$/i.test(selfId) || !/^[0-9a-f-]{36}$/i.test(hostId) || !validMembers(members)
            || !members.some(p => p.id === selfId) || !members.some(p => p.id === hostId) || !Number.isSafeInteger(msg.epoch) || (msg.epoch as number) < 1
            || typeof msg.code !== "string" || !/^[A-HJ-NP-Z2-9]{8}$/.test(msg.code)) {
            fail(new Error("The signaling service returned invalid room details.")); return;
          }
          settled = true;
          window.clearTimeout(timeout); this.selfId = selfId; this.hostId = hostId; this.roomCode = msg.code; this.epoch = msg.epoch as number;
          this.relay = validIceServers(msg.iceServers);
          this.iceExpiresAt = Number.isSafeInteger(msg.iceExpiresAt) ? Number(msg.iceExpiresAt) : 0;
          this.relayStatus = this.readRelayStatus(msg.relayStatus, this.relay);
          this.roster = members;
          this.callbacks.members(this.roster, this.selfId, this.hostId, this.epoch);
          this.createWorldIfHost();
          for (const p of this.roster) if (p.id !== this.selfId) void this.connectPeer(p.id, true);
          this.startLoops(); this.updatePeerStatus(); resolve();
          return;
        }
        void this.onSignal(msg);
      });
      ws.addEventListener("error", () => {
        const error = new Error(`Could not reach the room service at ${host}. Check your internet connection or try again later.`);
        if (!settled) fail(error);
        else if (this.socket === ws && this.active) this.callbacks.status(error.message, true);
      });
      ws.addEventListener("close", event => {
        if (!settled) {
          fail(new Error(this.closed ? `Connection to ${host} was canceled.`
            : `The room service at ${host} closed the connection before joining (WebSocket code ${event.code}).`));
        } else if (this.socket === ws && !this.closed && this.selfId) {
          this.leave(`Signaling connection to ${host} closed (WebSocket code ${event.code}); you left the room.`);
        }
      });
    }); } catch (error) {
      this.leave(error instanceof Error ? error.message : "Room connection failed.");
      throw error;
    } finally { this.opening = false; }
  }

  private async connectPeer(id: string, offer: boolean): Promise<void> {
    if (this.peers.has(id) || !this.active || !this.roster.some(p => p.id === id)) return;
    const pc = new RTCPeerConnection({ iceServers: this.relay, iceCandidatePoolSize: 2 });
    const state: NonNullable<ReturnType<typeof this.peers.get>> = { pc, signalChain: Promise.resolve(), pendingCandidates: [], positionSequence: 0, lastPositionSequence: 0, topologySend: null, topologyReceive: null, positionReceive: new Map() };
    this.peers.set(id, state);
    pc.onicecandidate = e => { if (e.candidate) this.signal(id, { candidate: e.candidate.toJSON() }); };
    pc.onicecandidateerror = event => this.reportIceError(id, event);
    pc.ondatachannel = e => this.bindChannel(id, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { this.iceFailures.delete(id); this.updatePeerStatus(); }
      else if (pc.connectionState === "failed") { this.updatePeerStatus(); this.requestIceConfiguration(); this.schedulePeerRetry(id); }
      else if (pc.connectionState === "disconnected") this.schedulePeerRetry(id, 5000);
    };
    if (offer) {
      this.bindChannel(id, pc.createDataChannel("constellation-control", { ordered: true }));
      this.bindChannel(id, pc.createDataChannel("constellation-live", { ordered: false, maxRetransmits: 0 }));
    }
    if (offer) {
      try { const offerDesc = await pc.createOffer(); await pc.setLocalDescription(offerDesc); this.signal(id, { description: pc.localDescription }); }
      catch { this.callbacks.status(`Could not start a connection to ${this.memberName(id)}. Retrying.`, true); this.schedulePeerRetry(id); }
    }
  }

  private bindChannel(id: string, dc: RTCDataChannel): void {
    const peer = this.peers.get(id); if (!peer) { dc.close(); return; }
    if (dc.label === "constellation-control") peer.control = dc;
    else if (dc.label === "constellation-live") { peer.live = dc; dc.binaryType = "arraybuffer"; }
    else { dc.close(); return; }
    dc.onopen = () => {
      if (this.closed || this.peers.get(id) !== peer) return;
      if (dc.label === "constellation-control" && this.topology) this.queueTopology(id, this.topology);
      if (dc.label === "constellation-live") this.sendPositionsTo(id);
      this.updatePeerStatus();
    };
    dc.onmessage = event => {
      if (!this.closed && this.peers.get(id) === peer) this.onPeerMessage(id, event.data, dc.label === "constellation-control" ? "control" : "live");
    };
    dc.onclose = () => {
      if (this.closed || this.peers.get(id) !== peer) return;
      if (dc.label === "constellation-control") peer.control = undefined; else peer.live = undefined;
      this.callbacks.status(`Connection to ${this.memberName(id)} closed; reconnecting.`, true);
      this.schedulePeerRetry(id);
    };
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    if (msg.type === "ice-servers") {
      const servers = validIceServers(msg.iceServers);
      const expiresAt = Number.isSafeInteger(msg.iceExpiresAt) ? Number(msg.iceExpiresAt) : 0;
      const status = this.readRelayStatus(msg.relayStatus, servers);
      const changed = expiresAt !== this.iceExpiresAt || status !== this.relayStatus || JSON.stringify(servers) !== JSON.stringify(this.relay);
      this.relay = servers; this.iceExpiresAt = expiresAt; this.relayStatus = status;
      if (changed) await this.applyIceConfiguration();
      if (status === "quota") this.callbacks.status("The free TURN relay allowance is exhausted. Direct peer connections may still work.", true);
      else if (status === "unavailable") this.callbacks.status("The relay service is temporarily unavailable. Trying direct peer connections.", true);
      else if (status === "pending") this.callbacks.status("Preparing relay access; trying direct peer connections and checking again shortly.");
      this.scheduleIceRefresh();
      return;
    }
    if (msg.type === "member-joined") {
      const p = msg.member as AnonymousPlayer;
      if (!p || typeof p.id !== "string" || p.id === this.selfId) return;
      this.roster = [...this.roster.filter(x => x.id !== p.id), p]; this.callbacks.members(this.roster, this.selfId, this.hostId, this.epoch);
      if (this.isHost) this.world?.add(p);
      await this.connectPeer(p.id, false); this.updatePeerStatus(); return;
    }
    if (msg.type === "member-left") {
      const id = String(msg.id || ""); this.removePeer(id); this.roster = this.roster.filter(x => x.id !== id); this.callbacks.removed(id);
      this.world?.remove(id);
      this.hostId = String(msg.hostId || this.hostId); this.epoch = Number(msg.epoch) || this.epoch; this.callbacks.members(this.roster, this.selfId, this.hostId, this.epoch);
      this.updatePeerStatus(); return;
    }
    if (msg.type === "authority") {
      this.hostId = String(msg.hostId || ""); this.epoch = Number(msg.epoch) || this.epoch;
      this.gameResumeAt = Date.now() + 700;
      this.lastShipSequence.clear(); this.lastShotSequence = 0;
      this.world = this.isHost ? new CombatWorld(this.epoch) : null;
      if (this.world) {
        const checkpoint = msg.checkpoint as { state?: unknown; ageMs?: number } | null;
        if (checkpoint?.state && Number.isFinite(checkpoint.ageMs) && (checkpoint.ageMs as number) <= 15_000) this.world.restore(checkpoint.state, Date.now());
        this.world.epoch = this.epoch;
        for (const member of this.roster) this.world.add(member);
        this.startGameLoop();
      }
      this.callbacks.authority(this.hostId, this.epoch, msg.checkpoint);
      window.clearTimeout(this.authorityTimer);
      this.authorityTimer = window.setTimeout(() => this.updatePeerStatus(), 750); return;
    }
    if (msg.type === "signal") {
      const from = String(msg.from || ""), data = msg.data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
      if (!from || !data || typeof data !== "object") return;
      await this.connectPeer(from, false);
      const peer = this.peers.get(from); if (!peer) return;
      // ICE candidates can arrive before the offer, or while its asynchronous
      // setRemoteDescription is still running. Preserve them until it completes.
      peer.signalChain = peer.signalChain.then(async () => {
        if (this.peers.get(from) !== peer) return;
        if (data.description) {
          await peer.pc.setRemoteDescription(data.description);
          for (const candidate of peer.pendingCandidates.splice(0)) {
            try { await peer.pc.addIceCandidate(candidate); } catch { /* obsolete ICE generation */ }
          }
          if (data.description.type === "offer") {
            const answer = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(answer);
            this.signal(from, { description: peer.pc.localDescription });
          }
        } else if (data.candidate) {
          if (!peer.pc.remoteDescription) { if (peer.pendingCandidates.length < 256) peer.pendingCandidates.push(data.candidate); }
          else { try { await peer.pc.addIceCandidate(data.candidate); } catch { /* obsolete ICE generation */ } }
        }
      }).catch(() => {
        if (this.peers.get(from) !== peer || !this.active) return;
        this.callbacks.status(`Peer setup with ${this.memberName(from)} failed; retrying.`, true);
        this.schedulePeerRetry(from);
      });
      await peer.signalChain;
    }
  }

  private onPeerMessage(id: string, data: unknown, lane: "control" | "live"): void {
    const peer = this.peers.get(id); if (!peer) return;
    if (lane === "control") {
      if (typeof data !== "string" || data.length > 20_000) return;
      let msg: unknown; try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type === "navigate" && this.isHost && m.epoch === this.epoch && this.validNavigationTarget(m.target)) { this.startRequestedTravel(id, m.target); return; }
      if (m.type === "fire" && this.isHost && m.epoch === this.epoch && Number.isSafeInteger(m.sequence) && Number.isInteger(m.gun)
        && Array.isArray(m.aimPoint) && m.aimPoint.length === 3 && m.aimPoint.every(v => typeof v === "number" && Number.isFinite(v))) {
        this.world?.fireShot(id, m.sequence as number, m.gun as number, Date.now(), m.aimPoint as [number, number, number]); return;
      }
      if (m.type !== "topology-chunk" || !Number.isSafeInteger(m.revision) || (m.revision as number) < 1
        || !Number.isInteger(m.index) || !Number.isInteger(m.total) || (m.index as number) < 0 || (m.total as number) < 1
        || (m.total as number) > Math.ceil(MAX_TOPOLOGY_CHARS / TOPOLOGY_CHUNK_CHARS) || (m.index as number) >= (m.total as number)
        || typeof m.data !== "string" || m.data.length > TOPOLOGY_CHUNK_CHARS) return;
      if (peer.topology && (m.revision as number) <= peer.topology.revision) return;
      let transfer = peer.topologyReceive;
      if (!transfer || transfer.revision !== m.revision || transfer.total !== m.total) {
        if (transfer && (m.revision as number) < transfer.revision) return;
        transfer = { revision: m.revision as number, total: m.total as number, parts: new Array(m.total as number), bytes: 0, received: 0 };
        peer.topologyReceive = transfer;
      }
      const index = m.index as number;
      if (transfer.parts[index] !== undefined) return;
      transfer.parts[index] = m.data;
      transfer.bytes += m.data.length;
      transfer.received++;
      if (transfer.bytes > MAX_TOPOLOGY_CHARS) { peer.topologyReceive = null; return; }
      if (transfer.received < transfer.total) return;
      try {
        const value = JSON.parse(transfer.parts.join(""));
        if (!validTopology(value) || value.revision !== transfer.revision || (peer.topology && value.revision <= peer.topology.revision)) { peer.topologyReceive = null; return; }
        peer.topology = value; peer.positions = undefined; peer.positionsRevision = undefined; peer.lastPositionSequence = 0; peer.positionReceive.clear(); peer.topologyReceive = null;
        this.callbacks.topology(id, value);
      } catch { peer.topologyReceive = null; }
      return;
    }
    if (data instanceof ArrayBuffer) {
      const topology = peer.topology;
      if (!topology) return;
      const frame = this.acceptPositionChunk(peer, data, topology);
      if (frame && frame.sequence > peer.lastPositionSequence) {
        peer.lastPositionSequence = frame.sequence;
        peer.positions = frame.positions.slice(); peer.positionsRevision = peer.topology?.revision;
        if (this.isHost) this.world?.setObstacleSet(id, frame.positions);
        this.callbacks.positions(id, frame.positions);
      }
      return;
    }
    if (typeof data !== "string" || data.length > 64_000) return;
    let msg: unknown; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "input" && this.isHost && m.epoch === this.epoch && this.validInput(m.input)) {
      this.world?.setInput(id, m.input, Date.now()); this.callbacks.message(id, { type: "input", epoch: this.epoch, input: m.input }); return;
    }
    if (m.type === "ship" && id === this.hostId && m.epoch === this.epoch && Number.isSafeInteger(m.sequence) && typeof m.playerId === "string" && this.validPose(m.pose)) {
      const sequence = m.sequence as number;
      if (sequence <= (this.lastShipSequence.get(m.playerId) ?? 0)) return;
      this.lastShipSequence.set(m.playerId, sequence); this.callbacks.playerState(m.playerId, m.pose); return;
    }
    if (m.type === "shots" && id === this.hostId && m.epoch === this.epoch && Number.isSafeInteger(m.sequence) && (m.sequence as number) > this.lastShotSequence
      && Array.isArray(m.shots) && m.shots.length <= 128 && Array.isArray(m.impacts) && m.impacts.length <= 128) {
      if (!m.shots.every(s => this.validShot(s)) || !m.impacts.every(s => this.validImpact(s))) return;
      this.lastShotSequence = m.sequence as number; this.callbacks.shotState(m.shots, m.impacts); return;
    }
  }

  private acceptPositionChunk(peer: NonNullable<ReturnType<typeof this.peers.get>>, buffer: ArrayBuffer, topology: AnonymousTopology): { sequence: number; positions: Float32Array } | null {
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
    for (const [key, item] of peer.positionReceive) if (now - item.createdAt > 300) peer.positionReceive.delete(key);
    let assembly = peer.positionReceive.get(sequence);
    if (!assembly) {
      while (peer.positionReceive.size >= 3) peer.positionReceive.delete(peer.positionReceive.keys().next().value!);
      assembly = { revision, sequence, totalBytes, chunks: new Array(total), received: 0, createdAt: now };
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

  private validShot(value: unknown): value is ShotSnapshot {
    if (!value || typeof value !== "object") return false;
    const s = value as ShotSnapshot;
    return typeof s.id === "string" && s.id.length <= 64 && typeof s.ownerId === "string" && s.ownerId.length <= 64
      && Number.isInteger(s.gun) && s.gun >= 0 && s.gun <= 3
      && Array.isArray(s.origin) && s.origin.length === 3 && s.origin.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE)
      && Array.isArray(s.position) && s.position.length === 3 && s.position.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE)
      && Array.isArray(s.direction) && s.direction.length === 3 && s.direction.every(v => Number.isFinite(v) && Math.abs(v) <= 1.01);
  }
  private validImpact(value: unknown): value is ImpactSnapshot {
    if (!value || typeof value !== "object") return false;
    const i = value as ImpactSnapshot;
    return typeof i.id === "string" && i.id.length <= 64 && (i.kind === "star" || i.kind === "ship")
      && Array.isArray(i.position) && i.position.length === 3 && i.position.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE);
  }

  private validInput(value: unknown): value is FlightInput {
    if (!value || typeof value !== "object") return false;
    const x = value as FlightInput;
    return [x.thrust, x.strafe, x.lift, x.roll, x.pitch, x.yaw].every(v => Number.isFinite(v) && Math.abs(v) <= 1) && [x.boost, x.brake, x.fire, x.active].every(v => typeof v === "boolean");
  }
  private validPose(value: unknown): value is Pose {
    if (!value || typeof value !== "object") return false;
    const p = value as Pose;
    return Array.isArray(p.position) && p.position.length === 3 && p.position.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE)
      && Array.isArray(p.rotation) && p.rotation.length === 4 && p.rotation.every(Number.isFinite)
      && Array.isArray(p.velocity) && p.velocity.length === 3 && p.velocity.every(v => Number.isFinite(v) && Math.abs(v) <= 20_000)
      && Number.isFinite(p.health) && p.health >= 0 && p.health <= 100 && Number.isFinite(p.energy) && p.energy >= 0 && p.energy <= 1 && typeof p.boostLocked === "boolean"
      && Number.isFinite(p.boostHold) && p.boostHold >= 0 && p.boostHold <= 3 && Number.isFinite(p.regenDelay) && p.regenDelay >= 0 && p.regenDelay <= 1.5
      && typeof p.active === "boolean" && Number.isFinite(p.respawnAt) && Number.isFinite(p.protectedUntil);
  }

  private startLoops(): void {
    window.clearInterval(this.sendTimer); window.clearInterval(this.checkpointTimer); window.clearInterval(this.topologyTimer); window.clearTimeout(this.iceRefreshTimer);
    this.sendTimer = window.setInterval(() => this.sendPositions(), 100);
    this.topologyTimer = window.setInterval(() => this.pumpTopologies(), 8);
    this.checkpointTimer = window.setInterval(() => {
      if (this.isHost && this.world && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "checkpoint", epoch: this.epoch, state: this.world.snapshot(Date.now()) }));
    }, 200);
    this.scheduleIceRefresh();
    this.createWorldIfHost();
  }

  private createWorldIfHost(): void {
    if (!this.isHost) { this.world = null; return; }
    this.world = new CombatWorld(this.epoch);
    for (const member of this.roster) this.world.add(member);
    this.startGameLoop();
  }

  private updatePeerStatus(): void {
    if (!this.active) return;
    const expected = this.roster.filter(p => p.id !== this.selfId).length;
    const linked = [...this.peers.values()].filter(p => p.pc.connectionState === "connected" && p.control?.readyState === "open" && p.live?.readyState === "open").length;
    const failed = [...this.peers].filter(([, peer]) => peer.pc.connectionState === "failed");
    const lastFailure = [...this.iceFailures].find(([id]) => this.peers.get(id)?.pc.connectionState !== "connected")?.[1];
    const iceNote = linked < expected && lastFailure ? ` A ${lastFailure.kind} endpoint returned ICE error ${lastFailure.code}; trying other direct and relay paths.` : "";
    const failedNote = failed.length ? " A participant connection failed; retrying." : "";
    const relayNote = this.relayStatus === "pending" ? " Relay access is preparing; direct connections are being tried." :
      this.relayStatus === "unavailable" ? " Relay service unavailable; direct connections are being tried." :
      this.relayStatus === "quota" ? " Free relay allowance exhausted; direct connections may still work." : "";
    if (!expected) this.callbacks.status(`Room ${this.roomCode} is ready; waiting for other pilots.${relayNote}`, this.relayStatus === "quota" || this.relayStatus === "unavailable");
    else this.callbacks.status(`${linked} of ${expected} participant connections ready.${failedNote}${iceNote}${relayNote}`, failed.length > 0 || (linked < expected && (this.relayStatus === "quota" || this.relayStatus === "unavailable")));
  }

  private readRelayStatus(value: unknown, servers: RTCIceServer[]): "ready" | "pending" | "unavailable" | "quota" | "direct-only" {
    if (value === "ready" || value === "pending" || value === "unavailable" || value === "quota" || value === "direct-only") return value;
    return servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => typeof url === "string" && /^turns?:/i.test(url))) ? "ready" : "direct-only";
  }

  private roomServiceError(message: SignalMessage): string {
    const code = typeof message.code === "string" ? message.code : "";
    if (code === "room-not-found") return "That room code is invalid or the room has closed.";
    if (code === "full") return "That room already has four pilots.";
    if (code === "update-required") return "Everyone in the room must install plugin version 0.3.2 or newer.";
    if (code === "service-full") return "The hosted room service is at capacity. Try again later.";
    if (code === "rate-limited") return "The room service is receiving too many requests. Wait a minute and try again.";
    if (code === "service-unavailable") return "The hosted room service is temporarily unavailable. Try again shortly.";
    if (code === "relay-quota") return "The free TURN relay allowance is exhausted. Direct connections may still work.";
    return typeof message.message === "string" ? message.message.slice(0, 180) : "The room service rejected the request.";
  }

  private requestIceConfiguration(): void {
    const now = Date.now();
    if (now - this.lastIceRequestAt < 20_000) return;
    if (this.socket?.readyState === WebSocket.OPEN && this.active) {
      try { this.socket.send(JSON.stringify({ type: "ice-refresh" })); this.lastIceRequestAt = now; } catch { /* socket may be closing */ }
    }
  }

  private scheduleIceRefresh(): void {
    window.clearTimeout(this.iceRefreshTimer);
    if (!this.active) return;
    const now = Date.now();
    const delay = this.iceExpiresAt > now ? Math.max(30_000, this.iceExpiresAt - now - 15 * 60_000) : 30_000;
    this.iceRefreshTimer = window.setTimeout(() => this.requestIceConfiguration(), delay);
  }

  private async applyIceConfiguration(): Promise<void> {
    for (const [id, peer] of this.peers) {
      try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: this.relay });
        if (peer.pc.connectionState === "failed") { this.schedulePeerRetry(id); continue; }
        if (this.selfId.localeCompare(id) < 0 && peer.pc.connectionState === "connected" && peer.pc.signalingState === "stable") {
          peer.pc.restartIce();
          const offer = await peer.pc.createOffer({ iceRestart: true });
          await peer.pc.setLocalDescription(offer);
          this.signal(id, { description: peer.pc.localDescription });
        }
      } catch { this.schedulePeerRetry(id); }
    }
  }

  private reportIceError(id: string, event: Event): void {
    const peer = this.peers.get(id);
    if (!peer || peer.pc.connectionState === "connected") return;
    const detail = event as Event & { errorCode?: number; url?: string };
    const code = Number.isInteger(detail.errorCode) ? Number(detail.errorCode) : 0;
    if (!code) return;
    const kind = /^turns?:/i.test(detail.url ?? "") ? "TURN" : /^stuns?:/i.test(detail.url ?? "") ? "STUN" : "ICE";
    this.iceFailures.set(id, { kind, code });
    // A candidate error concerns one server URL, not the entire connection.
    // Only the provider backend can confirm exhaustion of the monthly quota.
    this.updatePeerStatus();
    const now = Date.now();
    if (kind !== "TURN" || now - this.lastIceErrorAt < 10_000) return;
    this.lastIceErrorAt = now;
    this.requestIceConfiguration();
  }

  private schedulePeerRetry(id: string, delayMs = 2000): void {
    if (this.retryTimers.has(id) || !this.roster.some(p => p.id === id)) return;
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(id);
      if (!this.active || !this.roster.some(p => p.id === id)) return;
      const localOrder = this.roster.findIndex(p => p.id === this.selfId), remoteOrder = this.roster.findIndex(p => p.id === id);
      this.removePeer(id);
      if (localOrder > remoteOrder) void this.connectPeer(id, true);
      else this.updatePeerStatus();
    }, delayMs);
    this.retryTimers.set(id, timer);
  }

  private startGameLoop(): void {
    window.clearInterval(this.gameTimer); this.lastGameStep = Date.now(); this.lastStateSend = 0;
    let lastObstacleUpdate = 0;
    this.gameTimer = window.setInterval(() => {
      if (!this.isHost || !this.world) return;
      const now = Date.now();
      if (now < this.gameResumeAt) { this.lastGameStep = now; return; }
      const dt = Math.max(0.001, Math.min(0.05, (now - this.lastGameStep) / 1000)); this.lastGameStep = now;
      this.world.step(dt, now);
      if (now - lastObstacleUpdate >= 100) {
        lastObstacleUpdate = now;
        const nodes = this.graph().nodes, positions = new Float32Array(nodes.length * 3);
        for (let i = 0; i < nodes.length; i++) { positions[i * 3] = nodes[i].x; positions[i * 3 + 1] = nodes[i].y; positions[i * 3 + 2] = nodes[i].z; }
        this.world.setObstacleSet(this.selfId, positions);
      }
      if (now - this.lastStateSend >= 50) {
        this.lastStateSend = now;
        this.publishWorldState(now);
      }
    }, 16);
  }

  private publishWorldState(now: number): void {
    if (!this.world) return;
    for (const { id, pose } of this.world.poses(now)) {
      this.callbacks.playerState(id, pose);
      this.sendAll({ type: "ship", epoch: this.epoch, sequence: ++this.stateSequence, playerId: id, pose });
    }
    const shots = this.world.shotSnapshots(), impacts = this.world.impactSnapshots(now);
    this.callbacks.shotState(shots, impacts);
    this.sendAll({ type: "shots", epoch: this.epoch, sequence: ++this.stateSequence, shots, impacts });
  }

  setLocalGraph(data: GraphData): void {
    if (!this.active) return;
    try {
      this.topology = makeAnonymousTopology(data, this.ids, ++this.revision);
      for (const id of this.peers.keys()) this.queueTopology(id, this.topology);
    } catch (e) {
      this.revision--;
      this.callbacks.status(e instanceof Error ? e.message : "Could not share this constellation.", true);
    }
  }
  private sendPositions(): void { if (this.topology) for (const id of this.peers.keys()) this.sendPositionsTo(id); }
  private sendPositionsTo(id: string): void {
    const peer = this.peers.get(id), topology = this.topology, channel = peer?.live;
    if (!peer || !channel || channel.readyState !== "open" || !topology || channel.bufferedAmount > 512_000) return;
    try {
      const chunks = encodePositionChunks(this.graph().nodes, topology, ++peer.positionSequence);
      for (const chunk of chunks) channel.send(chunk);
    } catch (e) { this.callbacks.status(String(e), true); }
  }

  private queueTopology(id: string, topology: AnonymousTopology): void {
    const peer = this.peers.get(id), control = peer?.control;
    if (!peer || !control || control.readyState !== "open") return;
    const json = JSON.stringify(topology);
    if (json.length > MAX_TOPOLOGY_CHARS) { this.callbacks.status("This anonymous constellation snapshot exceeds the 16 MiB network limit.", true); return; }
    peer.topologySend = { revision: topology.revision, json, next: 0, total: Math.ceil(json.length / TOPOLOGY_CHUNK_CHARS) };
  }

  private pumpTopologies(): void {
    for (const peer of this.peers.values()) {
      const transfer = peer.topologySend, channel = peer.control;
      if (!transfer || !channel || channel.readyState !== "open" || channel.bufferedAmount > 256_000) continue;
      const index = transfer.next++, from = index * TOPOLOGY_CHUNK_CHARS;
      try { channel.send(JSON.stringify({ type: "topology-chunk", revision: transfer.revision, index, total: transfer.total, data: transfer.json.slice(from, from + TOPOLOGY_CHUNK_CHARS) })); }
      catch { transfer.next--; continue; }
      if (transfer.next >= transfer.total) peer.topologySend = null;
    }
  }

  sendInput(input: FlightInput): void {
    if (!this.active) return;
    if (this.isHost) this.world?.setInput(this.selfId, input, Date.now());
    else this.sendTo(this.hostId, { type: "input", epoch: this.epoch, input });
  }
  fire(sequence: number, gun: number, aimPoint: [number, number, number]): void {
    if (!this.active || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isInteger(gun) || gun < 0 || gun > 3) return;
    const now = Date.now();
    if (!aimPoint.every(Number.isFinite) || aimPoint.some(v => Math.abs(v) > MAX_COORDINATE)) return;
    if (this.isHost) this.world?.fireShot(this.selfId, sequence, gun, now, aimPoint);
    else this.sendReliable(this.hostId, { type: "fire", epoch: this.epoch, sequence, gun, aimPoint });
  }

  requestFastTravel(target: NavigationTarget): void {
    if (!this.active || !this.validNavigationTarget(target)) return;
    if (this.isHost) this.startRequestedTravel(this.selfId, target);
    else this.sendReliable(this.hostId, { type: "navigate", epoch: this.epoch, target });
  }

  private validNavigationTarget(value: unknown): value is NavigationTarget {
    if (!value || typeof value !== "object") return false;
    const target = value as NavigationTarget;
    return typeof target.ownerId === "string" && /^[0-9a-f-]{36}$/i.test(target.ownerId)
      && this.roster.some(member => member.id === target.ownerId) && typeof target.starId === "string"
      && /^n-[0-9a-f-]{36}$/i.test(target.starId) && Number.isSafeInteger(target.revision) && target.revision > 0;
  }

  private startRequestedTravel(playerId: string, target: NavigationTarget): void {
    const world = this.world; if (!world || !this.validNavigationTarget(target)) return;
    let topology: AnonymousTopology | undefined, positions: readonly SimNode[] | Float32Array | undefined;
    if (target.ownerId === this.selfId) { topology = this.topology ?? undefined; positions = this.graph().nodes; }
    else {
      const owner = this.peers.get(target.ownerId); topology = owner?.topology;
      if (owner?.positionsRevision === target.revision) positions = owner.positions;
    }
    if (!topology || topology.revision !== target.revision || !positions) return;
    const index = topology.nodes.findIndex(node => node.id === target.starId);
    if (index < 0) return;
    let position: [number, number, number], degree = topology.nodes[index].degree;
    if (positions instanceof Float32Array) {
      const offset = index * 3; position = [positions[offset], positions[offset + 1], positions[offset + 2]];
    } else {
      const node = positions[index]; if (!node) return;
      position = [node.x, node.y, node.z];
    }
    if (world.startTravel(playerId, position, Math.min(5.5, 0.9 + Math.sqrt(degree) * 0.5), Date.now())) this.callbacks.navigation?.(target, "travelling");
  }

  private sendReliable(id: string, message: GameMessage): void {
    const channel = this.peers.get(id)?.control;
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 128_000) { this.callbacks.status(`The reliable connection to ${this.memberName(id)} is not ready.`, true); return; }
    try { channel.send(JSON.stringify(message)); } catch { this.callbacks.status(`The reliable connection to ${this.memberName(id)} failed.`, true); }
  }
  sendAll(message: GameMessage): void { for (const id of this.peers.keys()) this.sendTo(id, message); }
  private sendTo(id: string, message: GameMessage): void {
    const ch = this.peers.get(id)?.live; if (!ch || ch.readyState !== "open" || ch.bufferedAmount > 512_000) return;
    try { ch.send(JSON.stringify(message)); } catch { /* the peer may have closed during a frame */ }
  }
  private signal(to: string, data: object): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "signal", to, data })); }
  private memberName(id: string): string { return this.roster.find(p => p.id === id)?.name ?? "player"; }
  private removePeer(id: string): void {
    this.iceFailures.delete(id);
    const retry = this.retryTimers.get(id); if (retry !== undefined) { window.clearTimeout(retry); this.retryTimers.delete(id); }
    const peer = this.peers.get(id); if (peer) { this.peers.delete(id); peer.control?.close(); peer.live?.close(); peer.pc.close(); }
    this.lastShipSequence.delete(id);
  }

  leave(message = "Left the room."): void {
    if (this.closed) return;
    this.closed = true; window.clearInterval(this.sendTimer); window.clearInterval(this.checkpointTimer); window.clearInterval(this.topologyTimer); window.clearTimeout(this.iceRefreshTimer); window.clearTimeout(this.authorityTimer);
    window.clearInterval(this.gameTimer); this.world = null;
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.iceFailures.clear();
    const ws = this.socket; this.socket = null;
    if (ws) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "leave" })); } catch { /* closing anyway */ } } ws.close(); }
    const self = this.selfId; this.roomCode = ""; this.selfId = ""; this.hostId = ""; this.roster = []; this.topology = null; this.ids.clear(); this.revision = 0;
    this.relay = []; this.iceExpiresAt = 0; this.relayStatus = "pending"; this.lastIceRequestAt = 0;
    this.lastShipSequence.clear(); this.lastShotSequence = 0; this.stateSequence = 0; this.positionSequence = 0;
    this.callbacks.shotState([], []);
    this.callbacks.removed(self); this.callbacks.members([], "", "", 0); this.callbacks.status(message);
  }
}
