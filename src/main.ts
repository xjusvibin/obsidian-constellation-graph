import { Plugin } from "obsidian";
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
    this.addRibbonIcon("orbit", "Open constellation graph", () => void this.activate());
    this.addCommand({ id: "open", name: "Open graph view", callback: () => void this.activate() });
    this.addSettingTab(new ConstellationSettingTab(this.app, this));
    // wait until the workspace has been restored, otherwise the saved layout would open over it
    this.app.workspace.onLayoutReady(() => { if (this.settings.openOnStartup) void this.activate(); });
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
