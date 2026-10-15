import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type ConstellationPlugin from "./main";
import type { ConstellationSettings } from "./settings";

type Control =
  | { kind: "toggle" }
  | { kind: "dropdown"; options: Record<string, string> }
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "text"; placeholder: string };

/** The settings that are a plain value (a switch, a number, a choice or a text), which is all the settings screen shows. */
type SettingKey = { [K in keyof ConstellationSettings]: ConstellationSettings[K] extends string | number | boolean ? K : never }[keyof ConstellationSettings];

interface SettingDef {
  key: SettingKey;
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
        desc: "Show the starfield graph as soon as Obsidian starts. It is saved with the vault, so anyone who opens this vault sees it first." },
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
      { key: "rememberView", name: "Remember the camera", control: { kind: "toggle" },
        desc: "Open the graph looking the way you left it (the direction and how far in or out), instead of the default view." },
      { key: "nodeSize", name: "Node size", control: { kind: "slider", min: 0.5, max: 2, step: 0.1 },
        desc: "How big the notes are drawn. Lower it if a busy group looks like one white blob." },
      { key: "linkBrightness", name: "Link brightness", control: { kind: "slider", min: 0.3, max: 2.5, step: 0.1 },
        desc: "How bright the links between notes are." },
      { key: "spacing", name: "Spacing", control: { kind: "slider", min: 0.5, max: 2.5, step: 0.1 },
        desc: "How far apart notes and groups sit: it scales the repel force and the link distance. The layout is rebuilt when you change it." },
      { key: "bloom", name: "Bloom effect", control: { kind: "toggle" },
        desc: "Soft light bleed around bright notes. Turn off on slower computers." },
      { key: "quality", name: "Quality", control: { kind: "dropdown", options: { auto: "Automatic", low: "Low (fastest, no glow pass)", balanced: "Balanced", high: "High (sharpest)" } },
        desc: "Low turns the glow pass off and draws at normal resolution; High draws at the screen's full sharpness. Automatic starts sharp and lowers itself if the view runs slowly." },
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
    heading: "Pilot mode",
    items: [
      { key: "pilotEnabled", name: "Enable Pilot mode", control: { kind: "toggle" },
        desc: "A flying sandbox: fly a small ship through your notes with the keyboard and mouse (press P in the graph). It never selects or opens notes. Needs motion, so it stays off when reduced motion is on." },
      { key: "pilotMouse", name: "Mouse mode", control: { kind: "dropdown", options: { capture: "Capture (mouse look)", cursor: "Cursor (visible, steer from the centre)" } },
        desc: "Capture hides the pointer and steers with its movement. Cursor keeps the pointer visible, so you can click the panels and buttons while flying: the further it is from the centre, the harder the ship turns, and it stops steering when it is over a panel." },
      { key: "pilotCollapse", name: "Fold groups when flying", control: { kind: "dropdown", options: { auto: "Auto (big vaults only)", always: "Always", never: "Never" } },
        desc: "Each group can be folded into one glowing point: shoot it to open it, press B to fold one back. Auto folds a vault of more than 400 notes the first time you fly." },
      { key: "pilotSensitivity", name: "Mouse sensitivity", control: { kind: "slider", min: 0.2, max: 3, step: 0.1 } },
      { key: "pilotInvertY", name: "Invert vertical look", control: { kind: "toggle" } },
      { key: "pilotSpeed", name: "Flight speed", control: { kind: "slider", min: 0.4, max: 3, step: 0.1 },
        desc: "Scales the ship's speed. It is already set from the size of your vault, so a bigger vault takes longer to cross." },
      { key: "pilotAgility", name: "Agility", control: { kind: "slider", min: 0.5, max: 1.5, step: 0.1 },
        desc: "Lower is heavier: the ship turns more slowly and takes longer to start and stop a turn." },
      { key: "pilotView", name: "View", control: { kind: "dropdown", options: { chase: "Chase (see the plane)", cockpit: "Cockpit (no plane)" } },
        desc: "Press V in flight to switch." },
      { key: "checkForUpdates", name: "Tell me about new versions", control: { kind: "toggle" },
        desc: "Off by default. When on, once a day the plugin asks GitHub whether a newer release exists and shows a notice with a link. It uses the network for that one request and never downloads or installs anything. You can also run the command Check for a new version at any time." },
      { key: "pilotShip", name: "Ship", control: { kind: "dropdown", options: { striker: "Striker (four wings)", dart: "Dart (delta wing)", bulwark: "Bulwark (heavy gunship)" } },
        desc: "How your ship looks, to you and to other pilots. All three fly and fight the same." },
      { key: "pilotColor", name: "Ship colour", control: { kind: "dropdown", options: { auto: "Automatic", orange: "Orange", violet: "Violet", green: "Green", rose: "Rose", gold: "Gold", white: "White", red: "Red", cyan: "Cyan" } },
        desc: "The glow of your ship's outline and engines, for you and for other pilots. Automatic is cyan for you and your place's colour for everyone else." },
      { key: "pilotWireframe", name: "Wireframe effects", control: { kind: "toggle" },
        desc: "Glowing plane outline, target brackets, impact bursts and faint shells around each group." },
      { key: "pilotSound", name: "Sound effects", control: { kind: "toggle" },
        desc: "Engine, blasters and warp, made on the fly. Nothing plays unless you are flying." },
      { key: "pilotVolume", name: "Volume", control: { kind: "slider", min: 0, max: 1, step: 0.05 } },
    ],
  },
  {
    heading: "Multiplayer",
    items: [
      { key: "multiplayerName", name: "Your name", control: { kind: "text", placeholder: "Pilot" },
        desc: "Shown to the other pilots in a room (up to 24 characters)." },
      { key: "multiplayerRelayUrl", name: "Relay", control: { kind: "text", placeholder: "https://ntfy.sh" },
        desc: "A public relay used only to set up connections: a few small messages, each sealed with the room code, so the relay cannot read them. The default is the free ntfy.sh service, which has usage limits; you can use your own ntfy server instead. Nothing else goes through it." },
      { key: "multiplayerTurnUrl", name: "Your own TURN server (optional)", control: { kind: "text", placeholder: "turn:turn.example.com:3478" },
        desc: "Some networks block direct connections. If you run a TURN server, enter it here (with its user name and password below) and it will be used when a direct connection fails. Nothing is set up for you: without one, those networks cannot connect." },
      { key: "multiplayerTurnUser", name: "TURN user name", control: { kind: "text", placeholder: "" } },
      { key: "multiplayerTurnCredential", name: "TURN password", control: { kind: "text", placeholder: "" },
        desc: "Saved in this vault's plugin settings, as plain text." },
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
