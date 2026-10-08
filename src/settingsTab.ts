import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type ConstellationPlugin from "./main";
import type { ConstellationSettings } from "./settings";

type Control =
  | { kind: "toggle" }
  | { kind: "dropdown"; options: Record<string, string> }
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "text"; placeholder: string };

interface SettingDef {
  key: keyof ConstellationSettings;
  name: string;
  desc?: string;
  control: Control;
  /** Changing this regroups or refilters the notes, so the graph is rebuilt from the vault. */
  rebuild?: boolean;
}

interface Section {
  heading: string;
  items: SettingDef[];
}

/**
 * Every setting is described once, here. Obsidian 1.13 and newer render (and search) these as declarative
 * definitions; older versions get the same settings built from the same table by display().
 */
const SECTIONS: Section[] = [
  {
    heading: "Startup",
    items: [
      { key: "openOnStartup", name: "Open on startup", control: { kind: "toggle" },
        desc: "Show the constellation graph as soon as Obsidian starts. It is saved with the vault, so anyone who opens this vault sees it first." },
    ],
  },
  {
    heading: "Motion",
    items: [
      { key: "motion", name: "Flow", control: { kind: "dropdown", options: { off: "Off", calm: "Calm", lively: "Lively" } },
        desc: "How much the notes drift and orbit. Off lets the layout settle and stay still." },
      { key: "autoRotate", name: "Slowly rotate the camera", control: { kind: "toggle" },
        desc: "Resumes a few seconds after you stop interacting, like a screensaver." },
      { key: "rotateSpeed", name: "Rotation speed", control: { kind: "slider", min: 0.1, max: 2, step: 0.1 } },
      { key: "respectReducedMotion", name: "Respect system reduced-motion setting", control: { kind: "toggle" },
        desc: "When your operating system asks for reduced motion, stop all flow and rotation." },
    ],
  },
  {
    heading: "Appearance",
    items: [
      { key: "glow", name: "Glow", control: { kind: "slider", min: 0, max: 1.5, step: 0.1 } },
      { key: "bloom", name: "Bloom effect", control: { kind: "toggle" },
        desc: "Soft light bleed around bright notes. Turn off on slower computers." },
      { key: "palette", name: "Colour palette", control: { kind: "dropdown", options: { vibrant: "Vibrant", colorblind: "Colour-blind safe", theme: "Match theme accent" } },
        desc: "The colour-blind-safe palette stays distinguishable under the common forms of colour blindness.", rebuild: true },
      { key: "highlightActive", name: "Outline the open note", control: { kind: "toggle" },
        desc: "Draws a ring around the note you are currently viewing." },
    ],
  },
  {
    heading: "Accessibility",
    items: [
      { key: "highContrast", name: "High contrast", control: { kind: "toggle" },
        desc: "Solid, bright nodes and links, no glow or bloom, and heavier labels." },
      { key: "labelSize", name: "Label size", control: { kind: "slider", min: 10, max: 24, step: 1 } },
      { key: "labelCount", name: "Visible labels", control: { kind: "slider", min: 0, max: 40, step: 1 },
        desc: "How many of the most-connected notes are always labelled." },
    ],
  },
  {
    heading: "Notes",
    items: [
      { key: "groupBy", name: "Group by", control: { kind: "dropdown", options: { folder: "Folder", tag: "First tag", none: "Nothing" } }, rebuild: true },
      { key: "folderDepth", name: "Folder depth", control: { kind: "slider", min: 1, max: 4, step: 1 },
        desc: "When grouping by folder: 1 groups by top-level folder, 2 by the next level, and so on.", rebuild: true },
      { key: "showOrphans", name: "Show notes with no links", control: { kind: "toggle" }, rebuild: true },
      { key: "excludeFolders", name: "Excluded folders", control: { kind: "text", placeholder: "Templates, archive/old" },
        desc: "Comma-separated folder paths to leave out.", rebuild: true },
    ],
  },
];

const ALL: SettingDef[] = SECTIONS.flatMap(s => s.items);

export class ConstellationSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ConstellationPlugin) { super(app, plugin); }

  // ---- Obsidian 1.13 and newer: declarative, so these settings also appear in the settings search
  getSettingDefinitions(): SettingDefinitionItem[] {
    return SECTIONS.map(section => ({
      type: "group" as const,
      heading: section.heading,
      items: section.items.map(def => ({
        name: def.name,
        desc: def.desc,
        control: this.controlFor(def),
      })),
    }));
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof ConstellationSettings];
  }

  setControlValue(key: string, value: unknown): void {
    const def = ALL.find(d => d.key === key);
    this.plugin.update({ [key]: value }, def?.rebuild ?? false);
  }

  private controlFor(def: SettingDef) {
    const c = def.control;
    switch (c.kind) {
      case "toggle": return { type: "toggle" as const, key: def.key };
      case "dropdown": return { type: "dropdown" as const, key: def.key, options: c.options };
      case "slider": return { type: "slider" as const, key: def.key, min: c.min, max: c.max, step: c.step };
      case "text": return { type: "text" as const, key: def.key, placeholder: c.placeholder };
    }
  }

  // ---- Obsidian older than 1.13 never calls getSettingDefinitions, so it renders the same table here
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    for (const section of SECTIONS) {
      new Setting(containerEl).setName(section.heading).setHeading();
      for (const def of section.items) {
        const row = new Setting(containerEl).setName(def.name);
        if (def.desc) row.setDesc(def.desc);
        const c = def.control;
        const set = (value: unknown) => this.plugin.update({ [def.key]: value }, def.rebuild ?? false);
        if (c.kind === "toggle") row.addToggle(t => t.setValue(Boolean(s[def.key])).onChange(v => set(v)));
        else if (c.kind === "dropdown") row.addDropdown(d => d.addOptions(c.options).setValue(String(s[def.key])).onChange(v => set(v)));
        else if (c.kind === "slider") row.addSlider(sl => sl.setLimits(c.min, c.max, c.step).setValue(Number(s[def.key])).onChange(v => set(v)));
        else row.addText(t => t.setPlaceholder(c.placeholder).setValue(String(s[def.key])).onChange(v => set(v)));
      }
    }
  }
}
