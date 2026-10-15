"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 8787);
const turnSecret = process.env.TURN_SECRET || "";
const turnUrls = (process.env.TURN_URLS || "").split(",").map(x => x.trim()).filter(Boolean);
const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302").split(",").map(x => x.trim()).filter(Boolean);
const maxRooms = Number(process.env.MAX_ROOMS || 500);
const turnCredentialLifetimeSeconds = 3600;
const rooms = new Map();
const attempts = new Map();
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function consume(key, limit, windowMs = 60_000) {
  const now = Date.now();
  let record = attempts.get(key);
  if (!record || now - record.start >= windowMs) { record = { start: now, count: 0 }; attempts.set(key, record); }
  record.count++;
  return record.count <= limit;
}

function randomCode() {
  const b = crypto.randomBytes(8);
  return [...b].map(x => CHARS[x % CHARS.length]).join("");
}
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function roomCast(room, message, exceptId = "") {
  for (const [id, member] of room.members) if (id !== exceptId) send(member.ws, message);
}
function publicRoom(room) {
  return [...room.members.values()].map(m => ({ id: m.id, name: m.name, joinedAt: m.joinedAt, slot: m.slot }));
}
function cleanPeerSignal(value) {
  if (!value || typeof value !== "object") return null;
  const description = value.description;
  if (description && typeof description === "object" && (description.type === "offer" || description.type === "answer")
    && typeof description.sdp === "string" && Buffer.byteLength(description.sdp) <= 64_000) {
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
function fail(ws, code, message) { send(ws, { type: "error", code, message }); }
function iceConfiguration() {
  const servers = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });
  let expiresAt = 0;
  if (turnSecret && turnUrls.length) {
    const expiry = Math.floor(Date.now() / 1000) + turnCredentialLifetimeSeconds;
    const username = `${expiry}:${crypto.randomUUID()}`;
    const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
    servers.push({ urls: turnUrls, username, credential });
    expiresAt = expiry * 1000;
  }
  return { iceServers: servers, iceExpiresAt: expiresAt, relayStatus: turnSecret && turnUrls.length ? "ready" : "direct-only" };
}
function clientIp(req) {
  // The service is only reachable behind the bundled reverse proxy; trust its forwarded client address.
  const forwarded = req.headers["x-forwarded-for"];
  return (typeof forwarded === "string" ? forwarded.split(",", 1)[0].trim() : "") || req.socket.remoteAddress || "unknown";
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024, perMessageDeflate: false });
wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  if (!consume(`connect:${ip}`, 40)) { ws.close(1008, "Too many connection attempts"); return; }
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  let member = null;
  let roomCode = "";
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { fail(ws, "bad-message", "Message must be valid JSON."); return; }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") { fail(ws, "bad-message", "Message type is required."); return; }

    if (msg.type === "create" || msg.type === "join") {
      if (!consume(`room:${ip}`, 20)) { fail(ws, "rate-limited", "Too many room requests. Wait a minute and try again."); return; }
      if (member) { fail(ws, "already-joined", "This connection already joined a room."); return; }
      if (msg.protocol !== 2) { fail(ws, "update-required", "Update the plugin to version 0.3.2 or newer to use this room service."); return; }
      const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 24) : "";
      if (!name) { fail(ws, "bad-name", "Enter a display name (up to 24 characters)."); return; }
      let room;
      if (msg.type === "create") {
        if (rooms.size >= maxRooms) { fail(ws, "service-full", "The room service is at capacity. Try again later."); return; }
        roomCode = randomCode();
        while (rooms.has(roomCode)) roomCode = randomCode();
        room = { code: roomCode, protocol: msg.protocol, hostId: "", epoch: 1, members: new Map(), checkpoint: null, nextMemberOrder: 0 };
        rooms.set(roomCode, room);
      } else {
        roomCode = typeof msg.code === "string" ? msg.code.toUpperCase() : "";
        room = rooms.get(roomCode);
        if (!room) { fail(ws, "room-not-found", "That room code is invalid or the room has closed."); return; }
        if (room.protocol !== msg.protocol) { fail(ws, "update-required", "Everyone in the room must install plugin version 0.3.2 or newer."); return; }
        if (room.members.size >= 4) { fail(ws, "full", "This room already has four players."); return; }
      }
      const usedSlots = new Set([...room.members.values()].map(m => m.slot));
      const slot = [0, 1, 2, 3].find(n => !usedSlots.has(n));
      if (slot === undefined) { fail(ws, "full", "This room already has four players."); return; }
      const id = crypto.randomUUID();
      member = { id, name, joinedAt: Date.now(), order: room.nextMemberOrder++, slot, ws };
      room.members.set(id, member);
      if (!room.hostId) room.hostId = id;
      const relay = iceConfiguration();
      if (msg.type === "create") send(ws, { type: "created", code: roomCode, selfId: id, hostId: room.hostId, epoch: room.epoch, members: publicRoom(room), ...relay });
      else send(ws, { type: "joined", code: roomCode, selfId: id, hostId: room.hostId, epoch: room.epoch, members: publicRoom(room), checkpoint: room.checkpoint, ...relay });
      roomCast(room, { type: "member-joined", member: { id, name, joinedAt: member.joinedAt, slot }, hostId: room.hostId, epoch: room.epoch }, id);
      return;
    }

    if (!member || !rooms.has(roomCode)) { fail(ws, "not-in-room", "Join a room before sending this message."); return; }
    const room = rooms.get(roomCode);
    if (msg.type === "ice-refresh") {
      if (!consume(`ice:${member.id}`, 4, 60_000)) { fail(ws, "rate-limited", "Wait before refreshing relay configuration again."); return; }
      send(ws, { type: "ice-servers", ...iceConfiguration() });
    } else if (msg.type === "signal") {
      if (!consume(`signal:${ip}`, 300)) { fail(ws, "rate-limited", "Too many connection setup messages."); return; }
      const target = room.members.get(msg.to);
      const data = cleanPeerSignal(msg.data);
      if (!target || msg.to === member.id || !data || Buffer.byteLength(JSON.stringify(data)) > 64_000) return;
      send(target.ws, { type: "signal", from: member.id, data });
    } else if (msg.type === "checkpoint") {
      if (member.id !== room.hostId || msg.epoch !== room.epoch || !msg.state || typeof msg.state !== "object" || msg.state.epoch !== room.epoch) return;
      const json = JSON.stringify(msg.state);
      if (Buffer.byteLength(json) > 64_000) { fail(ws, "checkpoint-too-large", "The room checkpoint exceeded its size limit."); return; }
      room.checkpoint = { epoch: room.epoch, sentAt: Date.now(), state: msg.state };
    } else if (msg.type === "leave") {
      ws.close(1000, "Left room");
    }
  });

  ws.on("close", () => {
    if (!member) return;
    const room = rooms.get(roomCode);
    if (!room || !room.members.delete(member.id)) return;
    if (room.members.size === 0) { rooms.delete(roomCode); return; }
    if (room.hostId === member.id) {
      const next = [...room.members.values()].sort((a, b) => a.order - b.order)[0];
      room.hostId = next.id;
      room.epoch++;
      const checkpoint = room.checkpoint ? { ageMs: Math.max(0, Date.now() - room.checkpoint.sentAt), state: room.checkpoint.state } : null;
      roomCast(room, { type: "authority", hostId: room.hostId, epoch: room.epoch, checkpoint });
    }
    roomCast(room, { type: "member-left", id: member.id, hostId: room.hostId, epoch: room.epoch });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 3_000);
heartbeat.unref();

server.listen(port, "0.0.0.0", () => process.stdout.write(`Constellation signaling listening on ${port}\n`));
function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
