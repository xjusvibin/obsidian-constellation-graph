import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SIGNAL_BYTES = 64_000;
const MAX_CHECKPOINT_BYTES = 64_000;
const ROOM_CAPACITY = 4;
const TURN_LIFETIME_SECONDS = 3600;
const TURN_PROPAGATION_MS = 2 * 60_000;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(byte => CHARS[byte % CHARS.length]).join("");
}

function byteLength(value) { return new TextEncoder().encode(value).byteLength; }

function publicRoom(room) {
  return [...room.members.values()].map(member => ({ id: member.id, name: member.name, joinedAt: member.joinedAt, slot: member.slot }));
}

function cleanPeerSignal(value) {
  if (!value || typeof value !== "object") return null;
  const description = value.description;
  if (description && typeof description === "object" && (description.type === "offer" || description.type === "answer")
    && typeof description.sdp === "string" && byteLength(description.sdp) <= MAX_SIGNAL_BYTES) {
    return { description: { type: description.type, sdp: description.sdp } };
  }
  const candidate = value.candidate;
  if (candidate && typeof candidate === "object" && typeof candidate.candidate === "string" && candidate.candidate.length <= 4096
    && (candidate.sdpMid === undefined || candidate.sdpMid === null || (typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 256))
    && (candidate.sdpMLineIndex === undefined || candidate.sdpMLineIndex === null || (Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 100))
    && (candidate.usernameFragment === undefined || candidate.usernameFragment === null || (typeof candidate.usernameFragment === "string" && candidate.usernameFragment.length <= 256))) {
    return { candidate: {
      candidate: candidate.candidate,
      ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
      ...(candidate.sdpMLineIndex !== undefined ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
      ...(candidate.usernameFragment !== undefined ? { usernameFragment: candidate.usernameFragment } : {}),
    } };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const id = env.ROOMS.idFromName("global-room-coordinator");
      return env.ROOMS.get(id).fetch(new Request("https://coordinator.internal/health"));
    }
    if (url.pathname !== "/" || request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const id = env.ROOMS.idFromName("global-room-coordinator");
    return env.ROOMS.get(id).fetch(request);
  },

  async scheduled(_event, env, context) {
    const id = env.ROOMS.idFromName("global-room-coordinator");
    context.waitUntil(env.ROOMS.get(id).rotateTurnCredential());
  },
};

/** One in-memory coordinator preserves the existing room protocol and election ordering. */
export class RoomCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();
    this.connections = new Map();
    this.attempts = new Map();
    this.turnCredentials = [];
    this.turnRotation = null;
    this.turnError = "";
    this.turnRetryAt = 0;
    const restoreCredentials = async () => {
      try {
        const saved = await this.ctx.storage?.get("turnCredentials");
        if (Array.isArray(saved)) this.turnCredentials = saved.filter(item => item && Number.isFinite(item.createdAt) && Number.isFinite(item.usableAt) && Number.isFinite(item.expiresAt) && Array.isArray(item.iceServers));
      } catch { /* a cold coordinator can still create a fresh relay credential */ }
    };
    this.credentialStateLoaded = typeof this.ctx.blockConcurrencyWhile === "function"
      ? this.ctx.blockConcurrencyWhile(restoreCredentials)
      : restoreCredentials();
    this.maxRooms = Math.max(1, Math.min(500, Number(env.MAX_ROOMS) || 500));
    this.stunUrls = (env.STUN_URLS || "stun:stun.l.google.com:19302").split(",").map(value => value.trim()).filter(Boolean);
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return json({ ok: true, rooms: this.rooms.size });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!this.consume(`connect:${ip}`, 40)) return new Response("Too many connection attempts", { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const connection = { ip, member: null, roomCode: "", closed: false, queue: Promise.resolve() };
    this.connections.set(server, connection);
    server.accept();
    server.addEventListener("message", event => {
      connection.queue = connection.queue.then(() => this.onMessage(server, connection, event.data)).catch(() => {
        this.fail(server, "service-unavailable", "The room service could not process that request. Try again.");
      });
    });
    server.addEventListener("close", () => this.onClose(server, connection));
    server.addEventListener("error", () => this.onClose(server, connection));
    return new Response(null, { status: 101, webSocket: client });
  }

  consume(key, limit, windowMs = 60_000) {
    const now = Date.now();
    let record = this.attempts.get(key);
    if (!record || now - record.start >= windowMs) { record = { start: now, count: 0 }; this.attempts.set(key, record); }
    record.count++;
    if (this.attempts.size > 5000) {
      for (const [id, item] of this.attempts) if (now - item.start >= 60_000) this.attempts.delete(id);
    }
    return record.count <= limit;
  }

  send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(message)); } catch { /* a peer can close between the check and send */ }
    }
  }

  fail(ws, code, message) { this.send(ws, { type: "error", code, message }); }

  roomCast(room, message, exceptId = "") {
    for (const [id, member] of room.members) if (id !== exceptId) this.send(member.ws, message);
  }

  async iceConfiguration() {
    await this.credentialStateLoaded;
    const now = Date.now();
    this.turnCredentials = this.turnCredentials.filter(item => item.expiresAt > now);
    const newest = [...this.turnCredentials].sort((a, b) => b.createdAt - a.createdAt);
    const active = newest.find(item => item.usableAt <= now);
    const warming = newest.find(item => item.usableAt > now);
    if (!active && !warming && !this.turnRotation && now >= this.turnRetryAt) this.ctx.waitUntil(this.rotateTurnCredential());
    const iceServers = [...this.stunUrls.map(urls => ({ urls }))];
    if (active) iceServers.push(...active.iceServers);
    const relayStatus = active ? "ready" : warming || this.turnRotation ? "pending" : this.turnError || "unavailable";
    return { iceServers, iceExpiresAt: active?.expiresAt || 0, relayStatus };
  }

  async rotateTurnCredential() {
    await this.credentialStateLoaded;
    if (this.turnRotation) return this.turnRotation;
    this.turnRotation = this.createTurnCredential();
    try { return await this.turnRotation; }
    finally { this.turnRotation = null; }
  }

  async createTurnCredential() {
    const app = typeof this.env.METERED_APP === "string" ? this.env.METERED_APP.trim() : "";
    const secret = typeof this.env.METERED_SECRET_KEY === "string" ? this.env.METERED_SECRET_KEY : "";
    if (!/^[a-z0-9-]{2,80}$/i.test(app) || !secret) {
      this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000; return false;
    }

    const root = `https://${app}.metered.live`;
    try {
      const createUrl = new URL("/api/v1/turn/credential", root);
      createUrl.searchParams.set("secretKey", secret);
      const createdResponse = await fetch(createUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiryInSeconds: TURN_LIFETIME_SECONDS, label: "constellation-rooms" }),
      });
      if (!createdResponse.ok) {
        const body = (await createdResponse.text()).slice(0, 2000).toLowerCase();
        this.turnError = /monthly.*(quota|allowance|limit)|relay.*quota|usage quota|quota exceeded|turn.*allowance/.test(body) ? "quota" : "unavailable";
        this.turnRetryAt = Date.now() + 5 * 60_000;
        return false;
      }
      const credential = await createdResponse.json();
      if (typeof credential?.apiKey !== "string" || typeof credential?.username !== "string" || typeof credential?.password !== "string") {
        this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000; return false;
      }

      const serversUrl = new URL("/api/v1/turn/credentials", root);
      serversUrl.searchParams.set("apiKey", credential.apiKey);
      const serversResponse = await fetch(serversUrl, { headers: { accept: "application/json" } });
      if (!serversResponse.ok) {
        this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000; return false;
      }
      const rawServers = await serversResponse.json();
      if (!Array.isArray(rawServers) || rawServers.length > 12 || !rawServers.every(server => server && typeof server.urls === "string" && /^(stun|stuns|turn|turns):/i.test(server.urls))) {
        this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000; return false;
      }
      const turnServers = rawServers.filter(server => /^turns?:/i.test(server.urls)
        && typeof server.username === "string" && typeof server.credential === "string");
      if (!turnServers.length) { this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000; return false; }

      const createdAt = Date.now();
      this.turnCredentials.push({ createdAt, usableAt: createdAt + TURN_PROPAGATION_MS, expiresAt: createdAt + TURN_LIFETIME_SECONDS * 1000, iceServers: rawServers });
      this.turnCredentials = this.turnCredentials.filter(item => item.expiresAt > createdAt).slice(-3);
      try { await this.ctx.storage?.put("turnCredentials", this.turnCredentials); } catch { /* relay credentials remain usable in memory until expiry */ }
      this.turnError = ""; this.turnRetryAt = 0;
      return true;
    } catch {
      this.turnError = "unavailable"; this.turnRetryAt = Date.now() + 5 * 60_000;
      return false;
    }
  }

  async onMessage(ws, connection, raw) {
    if (typeof raw !== "string") { this.fail(ws, "bad-message", "Message must be JSON text."); return; }
    if (byteLength(raw) > MAX_MESSAGE_BYTES) { this.fail(ws, "message-too-large", "The request exceeded its size limit."); return; }
    let message;
    try { message = JSON.parse(raw); } catch { this.fail(ws, "bad-message", "Message must be valid JSON."); return; }
    if (!message || typeof message !== "object" || typeof message.type !== "string") { this.fail(ws, "bad-message", "Message type is required."); return; }

    if (message.type === "create" || message.type === "join") {
      if (!this.consume(`room:${connection.ip}`, 20)) { this.fail(ws, "rate-limited", "Too many room requests. Wait a minute and try again."); return; }
      if (connection.member) { this.fail(ws, "already-joined", "This connection already joined a room."); return; }
      if (message.protocol !== 2) { this.fail(ws, "update-required", "Update the plugin to version 0.3.2 or newer to use this room service."); return; }
      const name = typeof message.name === "string" ? message.name.trim().slice(0, 24) : "";
      if (!name) { this.fail(ws, "bad-name", "Enter a display name (up to 24 characters)."); return; }
      let room;
      if (message.type === "create") {
        if (this.rooms.size >= this.maxRooms) { this.fail(ws, "service-full", "The room service is at capacity. Try again later."); return; }
        let code = randomCode();
        while (this.rooms.has(code)) code = randomCode();
        room = { code, protocol: message.protocol, hostId: "", epoch: 1, members: new Map(), checkpoint: null, nextMemberOrder: 0 };
        this.rooms.set(code, room); connection.roomCode = code;
      } else {
        const code = typeof message.code === "string" ? message.code.toUpperCase() : "";
        room = this.rooms.get(code);
        if (!room) { this.fail(ws, "room-not-found", "That room code is invalid or the room has closed."); return; }
        if (room.protocol !== message.protocol) { this.fail(ws, "update-required", "Everyone in the room must install plugin version 0.3.2 or newer."); return; }
        if (room.members.size >= ROOM_CAPACITY) { this.fail(ws, "full", "This room already has four players."); return; }
        connection.roomCode = code;
      }
      const usedSlots = new Set([...room.members.values()].map(member => member.slot));
      const slot = [0, 1, 2, 3].find(candidate => !usedSlots.has(candidate));
      if (slot === undefined) { this.fail(ws, "full", "This room already has four players."); return; }
      const id = crypto.randomUUID();
      const member = { id, name, joinedAt: Date.now(), order: room.nextMemberOrder++, slot, ws };
      connection.member = member; room.members.set(id, member);
      if (!room.hostId) room.hostId = id;
      const relay = await this.iceConfiguration();
      if (message.type === "create") this.send(ws, { type: "created", code: room.code, selfId: id, hostId: room.hostId, epoch: room.epoch, members: publicRoom(room), ...relay });
      else this.send(ws, { type: "joined", code: room.code, selfId: id, hostId: room.hostId, epoch: room.epoch, members: publicRoom(room), checkpoint: room.checkpoint, ...relay });
      this.roomCast(room, { type: "member-joined", member: { id, name, joinedAt: member.joinedAt, slot }, hostId: room.hostId, epoch: room.epoch }, id);
      return;
    }

    const room = this.rooms.get(connection.roomCode);
    if (!connection.member || !room) { this.fail(ws, "not-in-room", "Join a room before sending this message."); return; }
    if (message.type === "ice-refresh") {
      if (!this.consume(`ice:${connection.member.id}`, 4)) { this.fail(ws, "rate-limited", "Wait before refreshing relay configuration again."); return; }
      this.send(ws, { type: "ice-servers", ...await this.iceConfiguration() });
    } else if (message.type === "signal") {
      if (!this.consume(`signal:${connection.ip}`, 300)) { this.fail(ws, "rate-limited", "Too many connection setup messages."); return; }
      const target = room.members.get(message.to);
      const data = cleanPeerSignal(message.data);
      if (!target || message.to === connection.member.id || !data || byteLength(JSON.stringify(data)) > MAX_SIGNAL_BYTES) return;
      this.send(target.ws, { type: "signal", from: connection.member.id, data });
    } else if (message.type === "checkpoint") {
      if (connection.member.id !== room.hostId || message.epoch !== room.epoch || !message.state || typeof message.state !== "object" || message.state.epoch !== room.epoch) return;
      const checkpointJson = JSON.stringify(message.state);
      if (byteLength(checkpointJson) > MAX_CHECKPOINT_BYTES) { this.fail(ws, "checkpoint-too-large", "The room checkpoint exceeded its size limit."); return; }
      room.checkpoint = { epoch: room.epoch, sentAt: Date.now(), state: message.state };
    } else if (message.type === "leave") {
      try { ws.close(1000, "Left room"); } catch { this.onClose(ws, connection); }
    }
  }

  onClose(ws, connection) {
    if (connection.closed) return;
    connection.closed = true; this.connections.delete(ws);
    const member = connection.member;
    if (!member) return;
    const room = this.rooms.get(connection.roomCode);
    if (!room || !room.members.delete(member.id)) return;
    if (room.members.size === 0) { this.rooms.delete(connection.roomCode); return; }
    if (room.hostId === member.id) {
      const next = [...room.members.values()].sort((a, b) => a.order - b.order)[0];
      room.hostId = next.id; room.epoch++;
      const checkpoint = room.checkpoint ? { ageMs: Math.max(0, Date.now() - room.checkpoint.sentAt), state: room.checkpoint.state } : null;
      this.roomCast(room, { type: "authority", hostId: room.hostId, epoch: room.epoch, checkpoint });
    }
    this.roomCast(room, { type: "member-left", id: member.id, hostId: room.hostId, epoch: room.epoch });
  }
}
