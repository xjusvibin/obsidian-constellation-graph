// Browser-only entry used to preview and test the graph outside Obsidian.
import { ConstellationApp } from "../src/app";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { GraphData } from "../src/types";

declare const __MOCK__: GraphData;

const host = document.getElementById("app")!;
const log: string[] = [];
const app = new ConstellationApp(host, { openNote: (id, tab) => { log.push(`open ${id} ${tab ? "(tab)" : ""}`); } }, { ...DEFAULT_SETTINGS });
app.setData(__MOCK__);

// handles for tests
(window as any).__app = app;
(window as any).__log = log;
(window as any).__defaults = DEFAULT_SETTINGS;
