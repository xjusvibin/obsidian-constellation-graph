import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.window = globalThis;
const built = await build({ stdin: { contents: 'export * from "./src/arcade";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const a = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

const entry = (name, waves, extra = 0, at = 1) => { const kills = a.minKills(waves) + extra; return { name, waves, kills, score: a.runScore(waves, kills), at }; };

test("the score follows from waves and kills, and the minimum kills match the wave sizes", () => {
  assert.equal(a.runScore(3, 10), 3000 + 1000);
  assert.equal(a.minKills(1), 2);
  assert.equal(a.minKills(3), 2 + 3 + 4);
  assert.equal(a.minKills(20), 2 + 3 + 4 + 5 + 6 + 7 + 8 + 8 * 13);
});

test("arcade names are capitals, short and never empty", () => {
  assert.equal(a.cleanScoreName("  ace pilot "), "ACE PILOT");
  assert.equal(a.cleanScoreName("<b>x</b>"), "BXB");
  assert.equal(a.cleanScoreName("ABCDEFGHIJKLMNOP"), "ABCDEFGHIJKL");
  assert.equal(a.cleanScoreName(""), "PILOT");
  assert.equal(a.cleanScoreName(5), "PILOT");
});

test("the table keeps the best ten, an older score wins a tie, and rank is reported", () => {
  let table = [];
  for (let i = 1; i <= 12; i++) table = a.insertScore(table, entry("P" + i, i, 0, i)).table;
  assert.equal(table.length, 10);
  assert.equal(table[0].waves, 12);
  assert.equal(a.qualifies(table, 100), false);
  assert.equal(a.qualifies(table, table[9].score + 1), true);
  const tie = entry("LATE", 12, 0, 99);
  const r = a.insertScore(table, tie);
  assert.equal(r.table[0].name, "P12");
  assert.equal(r.rank, 2);
  assert.equal(a.insertScore([], entry("ONE", 1)).rank, 1);
  assert.equal(a.qualifies([], 0), false);
});

test("a stored table is cleaned: bad, impossible and extra entries are dropped", () => {
  const good = entry("ACE", 4);
  const cheat = { ...entry("CHEAT", 2), score: 99999 };
  const lower = { ...entry("low", 1), name: "low" };
  const t = a.sanitizeTable([good, cheat, lower, null, "x", { ...good, at: -1 }]);
  assert.deepEqual(t.map(e => e.name), ["ACE"]);
  assert.deepEqual(a.sanitizeTable("nope"), []);
});

test("public board messages carry only a name and a score, and impossible ones are refused", () => {
  const e = entry("ACE", 5, 3);
  const text = a.scoreMessage(e);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["k", "n", "s", "v", "w"]);
  assert.equal(a.parseScoreMessage(text, 7).score, e.score);
  assert.equal(a.parseScoreMessage(JSON.stringify({ v: 1, n: "X", w: 2, k: 5, s: 99999 }), 1), null);      // score does not follow
  assert.equal(a.parseScoreMessage(JSON.stringify({ v: 1, n: "X", w: 30, k: 5, s: 30500 }), 1), null);     // too few kills for the waves
  assert.equal(a.parseScoreMessage(JSON.stringify({ v: 2, n: "X", w: 1, k: 2, s: 1200 }), 1), null);       // wrong version
  assert.equal(a.parseScoreMessage("{" + "x".repeat(300), 1), null);
  assert.equal(a.parseScoreMessage("not json", 1), null);
  assert.equal(a.parseScoreMessage(JSON.stringify({ v: 1, n: "<script>", w: 1, k: 2, s: 1200 }), 1).name, "SCRIPT");
});

test("the public board dedupes, caps itself and shows the best ten", () => {
  const b = new a.PublicBoard();
  const e = entry("ACE", 5);
  assert.equal(b.ingest(a.scoreMessage(e), 1), true);
  assert.equal(b.ingest(a.scoreMessage(e), 2), false); // the same score again
  for (let i = 1; i <= 15; i++) b.ingest(a.scoreMessage(entry("P" + i, i)), 3);
  const top = b.top();
  assert.equal(top.length, 10);
  assert.equal(top[0].waves, 15);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
});
