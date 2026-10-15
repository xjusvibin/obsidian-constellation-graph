import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const original = await readFile(new URL("../server/worker.js", import.meta.url), "utf8");
const executable = original
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";\r?\n/, "")
  .replace("export default {", "const worker = {")
  .replace("export class RoomCoordinator", "class RoomCoordinator");
const FakeDate = class extends Date {
  static now() { return FakeDate.clock; }
};
FakeDate.clock = Date.now();
const FakeDurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };
const FakeWebSocket = { OPEN: 1 };
const loadWorker = fetchImpl => new Function("DurableObject", "crypto", "fetch", "WebSocket", "WebSocketPair", "Response", "TextEncoder", "URL", "Date",
  `${executable}\nreturn { worker, RoomCoordinator };`)(FakeDurableObject, webcrypto, fetchImpl, FakeWebSocket, class {}, Response, TextEncoder, URL, FakeDate);

function testIceServers() {
  return [
    { urls: "stun:relay.metered.test:80" },
    { urls: "turn:relay.metered.test:80", username: "temporary-user", credential: "temporary-password" },
    { urls: "turn:relay.metered.test:443?transport=tcp", username: "temporary-user", credential: "temporary-password" },
  ];
}

test("hosted TURN credentials are one hour, held through propagation, then served on refresh", async () => {
  FakeDate.clock = Date.now();
  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input); calls.push({ url, init });
    if (url.pathname.endsWith("/turn/credential")) return Response.json({ apiKey: "credential-scoped-key", username: "temporary-user", password: "temporary-password" });
    if (url.pathname.endsWith("/turn/credentials")) return Response.json(testIceServers());
    return new Response("unexpected URL", { status: 404 });
  };
  const { RoomCoordinator } = loadWorker(fakeFetch);
  const stored = new Map();
  const context = {
    waitUntil(promise) { void promise; },
    blockConcurrencyWhile(callback) { return callback(); },
    storage: { async get(key) { return structuredClone(stored.get(key)); }, async put(key, value) { stored.set(key, structuredClone(value)); } },
  };
  const service = new RoomCoordinator(context, { METERED_APP: "test-app", METERED_SECRET_KEY: "private-test-key", STUN_URLS: "stun:stun.example.test:3478" });
  await service.createTurnCredential();

  const createCall = calls.find(call => call.url.pathname.endsWith("/turn/credential"));
  assert.equal(createCall.init.method, "POST");
  assert.deepEqual(JSON.parse(createCall.init.body), { expiryInSeconds: 3600, label: "constellation-rooms" });
  assert.equal(service.turnCredentials.length, 1);
  assert.equal(stored.has("turnCredentials"), true, "short-lived relay state survives a coordinator restart");

  const restored = new RoomCoordinator(context, { METERED_APP: "test-app", METERED_SECRET_KEY: "private-test-key", STUN_URLS: "stun:stun.example.test:3478" });
  const warming = await restored.iceConfiguration();
  assert.equal(warming.relayStatus, "pending");
  assert.equal(warming.iceServers.some(server => String(server.urls).startsWith("turn:")), false);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/turn/credential")).length, 1, "a warming credential must not trigger duplicate provisioning");

  FakeDate.clock += 120_001;
  const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
  const member = { id: "member-id", ws };
  restored.rooms.set("ROOMCODE", { members: new Map([[member.id, member]]) });
  await restored.onMessage(ws, { ip: "test-ip", roomCode: "ROOMCODE", member }, JSON.stringify({ type: "ice-refresh" }));
  const response = ws.sent.at(-1);
  assert.equal(response.type, "ice-servers");
  assert.equal(response.relayStatus, "ready");
  assert.ok(response.iceExpiresAt > FakeDate.clock);
  assert.ok(response.iceServers.some(server => String(server.urls).startsWith("turn:")));
  assert.ok(calls.some(call => call.url.pathname.endsWith("/turn/credentials") && call.url.searchParams.get("apiKey") === "credential-scoped-key"));
});

test("provider outages disable relay while preserving clear service state", async () => {
  const { RoomCoordinator } = loadWorker(async () => { throw new Error("provider offline"); });
  const service = new RoomCoordinator({ waitUntil() {} }, { METERED_APP: "test-app", METERED_SECRET_KEY: "private-test-key" });
  await service.createTurnCredential();
  assert.equal(service.turnError, "unavailable");
  assert.equal((await service.iceConfiguration()).relayStatus, "unavailable");
});

test("confirmed provider quota exhaustion is distinguished from other outages", async () => {
  const { RoomCoordinator } = loadWorker(async () => new Response("Monthly TURN quota exceeded", { status: 402 }));
  const service = new RoomCoordinator({ waitUntil() {} }, { METERED_APP: "test-app", METERED_SECRET_KEY: "private-test-key" });
  await service.createTurnCredential();
  assert.equal(service.turnError, "quota");
  assert.equal((await service.iceConfiguration()).relayStatus, "quota");
});
