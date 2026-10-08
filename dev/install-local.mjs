// Production build, then copy the three release files into a vault's plugin folder.
// Usage: node dev/install-local.mjs <path-to-vault>   (or set OBSIDIAN_VAULT)
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) { console.error("Pass the path to a vault, or set OBSIDIAN_VAULT."); process.exit(1); }
const dest = path.join(vault, ".obsidian", "plugins", "constellation-graph");
execSync("node esbuild.config.mjs production", { stdio: "inherit" });
fs.mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(dest, f));
console.log("installed to", dest, "-", fs.statSync(path.join(dest, "main.js")).size, "bytes main.js");
