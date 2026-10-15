import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

const bundle = await build({ entryPoints: ["dev/network-harness.ts"], bundle: true, write: false, platform: "browser", format: "esm", target: "es2020", minify: true });
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile("dev/network-harness.html", `<!doctype html><html lang="en"><meta charset="utf-8"><title>Constellation synthetic network test</title>
<style>body{font:16px system-ui;background:#10131a;color:#eee;max-width:760px;margin:24px}label{display:block;margin:12px 0}input,button{font:inherit;margin:4px;padding:6px}pre{white-space:pre-wrap}.error{color:#ff927e}</style>
<h1>Synthetic network test</h1><p>No vault access. Uses two synthetic stars. Forced relay sends real TURN traffic only while clients are connected.</p>
<label>Name <input id="name" value="Synthetic Pilot"></label><label><input id="relay" type="checkbox">Force TURN relay</label><label><input id="flying" type="checkbox" checked>Flying</label>
<button id="create">Create room</button><label>Room code <input id="code" maxlength="8"></label><button id="join">Join room</button><button id="leave">Leave room</button>
<p id="status" role="status">Ready</p><ul id="players"></ul><p id="maps"></p><pre id="transport">No peer connection</pre><script type="module">${js}</script></html>`);
console.log("Built synthetic network harness (no vault data).");
