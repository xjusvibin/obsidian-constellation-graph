import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// the browser globals the network code expects
globalThis.window = globalThis;

const built = await build({
  stdin: {
    contents: 'export * from "./src/netcrypto"; export * from "./src/room"; export * from "./src/multiplayer"; export * from "./src/relay";',
    resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
});
const net = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

// ---------------------------------------------------------------- crypto
test("room codes are clean, parse in any style, and are not guessable by accident", () => {
  const code = net.makeRoomCode();
  assert.equal(code.length, 10);
  assert.ok([...code].every(c => net.CODE_CHARS.includes(c)));
  assert.equal(net.parseRoomCode(net.formatRoomCode(code).toLowerCase()), code);
  assert.equal(net.parseRoomCode(" " + code.slice(0, 5) + "  " + code.slice(5) + " "), code);
  assert.equal(net.parseRoomCode("short"), null);
  assert.equal(net.parseRoomCode("0O1I0O1I0O"), null); // letters left out on purpose
  assert.notEqual(net.makeRoomCode(), net.makeRoomCode());
});

test("sealed messages round-trip, and only with the right code", async () => {
  const a = await net.deriveRoomKeys("ABCDEFGHJK"), same = await net.deriveRoomKeys("ABCDEFGHJK"), other = await net.deriveRoomKeys("KJHGFEDCBA");
  assert.equal(a.topic, same.topic);
  assert.notEqual(a.topic, other.topic);
  const msg = { v: 1, k: "hello", name: "Orion", big: "x".repeat(3000) };
  const text = await net.seal(a, msg);
  assert.ok(text.length < 1500, "a repetitive message should be compressed");
  assert.deepEqual(await net.unseal(same, text), msg);
  assert.equal(await net.unseal(other, text), null);
  assert.equal(text.includes("Orion"), false);
});

test("a changed, short or junk message is refused", async () => {
  const k = await net.deriveRoomKeys("ABCDEFGHJK");
  const text = await net.seal(k, { v: 1, k: "hello" });
  const flipped = text.slice(0, 20) + (text[20] === "A" ? "B" : "A") + text.slice(21);
  assert.equal(await net.unseal(k, flipped), null);
  assert.equal(await net.unseal(k, "abc"), null);
  assert.equal(await net.unseal(k, "not base64 !!!"), null);
  assert.equal(await net.unseal(k, ""), null);
});

test("relay addresses must be https, or http on this computer only", () => {
  assert.equal(net.cleanRelayUrl(""), "https://ntfy.sh");
  assert.equal(net.cleanRelayUrl("https://relay.example.org/"), "https://relay.example.org");
  assert.equal(net.cleanRelayUrl("http://localhost:8788"), "http://localhost:8788");
  assert.equal(net.cleanRelayUrl("http://relay.example.org"), null);
  assert.equal(net.cleanRelayUrl("https://user:pw@relay.example.org"), null);
  assert.equal(net.cleanRelayUrl("javascript:alert(1)"), null);
  assert.equal(net.cleanRelayUrl("not a url"), null);
});

// ---------------------------------------------------------------- rooms over a fake relay
function fakeRelay() {
  const subs = new Map(), log = [];
  const factory = (topic, onText) => {
    let live = false; const me = { onText: t => live && onText(t) };
    return {
      publish: async text => { log.push(text); for (const s of subs.get(topic) ?? []) queueMicrotask(() => s.onText(text)); },
      start: () => { live = true; if (!subs.has(topic)) subs.set(topic, new Set()); subs.get(topic).add(me); },
      stop: () => { live = false; subs.get(topic)?.delete(me); },
    };
  };
  return { factory, log };
}
function pilot(relay, name) {
  const events = { rosters: [], signals: [], status: [] };
  const room = new net.RelayRoom("https://relay.test", {
    roster: (members, selfId) => events.rosters.push({ members, selfId }),
    signal: (from, data) => events.signals.push({ from, data }),
    status: (t, e) => events.status.push({ t, e }),
  }, relay.factory);
  return { room, events, name };
}
const settle = () => new Promise(r => setTimeout(r, 30));

test("a room fills up to four pilots, each with their own place", async () => {
  const relay = fakeRelay(), host = pilot(relay, "Host");
  const code = await host.room.create("Host");
  const guests = [pilot(relay, "B"), pilot(relay, "C"), pilot(relay, "D")];
  for (const g of guests) { await g.room.join(code, g.name); }
  await settle();
  const slots = host.room.members.map(m => m.slot).sort();
  assert.deepEqual(slots, [0, 1, 2, 3]);
  for (const g of guests) assert.equal(g.room.members.length, 4);
  const fifth = pilot(relay, "E");
  await assert.rejects(fifth.room.join(code, "E"), /four pilots/);
});

test("the relay never sees names, the code or a note title", async () => {
  const relay = fakeRelay(), host = pilot(relay, "SecretHostName");
  const code = await host.room.create("SecretHostName");
  const guest = pilot(relay, "SecretGuestName");
  await guest.room.join(code, "SecretGuestName");
  guest.room.signal(guest.room.members.find(m => m.id !== guest.room.selfId).id, { description: { type: "offer", sdp: "v=0 PRIVATE_SDP" } });
  await settle();
  const all = relay.log.join(" ");
  for (const secret of ["SecretHostName", "SecretGuestName", code, "PRIVATE_SDP", "hello", "roster"]) assert.equal(all.includes(secret), false, `${secret} leaked`);
  assert.ok(relay.log.length >= 3);
});

test("connection messages reach only the pilot they are for", async () => {
  const relay = fakeRelay(), a = pilot(relay, "A");
  const code = await a.room.create("A");
  const b = pilot(relay, "B"), c = pilot(relay, "C");
  await b.room.join(code, "B"); await c.room.join(code, "C"); await settle();
  b.room.signal(c.room.selfId, { description: { type: "offer", sdp: "x" } });
  await settle();
  assert.equal(c.events.signals.length, 1);
  assert.equal(c.events.signals[0].from, b.room.selfId);
  assert.equal(a.events.signals.length, 0);
});

test("someone with the wrong code cannot join or listen", async () => {
  const relay = fakeRelay(), a = pilot(relay, "A");
  await a.room.create("A");
  const intruder = pilot(relay, "X");
  const wrong = net.makeRoomCode();
  // the wrong code is a different room: nobody there answers (the join waits for a reply, so we do not wait it out)
  const attempt = intruder.room.join(wrong, "X").catch(() => "gave up");
  await settle();
  assert.equal(a.room.members.length, 1);
  intruder.room.leave();
  assert.equal(await attempt, "gave up");
});

test("names are cleaned before anyone sees them", () => {
  assert.equal(net.cleanName("  <b>Hax</b>  "), "bHaxb");
  assert.equal(net.cleanName(""), "Pilot");
  assert.equal(net.cleanName("x".repeat(60)).length, 24);
  assert.equal(net.cleanName(42), "Pilot");
});

// ---------------------------------------------------------------- what is shared, and what a remote pilot can send
const PRIVATE = ["PRIVATE_TITLE_CobaltVault", "PRIVATE_PATH_Secrets/Bluebird.md", "PRIVATE_TAG_Clinical", "PRIVATE_BODY_needle"];
function graphFixture() {
  return {
    groups: [{ key: PRIVATE[2], label: PRIVATE[2], color: "#2468ac", count: 2 }],
    nodes: [
      { id: PRIVATE[1], name: PRIVATE[0], tags: [PRIVATE[2]], body: PRIVATE[3], group: PRIVATE[2], deg: 1 },
      { id: "another/LocalOnly.md", name: "Another private title", group: PRIVATE[2], deg: 1 },
    ],
    links: [{ source: PRIVATE[1], target: "another/LocalOnly.md", privateLabel: "never sent" }],
  };
}
const simNodes = [{ x: 1, y: 2, z: 3 }, { x: -4, y: 5, z: 6 }];

test("what is shared about your constellation contains no note names, paths, tags or text", () => {
  const topology = net.makeAnonymousTopology(graphFixture(), new Map(), 1);
  const wire = JSON.stringify(topology) + Buffer.from(net.encodePositions(simNodes, topology, 1)).toString("latin1");
  for (const secret of [...PRIVATE, "Another private title", "another/LocalOnly.md", "never sent"]) assert.equal(wire.includes(secret), false, `${secret} leaked`);
  assert.equal(topology.nodes.length, 2);
  assert.equal(topology.links.length, 1);
  assert.ok(net.validTopology(topology));
});

test("position frames survive a round trip, and damaged ones are refused", () => {
  const topology = net.makeAnonymousTopology(graphFixture(), new Map(), 3);
  const frame = net.encodePositions(simNodes, topology, 7);
  const out = net.decodePositions(frame, topology);
  assert.equal(out.sequence, 7);
  assert.deepEqual([...out.positions], [1, 2, 3, -4, 5, 6]);
  assert.equal(net.decodePositions(frame.slice(0, frame.byteLength - 4), topology), null);
  assert.equal(net.decodePositions(frame, { ...topology, revision: 4 }), null);
  const bad = frame.slice(0); new DataView(bad).setFloat32(16, NaN, true);
  assert.equal(net.decodePositions(bad, topology), null);
  assert.throws(() => net.encodePositions([{ x: 2e6, y: 0, z: 0 }, simNodes[1]], topology, 1), /coordinate limit/);
});

test("everything a remote pilot can send is checked", () => {
  const pose = { p: [0, 0, 0], q: [0, 0, 0, 1], v: [1, 2, 3], hp: 100, en: 1, bo: false, ac: true, pr: false };
  assert.ok(net.validPose(pose));
  for (const bad of [{ ...pose, hp: 101 }, { ...pose, p: [0, 0, NaN] }, { ...pose, q: [0, 0, 0, 0] }, { ...pose, v: [1e9, 0, 0] }, { ...pose, ac: "yes" }, null, "x", { ...pose, en: -1 }])
    assert.equal(net.validPose(bad), false);
  assert.ok(net.validShot({ id: "s1", o: [1, 2, 3], d: [0, 0, -1] }));
  assert.equal(net.validShot({ id: "s1", o: [1, 2, 3], d: [0, 0, -5] }), false);
  assert.equal(net.validShot({ id: "x".repeat(100), o: [0, 0, 0], d: [0, 0, 1] }), false);
  assert.ok(net.validShot({ id: "s2", o: [0, 0, 0], d: [0, 0, 1], w: 1 }));
  assert.equal(net.validShot({ id: "s3", o: [0, 0, 0], d: [0, 0, 1], w: 7 }), false);
  assert.ok(net.validPose({ ...pose, sh: 2 }));
  assert.equal(net.validPose({ ...pose, sh: 9 }), false);
  assert.ok(net.validHit({ shooter: "me", target: "you", shotId: "s", at: [0, 0, 0] }, "me"));
  assert.equal(net.validHit({ shooter: "someone-else", target: "you", shotId: "s", at: [0, 0, 0] }, "me"), false); // you cannot claim a hit on behalf of another shooter
  const topology = net.makeAnonymousTopology(graphFixture(), new Map(), 1);
  assert.equal(net.validTopology({ ...topology, nodes: [{ ...topology.nodes[0], id: "../../etc/passwd" }] }), false);
  assert.equal(net.validTopology({ ...topology, links: [[topology.nodes[0].id, "n-00000000-0000-0000-0000-000000000000"]] }), false);
  assert.equal(net.validTopology({ ...topology, groups: [{ color: "red", count: 1 }] }), false);
});

test("a vault that is too large to share is refused with a clear message", () => {
  const nodes = Array.from({ length: net.MAX_SHARED_NODES + 1 }, (_, i) => ({ id: "n" + i, name: "t", group: "g", deg: 0 }));
  assert.throws(() => net.makeAnonymousTopology({ groups: [{ key: "g", label: "g", color: "#000000", count: nodes.length }], nodes, links: [] }, new Map(), 1), /supports up to/);
});

test("an invite link carries only the room code, and the code comes back out of it", () => {
  const code = net.makeRoomCode(), link = net.inviteLink(code);
  assert.ok(link.startsWith("obsidian://starfield-join?code="));
  assert.equal(net.parseRoomCode(new URL(link).searchParams.get("code")), code);
  assert.equal(link.includes("relay"), false);
  assert.equal(net.parseRoomCode(new URL("obsidian://starfield-join?code=nonsense").searchParams.get("code")), null);
});
