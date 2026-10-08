import { App, PluginSettingTab, Setting } from "obsidian";
import type ConstellationPlugin from "./main";
import type { ConstellationSettings } from "./settings";

export class ConstellationSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ConstellationPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const set = (patch: Partial<ConstellationSettings>, rebuild = false) => this.plugin.update(patch, rebuild);

    new Setting(containerEl).setName("Motion").setHeading();
    new Setting(containerEl).setName("Flow")
      .setDesc("How much the notes drift and orbit. Off lets the layout settle and stay still.")
      .addDropdown(d => d.addOptions({ off: "Off", calm: "Calm", lively: "Lively" }).setValue(s.motion)
        .onChange(v => set({ motion: v as ConstellationSettings["motion"] })));
    new Setting(containerEl).setName("Slowly rotate the camera")
      .setDesc("Resumes a few seconds after you stop interacting, like a screensaver.")
      .addToggle(t => t.setValue(s.autoRotate).onChange(v => set({ autoRotate: v })));
    new Setting(containerEl).setName("Rotation speed")
      .addSlider(sl => sl.setLimits(0.1, 2, 0.1).setValue(s.rotateSpeed).setDynamicTooltip().onChange(v => set({ rotateSpeed: v })));
    new Setting(containerEl).setName("Respect system reduced-motion setting")
      .setDesc("When your operating system asks for reduced motion, stop all flow and rotation.")
      .addToggle(t => t.setValue(s.respectReducedMotion).onChange(v => set({ respectReducedMotion: v })));

    new Setting(containerEl).setName("Appearance").setHeading();
    new Setting(containerEl).setName("Glow")
      .addSlider(sl => sl.setLimits(0, 1.5, 0.1).setValue(s.glow).setDynamicTooltip().onChange(v => set({ glow: v })));
    new Setting(containerEl).setName("Bloom effect")
      .setDesc("Soft light bleed around bright notes. Turn off on slower computers.")
      .addToggle(t => t.setValue(s.bloom).onChange(v => set({ bloom: v })));
    new Setting(containerEl).setName("Colour palette")
      .setDesc("The colour-blind-safe palette uses the Okabe-Ito colours.")
      .addDropdown(d => d.addOptions({ vibrant: "Vibrant", colorblind: "Colour-blind safe", theme: "Match theme accent" })
        .setValue(s.palette).onChange(v => set({ palette: v as ConstellationSettings["palette"] }, true)));
    new Setting(containerEl).setName("Outline the open note")
      .setDesc("Draws a ring around the note you are currently viewing.")
      .addToggle(t => t.setValue(s.highlightActive).onChange(v => set({ highlightActive: v })));

    new Setting(containerEl).setName("Accessibility").setHeading();
    new Setting(containerEl).setName("High contrast")
      .setDesc("Solid, bright nodes and links, no glow or bloom, and heavier labels.")
      .addToggle(t => t.setValue(s.highContrast).onChange(v => set({ highContrast: v })));
    new Setting(containerEl).setName("Label size")
      .addSlider(sl => sl.setLimits(10, 24, 1).setValue(s.labelSize).setDynamicTooltip().onChange(v => set({ labelSize: v })));
    new Setting(containerEl).setName("Visible labels")
      .setDesc("How many of the most-connected notes are always labelled.")
      .addSlider(sl => sl.setLimits(0, 40, 1).setValue(s.labelCount).setDynamicTooltip().onChange(v => set({ labelCount: v })));

    new Setting(containerEl).setName("Notes").setHeading();
    new Setting(containerEl).setName("Group by")
      .addDropdown(d => d.addOptions({ folder: "Folder", tag: "First tag", none: "Nothing" }).setValue(s.groupBy)
        .onChange(v => { set({ groupBy: v as ConstellationSettings["groupBy"] }, true); }));
    new Setting(containerEl).setName("Folder depth")
      .setDesc("When grouping by folder: 1 groups by top-level folder, 2 by the next level, and so on.")
      .addSlider(sl => sl.setLimits(1, 4, 1).setValue(s.folderDepth).setDynamicTooltip().onChange(v => set({ folderDepth: v }, true)));
    new Setting(containerEl).setName("Show notes with no links")
      .addToggle(t => t.setValue(s.showOrphans).onChange(v => set({ showOrphans: v }, true)));
    new Setting(containerEl).setName("Excluded folders")
      .setDesc("Comma-separated folder paths to leave out.")
      .addText(t => t.setPlaceholder("Templates, Archive/old").setValue(s.excludeFolders).onChange(v => set({ excludeFolders: v }, true)));
  }
}
