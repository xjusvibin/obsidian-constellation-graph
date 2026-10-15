import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.window = globalThis;
const built = await build({
  stdin: { contents: 'export * from "./src/lobby";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
});
const l = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const msg = (o) => JSON.stringify({ v: 1, code: "ABCDEFGHJK", name: "Nova's room", n: 2, ...o });

test("an announcement is read only in its exact shape, with a clean name", () => {
  assert.deepEqual(l.parseListing(msg({})), { code: "ABCDEFGHJK", name: "Nova's room", pilots: 2 });
  assert.equal(l.parseListing(msg({ code: "short" })), null);
  assert.equal(l.parseListing(msg({ code: "ABCDE-FGHJK" })).code, "ABCDEFGHJK");
  assert.equal(l.parseListing(msg({ n: 0 })), null);
  assert.equal(l.parseListing(msg({ n: 5 })), null);
  assert.equal(l.parseListing(msg({ n: "2" })), null);
  assert.equal(l.parseListing(msg({ v: 2 })), null);
  assert.equal(l.parseListing("not json"), null);
  assert.equal(l.parseListing("x".repeat(500)), null);
  assert.equal(l.parseListing(msg({ name: "<img src=x onerror=1>Bob" })).name, "img srcx onerror1Bob");
  assert.equal(l.parseListing(msg({ name: "" })).name, "Pilot");
  assert.ok(l.parseListing(msg({ name: "x".repeat(200) })).name.length <= 24);
});

test("announcements round trip", () => {
  const a = { code: "ABCDEFGHJK", name: "Nova", pilots: 3 };
  assert.deepEqual(l.parseListing(l.announcement(a)), a);
});

test("a room that announces too fast is ignored, and rooms drop off when they go quiet", () => {
  const b = new l.LobbyBoard();
  assert.ok(b.ingest(msg({}), 0));
  assert.equal(b.ingest(msg({ n: 3 }), 2_000), false, "too soon");
  assert.equal(b.list(3_000)[0].pilots, 2);
  assert.ok(b.ingest(msg({ n: 3 }), 12_000));
  assert.equal(b.list(13_000)[0].pilots, 3);
  assert.equal(b.list(12_000 + l.LISTING_TTL_MS + 1).length, 0, "gone after 45 s of silence");
});

test("the list is capped, sorted fullest first, and never shows your own or full rooms", () => {
  const b = new l.LobbyBoard();
  const code = (i) => "ABCDEFGHJK".slice(0, 6) + String(2 + (i % 8)) + String(2 + Math.floor(i / 8) % 8) + String(2 + Math.floor(i / 64) % 8) + "A";
  for (let i = 0; i < 100; i++) b.ingest(msg({ code: code(i), name: "Room " + i, n: 1 + (i % 3) }), i);
  const list = b.list(100);
  assert.ok(list.length <= l.MAX_LISTED);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].pilots >= list[i].pilots);
  const c2 = new l.LobbyBoard(); c2.ingest(msg({ n: 4 }), 0); c2.ingest(msg({ code: "KJHGFEDCBA", n: 1 }), 0);
  assert.deepEqual(c2.list(1).map(x => x.code), ["KJHGFEDCBA"], "a full room is hidden");
  assert.equal(c2.list(1, "KJHGFEDCBA").length, 0, "your own room is hidden");
});

test("the table itself cannot be made to grow without limit", () => {
  const b = new l.LobbyBoard();
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 500; i++) b.ingest(msg({ code: chars[i % 32] + chars[Math.floor(i / 32) % 32] + "ABCDEFGH", n: 1 }), i * 11_000);
  assert.ok(b.rooms.size <= l.MAX_LISTED * 2);
});
