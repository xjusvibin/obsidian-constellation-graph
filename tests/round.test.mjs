import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ stdin: { contents: 'export * from "./src/round";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const r = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("only sensible rounds are accepted", () => {
  assert.ok(r.validRound({ mode: "kills", n: 5, secs: 0 }) && r.validRound({ mode: "time", n: 0, secs: 180 }));
  assert.equal(r.validRound({ mode: "kills", n: 1, secs: 0 }), false);
  assert.equal(r.validRound({ mode: "kills", n: 5000, secs: 0 }), false);
  assert.equal(r.validRound({ mode: "time", n: 0, secs: 5 }), false);
  assert.equal(r.validRound({ mode: "time", n: 0, secs: 99999 }), false);
  assert.equal(r.validRound({ mode: "free", n: 0, secs: 0 }), false);
  assert.equal(r.validRound(null), false);
  for (const p of r.ROUND_PRESETS) if (p.round) assert.ok(r.validRound(p.round), p.key);
});

test("the winner has the most kills, then the fewest deaths, and equals draw", () => {
  const t = [{ id: "a", kills: 4, deaths: 2 }, { id: "b", kills: 4, deaths: 1 }, { id: "c", kills: 1, deaths: 0 }];
  assert.deepEqual(r.roundWinners(t), ["b"]);
  assert.deepEqual(r.roundWinners([{ id: "a", kills: 2, deaths: 2 }, { id: "b", kills: 2, deaths: 2 }]).sort(), ["a", "b"]);
  assert.deepEqual(r.roundWinners([]), []);
});

test("a first-to-N round is won when someone reaches N", () => {
  const round = { mode: "kills", n: 5, secs: 0 };
  assert.equal(r.reachedTarget(round, [{ id: "a", kills: 4, deaths: 0 }]), false);
  assert.equal(r.reachedTarget(round, [{ id: "a", kills: 5, deaths: 0 }]), true);
  assert.equal(r.reachedTarget({ mode: "time", n: 0, secs: 60 }, [{ id: "a", kills: 99, deaths: 0 }]), false);
});

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
test("a sync from the host is checked: round, time left and scores", () => {
  assert.ok(r.validSync({ round: { mode: "time", n: 0, secs: 180 }, left: 95.5, scores: [{ id: A, k: 3, d: 1 }, { id: B, k: 0, d: 2 }] }));
  assert.ok(r.validSync({ round: null, left: 0, scores: [] }));
  assert.equal(r.validSync({ round: { mode: "kills", n: 1, secs: 0 }, left: 0, scores: [] }), false);
  assert.equal(r.validSync({ round: null, left: -1, scores: [] }), false);
  assert.equal(r.validSync({ round: null, left: 0, scores: [{ id: "x", k: 1, d: 1 }] }), false);
  assert.equal(r.validSync({ round: null, left: 0, scores: [{ id: A, k: 5000, d: 1 }] }), false);
  assert.equal(r.validSync({ round: null, left: 0, scores: Array(5).fill({ id: A, k: 1, d: 1 }) }), false);
  assert.equal(r.validSync(null), false);
});
