import { Notice, Plugin, requestUrl } from "obsidian";
import { parseRoomCode } from "./netcrypto";
import { RELEASES_API, compareVersions, parseLatest } from "./update";
import { ConstellationSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { ConstellationSettingTab } from "./settingsTab";
import { ConstellationView, VIEW_TYPE } from "./view";

const RESETS_COLOURS: (keyof ConstellationSettings)[] = ["palette", "groupBy", "folderDepth"];

export default class ConstellationPlugin extends Plugin {
  settings: ConstellationSettings = { ...DEFAULT_SETTINGS };
  private saveTimer = 0;
  private rebuildTimer = 0;
  private pendingReset = false;

  async onload(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
    this.registerView(VIEW_TYPE, leaf => new ConstellationView(leaf, this));
    this.addRibbonIcon("orbit", "Open starfield graph", () => void this.activate());
    this.addCommand({ id: "open", name: "Open graph view", callback: () => void this.activate() });
    this.addSettingTab(new ConstellationSettingTab(this.app, this));
    // wait until the workspace has been restored, otherwise the saved layout would open over it
    // an invite link (obsidian://starfield-join?code=...) opens the graph with the room code filled in; the reader still presses Join
    this.registerObsidianProtocolHandler("starfield-join", params => {
      const code = parseRoomCode(String(params.code ?? ""));
      if (!code) { new Notice("That invite link does not have a valid room code."); return; }
      void this.activate().then(() => this.views()[0]?.openJoin(code));
    });
    this.addCommand({ id: "tour", name: "Tour the linked notes", callback: () => void this.activate().then(() => this.views()[0]?.tour()) });
    this.addCommand({ id: "check-updates", name: "Check for a new version", callback: () => void this.checkForUpdates(true) });
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) void this.activate();
      // optional and off by default: at most once a day, and only when the reader has turned it on
      if (this.settings.checkForUpdates && Date.now() - this.settings.updateCheckedAt > 24 * 3600 * 1000) void this.checkForUpdates(false);
    });
  }

  /**
   * Ask GitHub for the latest release and say so if it is newer than this one. It only ever shows a notice with a link:
   * nothing is downloaded or installed (Obsidian's Community plugins page does that). A manual check also says when you are up to date.
   */
  async checkForUpdates(manual: boolean): Promise<void> {
    try {
      const res = await requestUrl({ url: RELEASES_API, headers: { Accept: "application/vnd.github+json" }, throw: false });
      if (res.status !== 200) { if (manual) new Notice("Could not check for a new version right now."); return; }
      const latest = parseLatest(res.json), current = this.manifest.version;
      this.update({ updateCheckedAt: Date.now() });
      if (latest && compareVersions(latest.version, current) > 0) {
        if (!manual && this.settings.updateNotified === latest.version) return; // said once already
        this.update({ updateNotified: latest.version });
        new Notice(createFragment(f => {
          f.createSpan({ text: `Starfield Graph ${latest.version} is available (you have ${current}). Update it under Settings, Community plugins, Check for updates. ` });
          f.createEl("a", { text: "What is new", href: latest.url });
        }), 20000);
      } else if (manual) new Notice(`Starfield Graph ${current} is up to date.`);
    } catch { if (manual) new Notice("Could not check for a new version right now."); }
  }

  onunload(): void {
    // Obsidian removes the registered view for us; just make sure the last change is on disk.
    window.clearTimeout(this.rebuildTimer);
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); void this.saveData(this.settings); }
  }

  async activate(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  private views(): ConstellationView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view as ConstellationView);
  }

  /**
   * Apply a settings change. Cheap changes show at once; saving and the (more expensive) vault
   * rebuild are debounced so dragging a slider or typing in a text box does not hammer the disk or the layout.
   */
  update(patch: Partial<ConstellationSettings>, rebuild = false): void {
    this.settings = { ...this.settings, ...patch };
    this.views().forEach(v => v.applySettings(false));

    if (rebuild) {
      if (RESETS_COLOURS.some(k => k in patch)) this.pendingReset = true;
      window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = window.setTimeout(() => {
        const reset = this.pendingReset; this.pendingReset = false;
        this.views().forEach(v => v.applySettings(true, reset));
      }, 400);
    }
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; void this.saveData(this.settings); }, 600);
  }
}
