import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export * from "./src/tutorial";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const t = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("the tips go in order, ignore other events, and finish", () => {
  const seen = [];
  const tut = new t.Tutorial((text, done) => seen.push([text, done]));
  tut.start();
  assert.match(seen.at(-1)[0], /^1 of 5/);
  tut.note("fire"); tut.note("kill");                // not asked for yet
  assert.match(tut.text, /^1 of 5/);
  for (const e of ["thrust", "steer", "fire", "boost"]) tut.note(e);
  assert.match(tut.text, /^5 of 5/);
  assert.equal(tut.done, false);
  tut.note("kill");
  assert.equal(tut.done, true);
  assert.equal(seen.at(-1)[1], true);
  tut.note("thrust");                                // nothing after the end
  assert.equal(seen.length, 6);
});
