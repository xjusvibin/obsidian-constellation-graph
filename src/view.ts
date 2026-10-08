import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { ConstellationApp } from "./app";
import { buildGraphData, signature } from "./data";
import type ConstellationPlugin from "./main";

export const VIEW_TYPE = "constellation-graph-view";

export class ConstellationView extends ItemView {
  private ca: ConstellationApp | null = null;
  private timer = 0;
  private sig = "";
  private colors = new Map<string, number>();

  constructor(leaf: WorkspaceLeaf, private plugin: ConstellationPlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Constellation graph"; }
  getIcon(): string { return "orbit"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("cg-view");
    this.ca = new ConstellationApp(this.contentEl, {
      openNote: (id, newTab) => this.openNote(id, newTab),
    }, this.plugin.settings);
    this.refresh(true);

    const later = () => this.schedule();
    this.registerEvent(this.app.metadataCache.on("resolved", later));
    this.registerEvent(this.app.vault.on("delete", later));
    this.registerEvent(this.app.vault.on("rename", later));
    this.registerEvent(this.app.workspace.on("file-open", f => this.ca?.setActive(f?.path ?? null)));
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.timer);
    this.ca?.destroy();
    this.ca = null;
  }

  /** Rebuild from the vault. Skipped when nothing about the graph changed, so edits to note text do not disturb the motion. */
  refresh(force = false): void {
    if (!this.ca) return;
    const data = buildGraphData(this.app, this.plugin.settings, this.colors);
    const sig = signature(data);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.ca.setData(data);
    this.ca.setActive(this.app.workspace.getActiveFile()?.path ?? null);
  }

  /** `rebuild` re-reads the vault (grouping changed); `resetColors` also hands out fresh colours. */
  applySettings(rebuild: boolean, resetColors = false): void {
    this.ca?.applySettings(this.plugin.settings);
    if (!rebuild) return;
    if (resetColors) this.colors.clear();
    this.refresh(true);
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 800);
  }

  private openNote(id: string, newTab: boolean): void {
    const f = this.app.vault.getAbstractFileByPath(id);
    if (!(f instanceof TFile)) return;
    // reuse the note you were last reading, but never replace this graph and never touch a sidebar
    const recent = this.app.workspace.getMostRecentLeaf();
    const reuse = !newTab && recent && recent !== this.leaf && recent.view.getViewType() === "markdown" ? recent : null;
    const leaf = reuse ?? this.app.workspace.getLeaf("tab");
    void leaf.openFile(f);
    void this.app.workspace.revealLeaf(leaf);
  }
}
