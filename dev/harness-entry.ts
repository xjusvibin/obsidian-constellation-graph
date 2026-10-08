// Browser-only entry used to preview and test the graph outside Obsidian.
import "./obsidian-shim"; // must run before the plugin code, which relies on Obsidian's DOM helpers
import { ConstellationApp } from "../src/app";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { GraphData } from "../src/types";

declare const __MOCK__: GraphData;

interface HarnessWindow extends Window {
  __app?: ConstellationApp;
  __log?: string[];
}

const host = document.getElementById("app");
if (host) {
  const log: string[] = [];
  const app = new ConstellationApp(host, { openNote: (id, tab) => { log.push(`open ${id} ${tab ? "(tab)" : ""}`); } }, { ...DEFAULT_SETTINGS });
  app.setData(__MOCK__);
  const w = window as HarnessWindow; // handles for tests
  w.__app = app;
  w.__log = log;
}