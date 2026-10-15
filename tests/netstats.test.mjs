import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  stdin: { contents: 'export * from "./src/netstats";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
});
const s = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("no loss is reported until there is enough to go on", () => {
  const m = new s.LossMeter();
  for (let i = 1; i <= 4; i++) m.ping(i);
  assert.equal(m.loss, 0);
});

test("answered pings count as delivered, unanswered ones as lost, and the newest is not judged yet", () => {
  const m = new s.LossMeter();
  for (let i = 1; i <= 11; i++) { m.ping(i); if (i % 2 === 0) m.pong(i); } // every second one is answered; 11 is still on its way
  assert.equal(m.loss, 0.5);
  const clean = new s.LossMeter();
  for (let i = 1; i <= 11; i++) { clean.ping(i); if (i < 11) clean.pong(i); }
  assert.equal(clean.loss, 0);
});

test("only the last twenty pings matter, and answers for unknown pings are ignored", () => {
  const m = new s.LossMeter();
  for (let i = 1; i <= 20; i++) m.ping(i); // all lost
  for (let i = 21; i <= 60; i++) { m.ping(i); m.pong(i); }
  assert.equal(m.loss, 0);
  m.pong(9999);
  assert.equal(m.loss, 0);
});
