import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const settingsModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("legacy localhost signaling default migrates to hosted rooms", () => {
  const settings = settingsModule.sanitizeSettings({ multiplayerSignalingUrl: "ws://localhost:8787" });
  assert.equal(settings.multiplayerConnectionMode, "hosted");
  assert.equal(settings.multiplayerCustomServerUrl, "");
});

test("previous custom signaling addresses remain selected and unchanged", () => {
  const url = "wss://my-room.example.net/socket";
  const settings = settingsModule.sanitizeSettings({ multiplayerSignalingUrl: url });
  assert.equal(settings.multiplayerConnectionMode, "custom");
  assert.equal(settings.multiplayerCustomServerUrl, url);
});

test("fresh settings use the bundled hosted service", () => {
  const settings = settingsModule.sanitizeSettings({});
  assert.equal(settings.multiplayerConnectionMode, "hosted");
  assert.equal(settings.multiplayerCustomServerUrl, "");
});
