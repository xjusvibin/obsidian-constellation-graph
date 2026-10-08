// Builds dev/harness.html: the graph UI, CSS and mock data inlined; three.js comes from a CDN (dev preview only, keeps the file small).
// Usage: node dev/build-harness.mjs <path-to-vault>   (or set OBSIDIAN_VAULT)
import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) { console.error("Pass the path to a vault, or set OBSIDIAN_VAULT."); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// --- mock data: notes and [[links]] read straight from a vault folder
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) files.push(path.relative(vault, p).split(path.sep).join("/"));
  }
})(vault);
const byBase = new Map(files.map(f => [path.basename(f, ".md"), f]));
const seen = new Set(), links = [], deg = new Map();
for (const f of files) {
  for (const m of fs.readFileSync(path.join(vault, f), "utf8").matchAll(/\[\[([^\]|#]+)/g)) {
    const t = byBase.get(m[1].trim());
    if (!t || t === f) continue;
    const k = f < t ? f + "\0" + t : t + "\0" + f;
    if (seen.has(k)) continue;
    seen.add(k); links.push({ source: f, target: t });
    deg.set(f, (deg.get(f) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1);
  }
}
const keyOf = f => (f.includes("/") ? f.split("/")[0] : "(vault root)");
const counts = new Map(); files.forEach(f => counts.set(keyOf(f), (counts.get(keyOf(f)) || 0) + 1));
const palette = ["#ffd54a", "#5b9bff", "#2fd4e8", "#ff5c62", "#4ade80", "#b085f5", "#f0883e", "#ff7ac6"];
const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count], i) => ({ key, label: key, color: palette[i % palette.length], count }));
const mock = {
  nodes: files.map(f => ({ id: f, name: path.basename(f, ".md"), group: keyOf(f), deg: deg.get(f) || 0, ctime: fs.statSync(path.join(vault, f)).birthtimeMs })),
  links, groups,
};

// --- bundle the browser entry
const out = await esbuild.build({
  entryPoints: [path.join(here, "harness-entry.ts")], bundle: true, write: false, format: "esm", platform: "browser", external: ["three", "three/examples/jsm/*"],
  target: "es2020", minify: true, define: { __MOCK__: JSON.stringify(mock) }, legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync(path.join(here, "..", "styles.css"), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Constellation harness</title><style>html,body{margin:0;height:100%;background:#05070c}#app{position:fixed;inset:0}
body{--font-interface:system-ui,"Segoe UI",sans-serif}${css}</style></head><body><div id="app"></div>\n<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js","three/examples/jsm/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/"}}</script>\n<script type="module">${js}</script></body></html>`;
fs.writeFileSync(path.join(here, "harness.html"), html);
console.log(`harness.html: ${(html.length / 1024).toFixed(0)} KB, ${mock.nodes.length} notes, ${mock.links.length} links, ${groups.length} groups`);
