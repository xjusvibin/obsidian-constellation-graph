import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: ["src/tour.ts"], bundle: true, format: "esm", write: false, platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

test("a tour never visits a note twice and follows links", () => {
  const adj = [[1, 2], [0, 2, 3], [0, 1], [1, 4], [3]];
  const t = m.planTour(adj, 0);
  assert.equal(new Set(t).size, t.length);
  for (let i = 1; i < t.length; i++) assert.ok(adj[t[i - 1]].includes(t[i]));
});
test("it prefers the better connected neighbour", () => {
  const adj = [[1, 2], [0], [0, 3, 4], [2], [2]];
  assert.deepEqual(m.planTour(adj, 0).slice(0, 2), [0, 2]);
});
test("it stops when there is nowhere new, and respects the limit", () => {
  assert.deepEqual(m.planTour([[1], [0]], 0), [0, 1]);
  const ring = Array.from({ length: 30 }, (_, i) => [(i + 1) % 30, (i + 29) % 30]);
  assert.equal(m.planTour(ring, 0, 5).length, 5);
});
test("bad starts give an empty tour", () => {
  assert.deepEqual(m.planTour([[1], [0]], 7), []);
  assert.deepEqual(m.planTour([], 0), []);
  assert.equal(m.busiestNote([[1], [0, 2], [1]]), 1);
});
