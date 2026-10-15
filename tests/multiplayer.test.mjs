import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["src/multiplayer.ts", "src/combat.ts", "src/sim.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "test-bundles",
  entryNames: "[name]",
  write: false,
});
async function loadBundle(name) {
  const file = built.outputFiles.find(f => basename(f.path) === `${name}.js`);
  assert.ok(file, `missing ${name} bundle`);
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}
const network = await loadBundle("multiplayer");
const combat = await loadBundle("combat");
const sim = await loadBundle("sim");

const privateMarkers = ["PRIVATE_TITLE_CobaltVault", "PRIVATE_PATH_Secrets/Bluebird.md", "PRIVATE_TAG_Clinical", "PRIVATE_BODY_needle" ];
function fixture() {
  return {
    groups: [{ key: privateMarkers[2], label: privateMarkers[2], color: "#2468ac", count: 2 }],
    nodes: [
      { id: privateMarkers[1], name: privateMarkers[0], tags: [privateMarkers[2]], body: privateMarkers[3], group: privateMarkers[2], deg: 1 },
      { id: "another/LocalOnly.md", name: "Another private title", group: privateMarkers[2], deg: 1 },
    ],
    links: [{ source: privateMarkers[1], target: "another/LocalOnly.md", privateLabel: "never sent" }],
  };
}
function callbacks(overrides = {}) {
  return {
    status() {}, members() {}, topology() {}, positions() {}, message() {}, removed() {}, authority() {}, playerState() {}, shotState() {},
    ...overrides,
  };
}
function peerStub(topology = undefined) {
  return {
    pc: {}, signalChain: Promise.resolve(), pendingCandidates: [], topology, positionSequence: 0, lastPositionSequence: 0, topologySend: null, topologyReceive: null,
    positionReceive: new Map(),
    control: { readyState: "open", bufferedAmount: 0, sent: [], send(message) { this.sent.push(message); } },
    live: { readyState: "open", bufferedAmount: 0, sent: [], send(message) { this.sent.push(message); } },
  };
}

test("anonymous topology and all application packets omit local vault metadata", () => {
  const ids = new Map();
  const topology = network.makeAnonymousTopology(fixture(), ids, 1);
  const text = JSON.stringify(topology);
  for (const marker of privateMarkers) assert.equal(text.includes(marker), false);
  assert.equal(topology.nodes.length, 2);
  assert.deepEqual(topology.links, [[topology.nodes[0].id, topology.nodes[1].id]]);
  assert.match(topology.nodes[0].id, /^n-[0-9a-f-]{36}$/i);

  const sent = [];
  const session = new network.MultiplayerSession(callbacks(), () => ({ data: fixture(), nodes: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] }), () => "ws://localhost:8787");
  const self = "11111111-1111-4111-8111-111111111111", peerId = "22222222-2222-4222-8222-222222222222";
  session.selfId = self; session.hostId = peerId; session.epoch = 4;
  session.roster = [{ id: self, name: "Host" }, { id: peerId, name: "Remote" }];
  const peer = peerStub(); session.peers.set(peerId, peer);
  session.setLocalGraph(fixture());
  session.pumpTopologies();
  session.sendPositionsTo(peerId);
  session.sendInput({ thrust: 1, strafe: 0, lift: 0, roll: 0, pitch: 0, yaw: 0, boost: false, brake: false, fire: false, active: true });
  session.fire(1, 2, [10, 20, 30]);
  session.requestFastTravel({ ownerId: session.selfId, starId: session.localTopology.nodes[0].id, revision: session.localTopology.revision });
  sent.push(...peer.control.sent, ...peer.live.sent.map(v => v instanceof ArrayBuffer ? Buffer.from(v).toString("base64") : v));
  for (const marker of privateMarkers) assert.equal(JSON.stringify(sent).includes(marker), false);
});

test("topology limits reject rather than truncate oversized maps", () => {
  const node = { id: "local", group: "folder", deg: 0 };
  assert.throws(() => network.makeAnonymousTopology({ groups: [], nodes: Array(network.MAX_SHARED_NODES + 1).fill(node), links: [] }, new Map(), 1), /supports up to/);
  assert.throws(() => network.makeAnonymousTopology({ groups: [], nodes: [node], links: Array(network.MAX_SHARED_LINKS + 1).fill({ source: "local", target: "local" }) }, new Map(), 1), /supports up to/);
});

test("topology revisions and position snapshots reject stale or malformed traffic", () => {
  const accepted = [], positions = [];
  const session = new network.MultiplayerSession(callbacks({ topology: (_id, value) => accepted.push(value.revision), positions: (_id, value) => positions.push([...value]) }), () => ({ data: fixture(), nodes: [] }), () => "ws://localhost:8787");
  const topology = network.makeAnonymousTopology(fixture(), new Map(), 1);
  const peer = peerStub(); session.peers.set("owner", peer);
  const sendTopology = value => session.onPeerMessage("owner", JSON.stringify({ type: "topology-chunk", revision: value.revision, index: 0, total: 1, data: JSON.stringify(value) }), "control");
  sendTopology({ ...topology, revision: 2 });
  sendTopology(topology);
  session.onPeerMessage("owner", JSON.stringify({ type: "topology-chunk", revision: 3, index: 0, total: 1, data: "{broken" }), "control");
  assert.deepEqual(accepted, [2]);

  const nodes = [{ x: 10, y: 20, z: 30 }, { x: -4, y: 5, z: 6 }];
  const frames = network.encodePositionChunks(nodes, { ...topology, revision: 2 }, 8);
  for (const frame of [...frames].reverse()) session.onPeerMessage("owner", frame, "live");
  for (const frame of network.encodePositionChunks(nodes, { ...topology, revision: 2 }, 7)) session.onPeerMessage("owner", frame, "live");
  const wrongRevision = network.encodePositionChunks(nodes, { ...topology, revision: 1 }, 9)[0];
  session.onPeerMessage("owner", wrongRevision, "live");
  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], [10, 20, 30, -4, 5, 6]);
  session.onPeerMessage("owner", JSON.stringify({ type: "open", path: privateMarkers[1] }), "live");
  assert.deepEqual(accepted, [2]);
});

test("host accepts only current-epoch anonymous navigation and bounded authoritative fire requests", () => {
  const selfId = "11111111-1111-4111-8111-111111111111", guestId = "22222222-2222-4222-8222-222222222222";
  const graphNodes = [{ x: 0, y: 0, z: -500, deg: 1 }, { x: 10, y: 0, z: -520, deg: 2 }];
  const session = new network.MultiplayerSession(callbacks(), () => ({ data: fixture(), nodes: graphNodes }), () => "ws://localhost:8787");
  session.selfId = session.hostId = selfId; session.epoch = 3;
  session.roster = [{ id: selfId, name: "Host" }, { id: guestId, name: "Guest" }];
  const peer = peerStub(); session.peers.set(guestId, peer);
  session.setLocalGraph(fixture());
  session.world = new combat.CombatWorld(3);
  session.world.add({ id: guestId, slot: 1, name: "Guest", joinedAt: 2 });
  session.world.players.get(guestId).active = true;

  const target = { ownerId: selfId, starId: session.localTopology.nodes[0].id, revision: session.localTopology.revision };
  session.onPeerMessage(guestId, JSON.stringify({ type: "navigate", epoch: 2, target }), "control");
  assert.equal(session.world.players.get(guestId).travel, null, "stale epochs cannot start travel");
  session.onPeerMessage(guestId, JSON.stringify({ type: "navigate", epoch: 3, target: { ...target, revision: target.revision + 1 } }), "control");
  assert.equal(session.world.players.get(guestId).travel, null, "stale topology revisions cannot start travel");
  session.onPeerMessage(guestId, JSON.stringify({ type: "navigate", epoch: 3, target }), "control");
  assert.ok(session.world.players.get(guestId).travel);

  session.onPeerMessage(guestId, JSON.stringify({ type: "fire", epoch: 2, sequence: 1, gun: 0, aimPoint: [2300, 0, -900] }), "control");
  session.onPeerMessage(guestId, JSON.stringify({ type: "fire", epoch: 3, sequence: 1, gun: 0, aimPoint: [2300, 0, 900] }), "control");
  assert.equal(session.world.shotSnapshots().length, 0, "stale and backward shots are rejected");
  session.onPeerMessage(guestId, JSON.stringify({ type: "fire", epoch: 3, sequence: 1, gun: 2, aimPoint: [2300, 0, -900] }), "control");
  assert.equal(session.world.shotSnapshots()[0]?.gun, 2);
  assert.equal(session.world.players.get(guestId).travel, null, "an accepted shot cancels travel");
  session.onPeerMessage(guestId, JSON.stringify({ type: "open", path: privateMarkers[1] }), "control");
  assert.equal(session.world.shotSnapshots().length, 1, "remote note-opening requests are ignored");
});

test("multiplayer map coordinates double around their stable region and restore exactly in solo", () => {
  for (const [origin, solo] of [[0, [12, -8, 30]], [2300, [2312, -8, 30]], [-1150, [-1138, -8, 30]]]) {
    const scaled = solo.map(value => sim.mapCoordinate(value, origin, 2));
    assert.deepEqual(scaled, solo.map(value => origin + (value - origin) * 2));
    assert.equal(scaled[0] - origin, (solo[0] - origin) * 2);
    assert.deepEqual(solo.map(value => sim.mapCoordinate(value, origin, 1)), solo);
  }
});

const emptyInput = { thrust: 0, strafe: 0, lift: 0, roll: 0, pitch: 0, yaw: 0, boost: false, brake: false, fire: false, active: false };
function addPair(world) {
  world.add({ id: "attacker", slot: 0, name: "A", joinedAt: 1 });
  world.add({ id: "target", slot: 1, name: "B", joinedAt: 2 });
  const attacker = world.players.get("attacker"), target = world.players.get("target");
  attacker.pos.set(0, 0, 0); attacker.rot.identity(); attacker.active = true;
  target.pos.set(0, 0, -100); target.rot.identity(); target.active = true;
  attacker.input = { ...emptyInput, active: true }; target.input = { ...emptyInput, active: true };
  return { attacker, target };
}

test("host projectiles sweep travel, deal one ten-point hit, and checkpoint in-flight state", () => {
  const world = new combat.CombatWorld(4), { attacker, target } = addPair(world);
  assert.equal(world.fireShot("attacker", 1, 0, 10_000), true);
  world.step(1 / 60, 10_000);
  for (let i = 0; i < 5; i++) world.step(1 / 60, 10_017 + i * 17);
  assert.equal(target.health, 90);
  assert.equal(world.impactSnapshots(10_100).at(-1)?.kind, "ship");

  assert.equal(world.fireShot("attacker", 2, 3, 10_200), true);
  world.step(1 / 60, 10_200);
  const checkpoint = world.snapshot(10_200);
  assert.ok(checkpoint.shots.length > 0);
  assert.equal(checkpoint.shots[0].gun, 3);
  assert.deepEqual(checkpoint.shots[0].origin, world.shotSnapshots()[0].origin);
  const resumed = new combat.CombatWorld(5);
  assert.equal(resumed.restore(checkpoint, 99_000_250), true, "checkpoint timers are relative and survive clock skew between participants");
  assert.equal(resumed.shotSnapshots().length, checkpoint.shots.length);
  assert.equal(resumed.epoch, 4);
  assert.equal(resumed.restore({ ...checkpoint, players: [null] }, 10_250), false);
});

test("authoritative shots originate at cannon muzzles and converge to a validated aim point", () => {
  const world = new combat.CombatWorld(1), { attacker } = addPair(world);
  const muzzle = [1.61 * 0.68, 0.51 * 0.68, -0.97 * 0.68];
  const aimPoint = [120, 40, -900];
  assert.equal(world.fireShot("attacker", 1, 3, 1000, aimPoint), true);
  const shot = world.shotSnapshots()[0];
  assert.deepEqual(shot.origin, muzzle);
  const expected = [aimPoint[0] - muzzle[0], aimPoint[1] - muzzle[1], aimPoint[2] - muzzle[2]];
  const length = Math.hypot(...expected);
  assert.ok(Math.abs(shot.direction[0] - expected[0] / length) < 1e-12);
  assert.ok(Math.abs(shot.direction[1] - expected[1] / length) < 1e-12);
  assert.ok(Math.abs(shot.direction[2] - expected[2] / length) < 1e-12);
  assert.equal(world.fireShot("attacker", 2, 0, 1200, [0, 0, 100]), false, "shots behind the ship are rejected");
  assert.equal(world.fireShot("attacker", 3, 0, 1400, [0, 0, -5000]), false, "unbounded shots are rejected");
});

test("travel is checkpointed and movement cancels it without refilling resources", () => {
  const world = new combat.CombatWorld(7), { attacker } = addPair(world);
  attacker.energy = 0.42;
  assert.equal(world.startTravel("attacker", [0, 0, -500], 2, 1000), true);
  world.step(1 / 60, 1500);
  const checkpoint = world.snapshot(1500);
  assert.ok(checkpoint.players[0].travel);
  const resumed = new combat.CombatWorld(8);
  assert.equal(resumed.restore(checkpoint, 9000), true);
  assert.ok(resumed.players.get("attacker").travel);
  assert.equal(resumed.players.get("attacker").energy, 0.42);
  resumed.setInput("attacker", { ...emptyInput, active: true, thrust: 1 }, 9040);
  assert.equal(resumed.players.get("attacker").travel, null);
  assert.equal(resumed.players.get("attacker").energy, 0.42);
});

test("projectile hits on stars are visuals only and spawn protection holds", () => {
  const world = new combat.CombatWorld(1), { attacker, target } = addPair(world);
  target.protectedUntil = 30_000;
  world.setObstacleSet("remote-vault", new Float32Array([0, 0, -45]));
  assert.equal(world.fireShot("attacker", 1, 0, 20_000), true);
  world.step(1 / 60, 20_000);
  for (let i = 0; i < 4; i++) world.step(1 / 60, 20_017 + i * 17);
  assert.equal(target.health, 100);
  assert.equal(world.impactSnapshots(20_100).at(-1)?.kind, "star");
});

test("lethal damage respawns at five seconds with full health, boost, and three-second protection", () => {
  const world = new combat.CombatWorld(1), { attacker, target } = addPair(world);
  target.health = 10;
  assert.equal(world.fireShot("attacker", 1, 0, 30_000), true);
  world.step(1 / 60, 30_000);
  target.input = { ...emptyInput, active: true };
  for (let i = 1; i <= 6 && target.health > 0; i++) world.step(1 / 60, 30_000 + i * 17);
  assert.equal(target.health, 0);
  const respawnAt = target.respawnAt;
  assert.ok(respawnAt > 30_000 && target.active === false);
  world.step(1 / 60, respawnAt - 1);
  assert.equal(target.health, 0);
  world.step(1 / 60, respawnAt);
  assert.equal(target.health, 100);
  assert.equal(target.energy, 1);
  assert.equal(target.active, true);
  assert.equal(target.protectedUntil, respawnAt + 3000);
});

test("boost drains at the shared rate and spectators resume after five seconds without refilling", () => {
  const world = new combat.CombatWorld(1);
  world.add({ id: "pilot", slot: 0, name: "P", joinedAt: 1 });
  const pilot = world.players.get("pilot");
  pilot.input = { ...emptyInput, active: true, thrust: 1, boost: true };
  for (let i = 0; i < 10; i++) world.step(0.1, 1000 + i * 100);
  assert.ok(Math.abs(pilot.energy - 0.72) < 1e-8);
  pilot.input = { ...pilot.input, boost: false };
  pilot.active = true;
  world.step(0.1, 2100);
  assert.ok(Math.abs(pilot.energy - 0.72) < 1e-8);
  for (let i = 0; i < 14; i++) world.step(0.1, 2200 + i * 100);
  assert.ok(pilot.energy > 0.72);

  pilot.health = 70; pilot.energy = 0.42; pilot.active = true; pilot.input = { ...emptyInput, active: false };
  world.step(0.01, 5000);
  pilot.input = { ...emptyInput, active: true };
  world.step(0.01, 6000);
  assert.equal(pilot.active, false);
  assert.equal(pilot.health, 70); assert.equal(pilot.energy, 0.42);
  world.step(0.01, 9999); assert.equal(pilot.active, false);
  world.step(0.01, 10000); assert.equal(pilot.active, true);
  assert.equal(pilot.health, 70); assert.ok(pilot.energy > 0.42 && pilot.energy < 0.421);
});

test("rapid boost taps reset the delay and an empty tank stays locked until thirty percent", () => {
  const world = new combat.CombatWorld(1);
  world.add({ id: "pilot", slot: 0, name: "P", joinedAt: 1 });
  const pilot = world.players.get("pilot"); pilot.active = true; pilot.energy = 0.5;
  pilot.input = { ...emptyInput, active: true, thrust: 1, boost: true };
  world.step(0.1, 1000); assert.ok(Math.abs(pilot.energy - 0.472) < 1e-8);
  pilot.input = { ...pilot.input, boost: false };
  for (let i = 0; i < 10; i++) world.step(0.1, 1100 + i * 100);
  assert.ok(Math.abs(pilot.energy - 0.472) < 1e-8);
  pilot.input = { ...pilot.input, boost: true };
  world.step(0.1, 2100);
  assert.ok(Math.abs(pilot.energy - 0.444) < 1e-8);
  pilot.input = { ...pilot.input, boost: false };
  for (let i = 0; i < 10; i++) world.step(0.1, 2200 + i * 100);
  assert.ok(Math.abs(pilot.energy - 0.444) < 1e-8, "the second tap should restart the 1.5 second delay");

  pilot.energy = 0.01; pilot.boostLocked = false; pilot.input = { ...emptyInput, active: true, thrust: 1, boost: true };
  world.step(0.1, 5000);
  assert.equal(pilot.energy, 0); assert.equal(pilot.boostLocked, true);
  pilot.input = { ...pilot.input, boost: false };
  for (let i = 0; i < 29; i++) world.step(0.1, 5100 + i * 100);
  assert.equal(pilot.energy, 0); assert.equal(pilot.boostLocked, true);
  for (let i = 0; i < 35; i++) world.step(0.1, 8100 + i * 100);
  assert.ok(pilot.energy >= 0.27 && pilot.energy < 0.3);
  assert.equal(pilot.boostLocked, true);
  pilot.input = { ...pilot.input, boost: true };
  world.step(0.1, 11600); assert.ok(pilot.energy < 0.3 && pilot.boostLocked);
  world.step(0.1, 11700); assert.ok(pilot.energy < 0.3 && pilot.boostLocked);
  world.step(0.1, 11800); assert.ok(pilot.energy >= 0.3);
  assert.equal(pilot.boostLocked, false);
  world.step(0.1, 11900);
  assert.ok(pilot.energy < 0.3 && !pilot.boostLocked, "after reaching thirty percent, boost may run the tank down again");
});

function signalingStubs(t) {
  const sockets = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    constructor() { super(); sockets.push(this); }
    send() {}
    close() { if (this.readyState !== Socket.CLOSED) this.emitClose(1000); }
    emitClose(code) { this.readyState = Socket.CLOSED; this.dispatchEvent(Object.assign(new Event("close"), { code })); }
  }
  const values = { window: globalThis, WebSocket: Socket, RTCPeerConnection: class {} };
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  return sockets;
}

test("early signaling closure rejects immediately with host and close code, and releases its socket", async t => {
  const sockets = signalingStubs(t);
  const session = new network.MultiplayerSession(callbacks(), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  const rejected = assert.rejects(session.create("Pilot"), /rooms\.example\.test.*WebSocket code 1006/);
  sockets[0].emitClose(1006);
  await rejected;
  assert.equal(session.socket, null);
  assert.equal(session.active, false);
  assert.equal(session.opening, false);
});

test("failed signaling attempts clean up for retry and ignore late events from the old socket", async t => {
  const sockets = signalingStubs(t), statuses = [];
  const session = new network.MultiplayerSession(callbacks({ status: text => statuses.push(text) }), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  const first = assert.rejects(session.join("ABCDEFGH", "Pilot"), /Could not reach.*rooms\.example\.test/);
  await assert.rejects(session.join("ABCDEFGH", "Pilot"), /already in progress/);
  assert.equal(sockets.length, 1);
  sockets[0].dispatchEvent(new Event("error"));
  await first;
  assert.equal(session.socket, null);
  const second = assert.rejects(session.join("ABCDEFGH", "Pilot"), /WebSocket code 1008/);
  assert.equal(sockets.length, 2);
  sockets[0].dispatchEvent(new MessageEvent("message", { data: "not-json" }));
  assert.equal(statuses.some(text => text.includes("invalid data")), false);
  sockets[1].emitClose(1008);
  await second;
  assert.equal(session.socket, null);
});

test("the host publishes authoritative flight state locally for every participant", () => {
  const states = [];
  const session = new network.MultiplayerSession(callbacks({ playerState: (id, pose) => states.push({ id, pose }) }), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  session.selfId = session.hostId = "host";
  session.world = new combat.CombatWorld(1);
  for (const [slot, id] of ["host", "guest"].entries()) {
    session.world.add({ id, slot, name: id, joinedAt: 1000 });
    session.world.setInput(id, { ...emptyInput, active: true }, 1000);
  }
  session.world.step(1 / 60, 1000);
  session.publishWorldState(1000);
  assert.deepEqual(states.map(({ id, pose }) => [id, pose.active]), [["host", true], ["guest", true]]);
});

test("ICE candidates arriving before or during remote description setup are retained", async () => {
  const session = new network.MultiplayerSession(callbacks(), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  session.selfId = session.hostId = "host";
  const peer = peerStub(), added = [];
  let finishDescription;
  const descriptionGate = new Promise(resolve => { finishDescription = resolve; });
  peer.pc = {
    remoteDescription: null,
    async setRemoteDescription(value) { await descriptionGate; this.remoteDescription = value; },
    async createAnswer() { return { type: "answer", sdp: "synthetic" }; },
    async setLocalDescription(value) { this.localDescription = value; },
    async addIceCandidate(value) { assert.ok(this.remoteDescription); added.push(value.candidate); },
  };
  session.peers.set("guest", peer);
  const signal = data => session.onSignal({ type: "signal", from: "guest", data });
  await signal({ candidate: { candidate: "before-offer" } });
  assert.equal(peer.pendingCandidates.length, 1);
  const description = signal({ description: { type: "offer", sdp: "synthetic" } });
  const candidate = signal({ candidate: { candidate: "during-description" } });
  finishDescription();
  await Promise.all([description, candidate]);
  assert.deepEqual(added, ["before-offer", "during-description"]);
  assert.equal(peer.pendingCandidates.length, 0);
});

test("one failed STUN endpoint is informational and cannot mark a connected peer or relay quota as failed", () => {
  const statuses = [];
  const session = new network.MultiplayerSession(callbacks({ status: (text, error) => statuses.push({ text, error }) }), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  session.selfId = session.hostId = "host";
  session.roster = [{ id: "host" }, { id: "guest" }]; session.relayStatus = "ready";
  const peer = peerStub(); peer.pc.connectionState = "connecting"; session.peers.set("guest", peer);
  session.reportIceError("guest", { errorCode: 701, url: "stun:synthetic.invalid", errorText: "STUN binding request timed out" });
  assert.match(statuses.at(-1).text, /STUN endpoint.*701/);
  assert.equal(statuses.at(-1).error, false);
  assert.equal(session.relayStatus, "ready");
  peer.pc.connectionState = "connected";
  session.updatePeerStatus();
  assert.match(statuses.at(-1).text, /1 of 1 participant connections ready/);
  assert.equal(statuses.at(-1).error, false);
  const count = statuses.length;
  session.reportIceError("guest", { errorCode: 701, url: "turn:synthetic.invalid", errorText: "quota" });
  assert.equal(statuses.length, count);
  assert.equal(session.relayStatus, "ready");
});

test("closing a removed peer's channels cannot overwrite a clean leave or departure status", () => {
  const statuses = [];
  const session = new network.MultiplayerSession(callbacks({ status: text => statuses.push(text) }), () => ({ data: fixture(), nodes: [] }), () => "wss://rooms.example.test");
  const peer = peerStub(); peer.control = undefined; peer.live = undefined; peer.pc.close = () => {};
  session.peers.set("guest", peer);
  const channel = { label: "constellation-live", readyState: "open", close() { this.onclose?.(); } };
  session.bindChannel("guest", channel);
  session.removePeer("guest");
  assert.equal(session.peers.size, 0);
  assert.deepEqual(statuses, []);
});
