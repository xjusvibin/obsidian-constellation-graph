// Takes the README/listing screenshots from the built harness, with headless Edge or Chrome.
// Usage: node dev/screenshots.mjs <path-to-vault> [out-dir]     (the vault only supplies note names and links; use the demo vault)
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) { console.error("Pass the path to a (demo) vault, or set OBSIDIAN_VAULT."); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const out = path.resolve(process.argv[3] || path.join(here, "..", "screenshots"));
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(here, "build-harness.mjs"), vault], { stdio: "inherit" });

const browser = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(p => fs.existsSync(p));
if (!browser) { console.error("No Edge or Chrome found."); process.exit(1); }

const base = fs.readFileSync(path.join(here, "harness.html"), "utf8");
const pre = `const wait=ms=>new Promise(r=>setTimeout(r,ms));while(!window.__app)await wait(100);const A=window.__app,R=A.renderer;`;
const scenes = {
  overview: `await wait(7000);`,
  folded: `await wait(5000);R.toggleAllGroups();await wait(3500);`,
  pilot: `A.applySettings({...A.settings,pilotSound:false,pilotShip:"dart"});await wait(4000);R.setPilot(true);await wait(5000);`,
  cockpit: `A.applySettings({...A.settings,pilotSound:false,pilotShip:"striker",pilotView:"cockpit"});await wait(4000);R.setPilot(true);await wait(4500);`,
};
for (const [name, body] of Object.entries(scenes)) {
  const page = path.join(here, `shot-${name}.html`);
  fs.writeFileSync(page, base.replace("</body>", `<script>(async()=>{try{${pre}${body}}catch(e){}document.title="DONE";})();</script></body>`));
  const file = path.join(out, `${name}.png`);
  try {
    execFileSync(browser, ["--headless=new", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1400,860", "--virtual-time-budget=20000", `--screenshot=${file}`, "file:///" + page.split(path.sep).join("/")], { stdio: "ignore", timeout: 90000 });
    console.log("wrote", file);
  } finally { fs.rmSync(page, { force: true }); }
}
