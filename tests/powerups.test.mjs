import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  stdin: { contents: 'export * from "./src/powerups";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
});
const p = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("the same room code gives every computer the same pickups", () => {
  const a = p.pickupLayout("ABCDEFGHJK", [0, 0, 0], 750), b = p.pickupLayout("ABCDEFGHJK", [0, 0, 0], 750);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, p.pickupLayout("KJHGFEDCBA", [0, 0, 0], 750));
  assert.equal(a.length, p.PICKUP_COUNT);
  assert.ok(a.filter(x => x.kind === 0).length >= 2, "at least two missiles");
  assert.ok(a.some(x => x.kind === 1) && a.some(x => x.kind === 2), "and a shield cell and an overdrive");
  for (const k of a) assert.ok(Math.hypot(k.x, k.z) > 500 && Math.hypot(k.x, k.z) < 1000, "on a ring around the middle");
});

test("a meteor burst is fixed by its seed and where each meteor is at any moment", () => {
  const f1 = p.meteorField(12345, [10, 20, 30], 8, 12), f2 = p.meteorField(12345, [10, 20, 30], 8, 12);
  assert.deepEqual(f1, f2);
  assert.notDeepEqual(f1, p.meteorField(12346, [10, 20, 30], 8, 12));
  const out = { x: 0, y: 0, z: 0 }, out2 = { x: 0, y: 0, z: 0 };
  p.meteorAt(f1[0], 5, out); p.meteorAt(f2[0], 5, out2);
  assert.deepEqual(out, out2);
  const d0 = Math.hypot(f1[0].x - 10, f1[0].y - 20, f1[0].z - 30), d5 = Math.hypot(out.x - 10, out.y - 20, out.z - 30);
  assert.ok(d5 > d0 + 100, "meteors fly outward");
});

test("a burst is capped, and bigger groups throw more", () => {
  assert.equal(p.meteorCount(1), 8);
  assert.equal(p.meteorCount(15), p.METEOR_PER_BURST_MAX);
  assert.ok(p.meteorCount(7) > 8 && p.meteorCount(7) < p.METEOR_PER_BURST_MAX);
});

test("a missile does most damage up close, half at the edge of its fuse, none beyond", () => {
  assert.equal(p.missileDamage(0), p.MISSILE_DAMAGE);
  assert.equal(p.missileDamage(p.MISSILE_FUSE), p.MISSILE_DAMAGE / 2);
  assert.equal(p.missileDamage(p.MISSILE_FUSE + 0.1), 0);
});

test("messages from other pilots are checked", () => {
  assert.ok(p.validMissile({ id: "m1", o: [0, 0, 0], d: [0, 0, 1], s: 100 }));
  assert.equal(p.validMissile({ id: "", o: [0, 0, 0], d: [0, 0, 1], s: 100 }), false);
  assert.equal(p.validMissile({ id: "m", o: [0, 0, 0], d: [0, 0, 9], s: 100 }), false);
  assert.equal(p.validMissile({ id: "m", o: [0, 0, 0], d: [0, 0, 1], s: -5 }), false);
  assert.ok(p.validMissile({ id: "m", o: [0, 0, 0], d: [0, 0, 1], s: 5, tg: "pilot-b" }));
  assert.equal(p.validMissile({ id: "m", o: [0, 0, 0], d: [0, 0, 1], s: 5, tg: "" }), false);
  assert.equal(p.validMissile({ id: "m", o: [0, 0, 0], d: [0, 0, 1], s: 5, tg: 42 }), false);
  const burst = { g: 2, seed: 99, c: [1, 2, 3], r: 6, col: "#ffb347", by: "abc" };
  assert.ok(p.validBurst(burst) && p.validBurst({ ...burst, by: null }));
  assert.equal(p.validBurst({ ...burst, col: "red" }), false);
  assert.equal(p.validBurst({ ...burst, seed: -1 }), false);
  assert.equal(p.validBurst({ ...burst, r: 5000 }), false);
  assert.equal(p.validBurst({ ...burst, g: 1e9 }), false);
  assert.ok(p.validGrab(0) && p.validGrab(5));
  assert.equal(p.validGrab(6), false);
  assert.equal(p.validGrab("1"), false);
});
