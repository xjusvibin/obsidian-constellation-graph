import * as THREE from "three";
import type { SimNode } from "./types";
import { PilotAudio } from "./sfx";
import { buildShip, type Ship } from "./ship";
import { buildCockpit, type Cockpit } from "./cockpit";
import type { FlightInput, NavigationTarget, Pose } from "./multiplayer";

/** What the pilot needs from the renderer. Kept narrow so the controller never reaches into renderer state. */
export interface PilotHost {
  nodes(): SimNode[];
  /** The note under a screen point (CSS pixels, relative to the canvas), or -1. `slack` widens every target. */
  pickAt(x: number, y: number, slack: number): number;
  pickDestinationAt(x: number, y: number, slack: number): NavigationTarget | null;
  navigationTarget(): NavigationTarget | null;
  setNavigationTarget(target: NavigationTarget | null): void;
  requestFastTravel(target: NavigationTarget): void;
  groupLabel(gi: number): string;
  /** Visual radius of a note in scene units. */
  nodeRadius(i: number): number;
  /** True if the ship can hit this note (it is showing, not hidden by a group filter or a search). */
  solid(i: number): boolean;
  /** One entry per visible group: its centre, rough radius and colour. */
  clusters(): { x: number; y: number; z: number; r: number; color: string }[];
  bounds(): { cx: number; cy: number; cz: number; radius: number };
  fitDistance(radius: number): number;
  selectedIndex(): number;
  setAim(i: number): void;
  select(i: number): void;
  open(i: number, newTab: boolean): void;
  /** Pilot mode started or stopped, or has something to say (also read out by screen readers). */
  onState(active: boolean, text: string): void;
  /** The reader pressed Esc with the mouse already free: leave Pilot mode. */
  leave(): void;
  onAudioMute(which: "engine" | "afterburner", muted: boolean): void;
  onNetworkFrame(input: FlightInput): void;
  onFire(sequence: number, gun: number, aimPoint: [number, number, number]): void;
}

export interface PilotOptions {
  sensitivity: number;
  invertY: boolean;
  view: "chase" | "cockpit";
  sound: boolean;
  volume: number;
  muteEngine: boolean;
  muteAfterburner: boolean;
  wireframe: boolean;
  /** Scales turn rates and how quickly the ship starts and stops turning. */
  agility: number;
  /** Scales cruise speed on top of the automatic scale for the size of the network. */
  speed: number;
  /** Capture: the mouse is locked and its movement steers. Cursor: the pointer stays visible and its distance from the centre steers. */
  mouse: "capture" | "cursor";
  multiplayer: boolean;
}

// ---- scale. Cruise speed is set from how big the network is, so crossing it takes a believable amount of time.
const CROSS_BASE = 12;     // seconds to fly across a 100-note network at cruise speed
const CROSS_GROWTH = 0.25; // how crossing time grows with the number of notes (time ~ notes ^ 0.25)
const CROSS_MIN = 10;      // ...but never less than this many seconds,
const CROSS_MAX = 60;      // ...or more than this
const MIN_CRUISE = 12;     // scene units per second, so a tiny vault is still flyable

// ---- flight model. The ship is a rigid body: it has a velocity and a spin, and the controls only apply forces and torques to them.
const ACCEL = 0.7;         // main engine thrust, in cruise-speeds per second squared
const BOOST_ACCEL = 11;    // afterburner multiplier on the main engine
const BOOST_TOP = Math.sqrt(BOOST_ACCEL); // top speed under afterburner, in cruise speeds (drag grows with speed squared)
const REVERSE = 0.45;      // reverse thrusters are weaker than the main engine
const SIDE = 0.35;         // so are the side and vertical thrusters
const RETRO = 2.4;         // braking thrust (X), in main-engine units
const GRIP = 0.7;          // how fast the velocity swings toward where the nose points (per second): a turn carves rather than slides
const GRIP_COST = 0.06;    // speed lost by bending your velocity (a hard turn bleeds a little energy)
const TURN_BLEED = 0.1;    // extra drag while the ship is spinning fast
const RESP = 6;            // how quickly the spin eases toward the turn rate the stick asks for (per second)
const SHIP_RADIUS = 0.7;   // size of the ship for collisions, in scene units
const HIT_SCALE = 1.4;     // a note is a little bigger to the ship than it is to the eye, so collisions are readable and fair
const BOUNCE = 0.35;       // how much of the speed into a note comes back out
const DEAD_ZONE = 0.07;    // cursor steering: how far from the centre (as a fraction of full reach) before the ship starts to turn
const CURSOR_REACH = 0.42; // cursor steering: full turn rate at this fraction of the pane's shorter side from the centre
const CURSOR_EASE = 14;    // how quickly the stick follows the cursor (per second)
const BUMP_MIN = 0.04;     // an impact under this fraction of top speed is just a graze: no sound, no shake
const PITCH_RATE = 2.0;    // radians per second at full stick
const YAW_RATE = 1.5;
const ROLL_RATE = 3.0;
const ANG_ACC = 4.0;       // radians per second squared: how quickly the ship can start and stop a turn (its rotational inertia)
const STICK_GAIN = 0.0035; // stick deflection per pixel of mouse movement at sensitivity 1
const STICK_DECAY = 0.9;   // how quickly the virtual stick re-centres when the mouse stops
const BOOST_DRAIN = 0.28;  // afterburner energy per second (1 is full)
const BOOST_REGEN = 0.08;
const BOOST_REGEN_DELAY = 1.5;
const BOOST_HOLD = 3.0;    // seconds the tank stays completely empty after it runs dry, before it starts to refill
const BOOST_RELOCK = 0.3;  // and then the afterburner stays off until the tank has refilled this far
const CAM_RATE = 4.5;      // how tightly the chase camera follows the ship's orientation; lower trails more
const CAM_OFFSET = new THREE.Vector3(0, 1.1, 5.2); // behind and above the ship, in the camera's own space

const WARP_MIN_MS = 1200;  // a warp is fast travel, but it still takes time: longer trips take longer
const WARP_MAX_MS = 6000;
const WARP_SPEED = 7;      // warp speed, in cruise speeds

const FIRE_GAP = 0.16;     // seconds between shots
const BOLT_SPEED = 1500;   // scene units per second
const BOLT_LENGTH = 22;    // how long a bolt is
const BOLT_FADE = 0.12;    // seconds a bolt lingers after it lands
const MAX_BOLTS = 10;
const RANGE = 900;         // how far a shot at nothing travels
const AIM_DIST = 600;      // how far ahead of the nose the crosshair is drawn
const DOUBLE_HIT_MS = 2000; // a second hit on the selected note within this opens it
const AIM_SLACK = 10;      // extra px of forgiveness when aiming
const FIRE_SLACK = 14;    // and when firing
const SHIP_SCALE = 0.34;
const COCKPIT_SCALE = 2.2;
const MAX_SHELLS = 24;
const MAX_BURSTS = 4;
const SHELL_EVERY = 20;    // frames between refreshes of the cluster shells

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Keys the pilot owns. Anything else (Enter, /, ?, L, ...) is left to the normal keyboard handling. */
const OWNED = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyC", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight",
  "KeyX", "KeyF", "KeyT", "KeyG", "KeyH", "KeyV", "KeyK",
]);

type KeyRow = { caps: string[]; label: string | ((p: PilotController) => string); codes: (string | null)[] };
const KEY_GROUPS: { title: string; rows: KeyRow[] }[] = [
  { title: "Fly", rows: [
    { caps: ["W", "S"], label: "Thrust / reverse", codes: ["KeyW", "KeyS"] },
    { caps: ["A", "D"], label: "Strafe", codes: ["KeyA", "KeyD"] },
    { caps: ["Space", "C"], label: "Up / down", codes: ["Space", "KeyC"] },
    { caps: ["Q", "E"], label: "Roll", codes: ["KeyQ", "KeyE"] },
    { caps: ["Shift"], label: "Afterburner", codes: ["ShiftLeft"] },
    { caps: ["X"], label: "Brake", codes: ["KeyX"] },
  ] },
  { title: "Aim", rows: [
    { caps: ["Mouse"], label: p => p.cursorMode ? "Steer: move away from centre" : "Steer", codes: [null] },
    { caps: ["Click", "F"], label: "Fire", codes: [null, "KeyF"] },
    { caps: ["T"], label: "Lock target", codes: ["KeyT"] },
    { caps: ["G"], label: p => p.multiplayer ? "Warp disabled in multiplayer" : "Warp to target", codes: ["KeyG"] },
    { caps: ["H"], label: p => p.multiplayer ? "Warp disabled in multiplayer" : "Back to the hub", codes: ["KeyH"] },
  ] },
  { title: "View", rows: [
    { caps: ["V"], label: "Chase / cockpit", codes: ["KeyV"] },
    { caps: ["K"], label: "Show / hide this", codes: ["KeyK"] },
    { caps: ["Esc"], label: p => p.cursorMode ? "Leave" : "Free the mouse", codes: [null] },
    { caps: ["P"], label: "Leave Pilot mode", codes: [null] },
  ] },
];

interface Warp {
  t0: number; dur: number;
  p0: THREE.Vector3; q0: THREE.Quaternion;
  node: number;                 // -1 for the whole constellation
  centre: THREE.Vector3;        // used when node is -1
  dir: THREE.Vector3;           // which side of the target to arrive on
  dist: number;                 // how far from the target to stop
}
/** A bolt flies from the gun to the note it was aimed at, and the shot counts when it lands. */
interface Bolt { from: THREE.Vector3; node: number; point: THREE.Vector3; travelled: number; ctrl: boolean; landed: boolean; fade: number; sequence?: number }
interface Burst { age: number; pos: THREE.Vector3; size: number; line: THREE.LineSegments }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Free flight through the constellation, as a small fighter with weight. The ship is a rigid body with its own
 * orientation, velocity and spin; the mouse is a virtual stick that asks for a turn rate, and the ship takes time to
 * start and stop turning. The camera trails behind it, the afterburner draws on an energy tank, and flight assist
 * can be turned off for pure drift. Cruise speed is set from the size of the network so a bigger vault feels bigger.
 * Blaster bolts select notes. It never edits a note; the only things it can do to the vault are the things a click
 * already does (select a note, open it).
 */
export class PilotController {
  active = false;

  private keys = new Set<string>();

  // the ship's body
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private vel = new THREE.Vector3();
  private spin = new THREE.Vector3();          // angular velocity in the ship's own axes: x pitch, y yaw, z roll (rad/s)
  private stick = new THREE.Vector2();         // virtual joystick: x yaw, y pitch, each -1..1
  private energy = 1;
  private health = 100;
  private respawnLeft = 0;
  private protectionLeft = 0;
  private boostLocked = false;
  private boosting = false;
  private cursor = { x: 0, y: 0, inside: false }; // where the pointer is over the scene, in CSS px (cursor steering)
  private ringW = 0; private ringH = 0;
  private holdLeft = 0;                    // seconds left before an emptied tank starts refilling
  private regenDelay = 0;
  private roomVisible = true;
  private networkAccumulator = 0;
  private shake = 0;                       // camera shake from impacts, 0..1
  private lastBump = -1e9;
  private mouseDX = 0; private mouseDY = 0; // mouse movement since the last frame
  private smX = 0; private smY = 0;         // the same, smoothed
  private dtS = 0;                         // frame time, smoothed so an uneven frame rate does not show up as jitter
  private cruise = 100;

  // the chase camera, which trails the ship
  private camQuat = new THREE.Quaternion();

  private aim = -1;
  private aimDestination: NavigationTarget | null = null;
  private aimX = 0; private aimY = 0;          // where the nose points, on screen (CSS px)
  private firing = false;
  private cooldown = 0;
  private gun = 0;
  private fireSequence = 0;
  private lastShot = { i: -1, t: -1e9 };
  private warp: Warp | null = null;
  private bolts: Bolt[] = [];
  private bursts: Burst[] = [];
  private frame = 0;
  private clock = 0; // ms of flight time; warps and double-hits run on it, so they pause with the frame loop
  private unlockedAt = 0;
  private opts: PilotOptions;
  private bank = 0; private tilt = 0;          // how far the plane's model leans, for looks only
  private flagsText = "";

  private audio = new PilotAudio();
  private ship: Ship;
  private cockpit: Cockpit;
  private boltLines: THREE.LineSegments;
  private boltPos = new Float32Array(MAX_BOLTS * 3 * 6);
  private boltCol = new Float32Array(MAX_BOLTS * 3 * 6);
  private aimReticle: THREE.LineSegments;
  private lockReticle: THREE.LineSegments;
  private shells: THREE.LineSegments[] = [];
  private shellGeo: THREE.BufferGeometry;
  private burstGeo: THREE.BufferGeometry;

  private hud: HTMLDivElement;
  private cross: HTMLDivElement;
  private hint: HTMLDivElement;
  private readout: HTMLDivElement;
  private readName: HTMLDivElement;
  private readMeta: HTMLDivElement;
  private speedFill: HTMLDivElement;
  private energyFill: HTMLDivElement;
  private healthFill: HTMLDivElement;
  private destruction: HTMLDivElement;
  private flags: HTMLDivElement;
  private muteEngineButton: HTMLButtonElement;
  private muteAfterburnerButton: HTMLButtonElement;
  private ringInner: HTMLDivElement;
  private keysPanel: HTMLDivElement;
  private keyCaps = new Map<string, HTMLElement[]>(); // key code -> the key caps on the panel that light up for it
  private keyLabels: { el: HTMLElement; row: KeyRow }[] = [];
  private clickCap: HTMLElement | null = null;
  private keysShown = true;
  private keysQuiet = false;
  private ringOuter: HTMLDivElement;

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpV3 = new THREE.Vector3();
  private tmpV4 = new THREE.Vector3();
  private fwdV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpM = new THREE.Matrix4();
  private tmpE = new THREE.Euler();

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    private scene: THREE.Scene,
    private host: PilotHost,
    opts: PilotOptions,
  ) {
    this.opts = { ...opts };
    this.audio.setOptions(opts.sound, opts.volume);

    // the cockpit (first-person view)
    this.cockpit = buildCockpit();
    this.scene.add(this.cockpit.group);

    // the plane
    this.ship = buildShip();
    this.ship.group.visible = false;
    this.ship.lights.forEach(l => { l.visible = false; this.scene.add(l); });
    this.scene.add(this.ship.group);

    // bolts: three thin lines side by side read as one thick glowing bolt
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.boltPos, 3); pa.setUsage(THREE.DynamicDrawUsage); g.setAttribute("position", pa);
    const ca = new THREE.BufferAttribute(this.boltCol, 3); ca.setUsage(THREE.DynamicDrawUsage); g.setAttribute("color", ca);
    g.setDrawRange(0, 0);
    this.boltLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    this.boltLines.frustumCulled = false;
    this.boltLines.renderOrder = 5;
    this.boltLines.visible = false;
    this.scene.add(this.boltLines);

    // wireframe elements: target brackets, cluster shells and impact bursts
    this.aimReticle = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 0)), this.wireMaterial(0x6fe8ff, 0.95));
    this.lockReticle = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1, 0)), this.wireMaterial(0xff7a4a, 0.95));
    for (const r of [this.aimReticle, this.lockReticle]) { r.renderOrder = 4; r.visible = false; r.frustumCulled = false; this.scene.add(r); }
    this.shellGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1));
    this.burstGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 0));

    // the HUD is plain DOM, hidden from screen readers (the live region carries what matters)
    this.hud = container.createDiv({ cls: "cg-pilot", attr: { "aria-hidden": "true" } });
    this.hud.hidden = true;
    this.ringOuter = this.hud.createDiv({ cls: "cg-pilot-steer cg-pilot-steer-outer" });
    this.ringInner = this.hud.createDiv({ cls: "cg-pilot-steer cg-pilot-steer-inner" });
    this.cross = this.hud.createDiv({ cls: "cg-pilot-cross" });
    this.hint = this.hud.createDiv({ cls: "cg-pilot-hint" });
    this.readout = this.hud.createDiv({ cls: "cg-pilot-readout" });
    this.readName = this.readout.createDiv({ cls: "cg-pilot-name" });
    this.readMeta = this.readout.createDiv({ cls: "cg-pilot-meta" });
    this.flags = this.hud.createDiv({ cls: "cg-pilot-flags" });
    const audioControls = this.hud.createDiv({ cls: "cg-pilot-audio" });
    this.muteEngineButton = audioControls.createEl("button", { cls: "cg-pilot-audio-btn", text: "Engine on", attr: { type: "button", "aria-pressed": "false", "aria-label": "Mute engine" } });
    this.muteAfterburnerButton = audioControls.createEl("button", { cls: "cg-pilot-audio-btn", text: "Afterburner on", attr: { type: "button", "aria-pressed": "false", "aria-label": "Mute afterburner" } });
    this.muteEngineButton.addEventListener("click", () => this.host.onAudioMute("engine", !this.opts.muteEngine));
    this.muteAfterburnerButton.addEventListener("click", () => this.host.onAudioMute("afterburner", !this.opts.muteAfterburner));
    const speed = this.hud.createDiv({ cls: "cg-pilot-speed" });
    this.speedFill = speed.createDiv({ cls: "cg-pilot-speed-fill" });
    const energy = this.hud.createDiv({ cls: "cg-pilot-energy" });
    this.energyFill = energy.createDiv({ cls: "cg-pilot-energy-fill" });
    const health = this.hud.createDiv({ cls: "cg-pilot-health" });
    this.healthFill = health.createDiv({ cls: "cg-pilot-health-fill" });
    this.destruction = this.hud.createDiv({ cls: "cg-pilot-destroyed", attr: { role: "status" } });
    this.readout.hidden = true;
    this.keysPanel = this.buildKeysPanel();
  }

  /** The controls, drawn as key caps in a quiet glass panel. The caps light up as you press the keys. */
  private buildKeysPanel(): HTMLDivElement {
    const panel = this.hud.createDiv({ cls: "cg-pilot-keys" });
    panel.createDiv({ cls: "cg-pilot-keys-title", text: "Flight controls" });
    for (const g of KEY_GROUPS) {
      const sec = panel.createDiv({ cls: "cg-pilot-keys-group" });
      sec.createDiv({ cls: "cg-pilot-keys-head", text: g.title });
      for (const row of g.rows) {
        const line = sec.createDiv({ cls: "cg-pilot-keys-row" });
        const caps = line.createDiv({ cls: "cg-pilot-keys-caps" });
        row.caps.forEach((c, i) => {
          const cap = createEl("kbd", { cls: "cg-key", text: c });
          caps.appendChild(cap);
          const code = row.codes[i];
          if (code) {
            const list = this.keyCaps.get(code) ?? []; list.push(cap); this.keyCaps.set(code, list);
            if (code === "ShiftLeft") this.keyCaps.set("ShiftRight", list);
          }
          if (c === "Click") this.clickCap = cap;
        });
        const label = line.createDiv({ cls: "cg-pilot-keys-label", text: typeof row.label === "string" ? row.label : "" });
        if (typeof row.label !== "string") this.keyLabels.push({ el: label, row });
      }
    }
    return panel;
  }

  private refreshKeyLabels(): void {
    for (const { el, row } of this.keyLabels) { const t = typeof row.label === "function" ? row.label(this) : row.label; if (el.textContent !== t) el.textContent = t; }
  }

  private lightKey(code: string, on: boolean): void { for (const el of this.keyCaps.get(code) ?? []) el.classList.toggle("cg-down", on); }

  private showKeys(show: boolean): void {
    this.keysShown = show; this.keysQuiet = false; this.keysQuietAt = this.clock + 9000;
    this.keysPanel.hidden = !show; this.keysPanel.classList.remove("cg-quiet");
  }
  private keysQuietAt = 0;

  // ----------------------------------------------------------------- lifecycle

  setOptions(opts: PilotOptions): void {
    const mouseChanged = opts.mouse !== this.opts.mouse;
    const multiplayerChanged = opts.multiplayer !== this.opts.multiplayer;
    this.opts = { ...opts };
    if (multiplayerChanged) {
      this.lastShot = { i: -1, t: -1e9 }; this.aimDestination = null; this.bolts.length = 0; this.warp = null; this.cooldown = 0;
      if (opts.multiplayer) this.fireSequence = 0;
    }
    if (mouseChanged && this.active) {
      this.stick.set(0, 0); this.mouseDX = this.mouseDY = this.smX = this.smY = 0;
      if (opts.mouse === "cursor" && this.locked) document.exitPointerLock();
      else if (opts.mouse === "capture") this.requestLock();
      this.applyLook(); this.setHint();
    }
    this.audio.setOptions(opts.sound, opts.volume);
    this.audio.setEngineMuted(opts.muteEngine);
    this.audio.setAfterburnerMuted(opts.muteAfterburner);
    this.muteEngineButton.textContent = opts.muteEngine ? "Engine muted" : "Engine on";
    this.muteEngineButton.setAttribute("aria-pressed", String(opts.muteEngine));
    this.muteAfterburnerButton.textContent = opts.muteAfterburner ? "Afterburner muted" : "Afterburner on";
    this.muteAfterburnerButton.setAttribute("aria-pressed", String(opts.muteAfterburner));
    if (this.active) this.cruise = this.cruiseSpeed();
    this.applyLook();
  }

  /**
   * Cruise speed in scene units per second. The network's size in the scene grows with the number of notes, but the time it
   * should take to cross it grows more slowly, so cruise speed is set from a target crossing time:
   * about 12 s for 100 notes, 17 s for 1,000, 24 s for 10,000 (never under 10 s or over 60 s), times the speed setting.
   */
  private cruiseSpeed(): number {
    if (this.opts.multiplayer) return 100;
    const b = this.host.bounds(), n = Math.max(20, this.host.nodes().length);
    const crossSeconds = clamp(CROSS_BASE * Math.pow(n / 100, CROSS_GROWTH), CROSS_MIN, CROSS_MAX);
    return Math.max(MIN_CRUISE, (2 * b.radius) / crossSeconds) * this.opts.speed;
  }

  /** Show or hide the plane and the wireframe dressing to match the options. */
  private applyLook(): void {
    const on = this.active && this.health > 0;
    this.ship.group.visible = on && this.opts.view === "chase";
    this.ship.lights.forEach(l => { l.visible = on && this.opts.view === "chase"; });
    this.cockpit.group.visible = on && this.opts.view === "cockpit";
    this.ringOuter.hidden = this.ringInner.hidden = !(on && this.opts.mouse === "cursor");
    this.refreshKeyLabels();
    this.container.classList.toggle("cg-cursor", on && this.opts.mouse === "cursor");
    this.ship.outline.opacity = this.opts.wireframe ? 0.9 : 0;
    for (const s of this.shells) s.visible = on && this.opts.wireframe;
    if (!(on && this.opts.wireframe)) { this.aimReticle.visible = false; this.lockReticle.visible = false; }
  }

  private get chase(): boolean { return this.opts.view === "chase"; }

  /** True when the pointer stays visible and steers by its distance from the centre. */
  get cursorMode(): boolean { return this.opts.mouse === "cursor"; }
  get multiplayer(): boolean { return this.opts.multiplayer; }

  get locked(): boolean { return document.pointerLockElement === this.canvas; }
  get cockpitView(): boolean { return !this.chase; }

  acknowledgeShot(sequence: number): void {
    this.bolts = this.bolts.filter(bolt => bolt.sequence !== sequence);
  }

  clearTarget(): void {
    this.lastShot = { i: -1, t: -1e9 };
    if (this.aim !== -1) { this.aim = -1; this.host.setAim(-1); }
    this.readout.hidden = true;
  }

  applyAuthorityPose(pose: Pose): void {
    const wasAlive = this.health > 0;
    const target = new THREE.Vector3(...pose.position);
    this.pos.lerp(target, this.active ? 0.45 : 1);
    this.quat.slerp(new THREE.Quaternion(...pose.rotation).normalize(), this.active ? 0.45 : 1);
    this.vel.set(...pose.velocity); this.energy = pose.energy; this.health = pose.health;
    this.boostLocked = pose.boostLocked; this.holdLeft = pose.boostHold; this.regenDelay = pose.regenDelay;
    this.respawnLeft = pose.respawnAt; this.protectionLeft = pose.protectedUntil;
    this.boosting = false;
    if (wasAlive !== (this.health > 0)) this.applyLook();
    this.updateHud(this.vel.length() / (this.cruise * BOOST_TOP));
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.roomVisible = true;
    this.vel.set(0, 0, 0); this.spin.set(0, 0, 0); this.stick.set(0, 0);
    this.keys.clear(); this.firing = false; this.warp = null; this.cooldown = 0;
    this.lastShot = { i: -1, t: -1e9 }; this.aim = -1; this.frame = 0; this.clock = 0;
    if (!this.opts.multiplayer) { this.energy = 1; this.health = 100; this.boostLocked = false; this.holdLeft = 0; this.regenDelay = 0; }
    this.boosting = false; this.bank = this.tilt = 0;
    this.shake = 0; this.mouseDX = this.mouseDY = this.smX = this.smY = 0; this.dtS = 0; this.networkAccumulator = 0;
    this.cursor.inside = false; this.ringW = this.ringH = 0;
    this.showKeys(true);
    this.cruise = this.cruiseSpeed();

    // start where the camera is looking from: the ship goes just ahead of it, so nothing jumps
    this.camQuat.copy(this.camera.quaternion);
    if (!this.opts.multiplayer) {
      this.quat.copy(this.camera.quaternion);
      this.pos.copy(this.camera.position);
      if (this.chase) this.pos.sub(this.tmpV.copy(CAM_OFFSET).applyQuaternion(this.quat));
    }

    this.container.classList.add("cg-piloting");
    this.hud.hidden = false;
    this.boltLines.visible = true;
    this.applyLook();
    this.refreshShells();
    this.setHint();

    this.container.addEventListener("keydown", this.onKeyDown, true);
    this.container.addEventListener("keyup", this.onKeyUp, true);
    this.container.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerenter", this.onPointerEnter);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("pointerlockerror", this.onLockError);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("focus", this.onWindowFocus);

    this.container.focus({ preventScroll: true });
    this.requestLock();
    this.audio.start();
    this.host.onState(true, "Pilot mode on. W A S D to fly, mouse to steer, click or F to fire, Shift for afterburner, P to leave.");
  }

  exit(say = true): void {
    if (!this.active) return;
    const notifyRoom = this.opts.multiplayer;
    this.active = false;
    this.container.removeEventListener("keydown", this.onKeyDown, true);
    this.container.removeEventListener("keyup", this.onKeyUp, true);
    this.container.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerenter", this.onPointerEnter);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    document.removeEventListener("pointerlockerror", this.onLockError);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("focus", this.onWindowFocus);
    if (this.locked) document.exitPointerLock();
    this.audio.stop();
    this.keys.clear(); this.firing = false; this.warp = null; this.bolts.length = 0;
    for (const list of this.keyCaps.values()) for (const el of list) el.classList.remove("cg-down");
    for (const b of this.bursts) b.line.visible = false;
    this.bursts.length = 0;
    this.boltLines.visible = false; this.boltLines.geometry.setDrawRange(0, 0);
    this.applyLook();
    this.hud.hidden = true;
    this.container.classList.remove("cg-piloting", "cg-cursor");
    this.host.setAim(-1); this.aim = -1;
    if (notifyRoom) this.host.onNetworkFrame({ thrust: 0, strafe: 0, lift: 0, roll: 0, pitch: 0, yaw: 0, boost: false, brake: false, fire: false, active: false });
    if (say) this.host.onState(false, "Pilot mode off");
    else this.host.onState(false, "");
  }

  setViewVisible(visible: boolean): void {
    this.roomVisible = visible;
    if (!visible) {
      this.keys.clear(); this.firing = false;
      if (this.active && this.opts.multiplayer) this.host.onNetworkFrame(this.networkInput());
    }
  }

  destroy(): void {
    this.exit(false);
    this.audio.destroy();
    const dispose = (o: THREE.Object3D) => {
      this.scene.remove(o);
      const l = o as THREE.LineSegments;
      (l.material as THREE.Material | undefined)?.dispose?.();
    };
    this.scene.remove(this.cockpit.group); this.cockpit.dispose();
    this.scene.remove(this.ship.group);
    this.ship.lights.forEach(l => this.scene.remove(l));
    this.ship.dispose();
    dispose(this.boltLines); this.boltLines.geometry.dispose();
    for (const r of [this.aimReticle, this.lockReticle]) { dispose(r); r.geometry.dispose(); }
    for (const s of this.shells) dispose(s);
    this.shellGeo.dispose();
    for (const b of this.bursts) dispose(b.line);
    this.burstGeo.dispose();
    this.hud.remove();
  }

  private requestLock(): void {
    if (this.opts.mouse !== "capture") return;
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => this.setHint());
    } catch { /* the hint tells the reader to click */ }
  }

  // ----------------------------------------------------------------- warp

  /** Fly to a note and stop in front of it, looking at it. */
  warpToNode(i: number): void {
    if (this.opts.multiplayer) return;
    const n = this.host.nodes()[i]; if (!n) return;
    const from = this.tmpV.copy(this.pos).sub(this.tmpV2.set(n.x, n.y, n.z));
    if (from.lengthSq() < 1) from.set(0.3, 0.2, 1);
    this.beginWarp(i, new THREE.Vector3(n.x, n.y, n.z), from.normalize().clone(), 70 + this.host.nodeRadius(i) * 6);
  }

  /** Back out to where the whole constellation fits in view. */
  returnToHub(): void {
    if (this.opts.multiplayer) return;
    const b = this.host.bounds();
    const c = new THREE.Vector3(b.cx, b.cy, b.cz);
    const from = this.tmpV.copy(this.pos).sub(c);
    if (from.lengthSq() < 1) from.set(0.4, 0.25, 1);
    this.beginWarp(-1, c, from.normalize().clone(), this.host.fitDistance(b.radius) - (this.chase ? CAM_OFFSET.z : 0));
  }

  /** A warp is fast, not instant: it takes time in proportion to the distance, so a long trip across a big vault is felt. */
  private beginWarp(node: number, centre: THREE.Vector3, dir: THREE.Vector3, dist: number): void {
    const p0 = this.pos.clone();
    const travel = p0.distanceTo(this.tmpV.copy(centre).addScaledVector(dir, dist));
    const dur = clamp(800 + (travel / (this.cruise * WARP_SPEED)) * 1000, WARP_MIN_MS, WARP_MAX_MS);
    this.warp = { t0: this.clock, dur, p0, q0: this.quat.clone(), node, centre, dir, dist };
    this.vel.set(0, 0, 0); this.spin.set(0, 0, 0); this.stick.set(0, 0);
    this.audio.warp(dur);
  }

  // ----------------------------------------------------------------- input

  private setHint(): void {
    // the controls are on the panel; this line only says what to do right now
    const text = this.opts.mouse === "cursor" || this.locked ? "" : "Click to take the mouse";
    this.hint.textContent = text; this.hint.hidden = !text;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Obsidian's shortcuts keep working
    if (e.code === "Escape") {
      // the first Esc is taken by the browser to release the mouse; if one reaches us the mouse is already free, so leave
      if (this.locked) { document.exitPointerLock(); }
      else if (performance.now() - this.unlockedAt > 200) this.host.leave();
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    if (!OWNED.has(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    this.keys.add(e.code);
    this.lightKey(e.code, true);
    switch (e.code) {
      case "KeyK": this.showKeys(!this.keysShown); break;
      case "KeyT": if (this.opts.multiplayer) { if (this.aimDestination) this.host.setNavigationTarget(this.aimDestination); } else this.toggleLock(); break;
      case "KeyG": {
        if (this.opts.multiplayer) { const target = this.host.navigationTarget(); if (target) this.host.requestFastTravel(target); }
        else { const t = this.host.selectedIndex() >= 0 ? this.host.selectedIndex() : this.aim; if (t >= 0) this.warpToNode(t); }
        break;
      }
      case "KeyH": this.returnToHub(); break;
      case "KeyV": this.opts = { ...this.opts, view: this.chase ? "cockpit" : "chase" }; this.applyLook(); this.host.onState(true, this.chase ? "Chase view" : "Cockpit view"); break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); this.lightKey(e.code, false); };
  private onBlur = () => { this.keys.clear(); this.firing = false; for (const list of this.keyCaps.values()) for (const el of list) el.classList.remove("cg-down"); };

  private toggleLock(): void {
    if (this.aim < 0) return;
    const on = this.host.selectedIndex() !== this.aim;
    this.host.select(on ? this.aim : -1);
    this.audio.lock(on);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (this.opts.mouse === "capture" && !this.locked) { this.requestLock(); return; }
    this.container.focus({ preventScroll: true });
    this.firing = true; this.clickCap?.classList.add("cg-down");
    this.fire(e.ctrlKey || e.metaKey);
  };
  private onPointerUp = () => { this.firing = false; this.clickCap?.classList.remove("cg-down"); };

  /** Cursor steering: remember where the pointer is over the scene. Over a panel or button the scene gets no events, so steering pauses there. */
  private onPointerMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.cursor.x = e.clientX - r.left; this.cursor.y = e.clientY - r.top; this.cursor.inside = true;
  };
  private onPointerEnter = () => {
    // coming back from a panel: give the keyboard back to the ship, unless the reader is typing somewhere
    const a = document.activeElement as HTMLElement | null;
    const typing = !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    if (this.opts.mouse === "cursor" && !typing) this.container.focus({ preventScroll: true });
  };
  private onPointerLeave = () => { this.cursor.inside = false; this.firing = false; };

  /** The mouse moves a virtual stick. The ship then turns at a rate set by the stick, and takes time to get there. */
  private onMouseMove = (e: MouseEvent) => {
    if (this.opts.mouse !== "capture" || !this.locked || this.warp) return;
    // a stray huge reading (the pointer being re-captured, a hiccup in the driver) must not become a huge turn
    this.mouseDX += clamp(e.movementX, -150, 150);
    this.mouseDY += clamp(e.movementY, -150, 150);
  };

  private onLockChange = () => {
    if (!this.locked) { this.unlockedAt = performance.now(); this.keys.clear(); this.firing = false; this.stick.set(0, 0); }
    this.setHint();
  };
  private onLockError = () => this.setHint();
  private onVisibility = () => {
    this.audio.mute(document.hidden);
    if (document.hidden) { this.keys.clear(); this.firing = false; if (this.active && this.opts.multiplayer) this.host.onNetworkFrame(this.networkInput()); }
  };
  private onWindowBlur = () => { this.audio.mute(true); this.cursor.inside = false; this.firing = false; this.keys.clear(); if (this.active && this.opts.multiplayer) this.host.onNetworkFrame(this.networkInput()); };
  private onWindowFocus = () => this.audio.mute(document.hidden);

  // ----------------------------------------------------------------- frame

  update(dt: number): void {
    if (!this.active) return;
    dt = Math.max(0, Math.min(0.1, dt));
    this.dtS = this.dtS ? this.dtS + (dt - this.dtS) * 0.25 : dt; // frame times from the browser are uneven; the ship should not be
    dt = this.dtS;
    const k = this.keys;
    this.frame++; this.clock += dt * 1000;
    this.networkAccumulator += dt;
    this.respawnLeft = Math.max(0, this.respawnLeft - dt * 1000);
    this.protectionLeft = Math.max(0, this.protectionLeft - dt * 1000);

    const thrust = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const lift = (k.has("Space") ? 1 : 0) - (k.has("KeyC") ? 1 : 0);
    const rollIn = (k.has("KeyQ") ? 1 : 0) - (k.has("KeyE") ? 1 : 0);
    const wantBoost = k.has("ShiftLeft") || k.has("ShiftRight");
    const brake = k.has("KeyX");

    if (this.warp) { this.stepWarp(); if (thrust || strafe || lift) this.warp = null; } // taking the controls cancels a warp
    const speed01 = clamp(this.vel.length() / (this.cruise * BOOST_TOP), 0, 1);

    // ---- afterburner: it burns an energy tank, and stays off when the tank runs dry until it has refilled a little
    const was = this.boosting;
    this.boosting = wantBoost && thrust > 0 && !this.boostLocked && this.energy > 0 && !this.warp;
    if (this.boosting) {
      this.energy -= BOOST_DRAIN * dt;
      this.regenDelay = BOOST_REGEN_DELAY;
      if (this.energy <= 0) { this.energy = 0; this.boostLocked = true; this.boosting = false; this.holdLeft = BOOST_HOLD; } // run dry: the tank stays empty for a while
    } else if (this.holdLeft > 0 || this.regenDelay > 0) {
      this.holdLeft = Math.max(0, this.holdLeft - dt); // empty and not refilling yet
      this.regenDelay = Math.max(0, this.regenDelay - dt);
    } else {
      this.energy = Math.min(1, this.energy + BOOST_REGEN * dt);
      if (this.boostLocked && this.energy >= BOOST_RELOCK) this.boostLocked = false;
    }
    if (this.boosting && !was) this.audio.afterburner();

    if (!this.warp) {
      this.turn(dt, rollIn, speed01);
      this.thrustAndDrag(dt, thrust, strafe, lift, brake);
      if (!this.opts.multiplayer) this.keepInRange(dt);
    }

    this.updateCamera(dt);
    const speed = this.vel.length();
    this.updateShip(dt, strafe, lift, clamp(speed / (this.cruise * BOOST_TOP), 0, 1));
    this.audio.update(Math.min(1, speed / (this.cruise * 1.6)), this.boosting, thrust !== 0 || strafe !== 0 || lift !== 0);

    this.updateAimPoint();
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.health > 0 && (this.firing || k.has("KeyF")) && this.cooldown <= 0 && (this.locked || k.has("KeyF") || this.opts.mouse === "cursor")) this.fire(false);

    if (this.frame % 2 === 0) this.updateAim();
    this.updateBolts(dt);
    this.updateWireframes(dt);
    this.updateHud(speed / (this.cruise * BOOST_TOP));
    if (this.opts.multiplayer && this.networkAccumulator >= 0.05) { this.networkAccumulator %= 0.05; this.host.onNetworkFrame(this.networkInput()); }
    if (this.keysShown && !this.keysQuiet && this.clock > this.keysQuietAt) { this.keysQuiet = true; this.keysPanel.classList.add("cg-quiet"); }
  }

  private networkInput(): FlightInput {
    return {
      thrust: (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0),
      strafe: (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      lift: (this.keys.has("Space") ? 1 : 0) - (this.keys.has("KeyC") ? 1 : 0),
      roll: (this.keys.has("KeyQ") ? 1 : 0) - (this.keys.has("KeyE") ? 1 : 0),
      pitch: this.stick.y, yaw: this.stick.x,
      boost: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"), brake: this.keys.has("KeyX"), fire: this.firing || this.keys.has("KeyF"),
      active: this.active && this.roomVisible && !document.hidden && document.hasFocus(),
    };
  }

  /**
   * Rotation. The stick asks for a turn rate; the ship can only change its spin so fast (rotational inertia), so a hard
   * flick builds up and a released stick keeps coming round for a moment before it settles. It turns less sharply at speed.
   */
  private turn(dt: number, rollIn: number, speed01: number): void {
    if (this.opts.mouse === "cursor") {
      this.steerWithCursor(dt);
    } else {
      // the mouse moved since the last frame: smooth it (so it does not arrive in lumps), and move the virtual stick
      const a = 1 - Math.exp(-dt * 40);
      this.smX += (this.mouseDX - this.smX) * a; this.smY += (this.mouseDY - this.smY) * a;
      this.mouseDX = 0; this.mouseDY = 0;
      const k = STICK_GAIN * this.opts.sensitivity;
      this.stick.x += -this.smX * k;
      this.stick.y += -this.smY * k * (this.opts.invertY ? -1 : 1);
      if (this.stick.length() > 1) this.stick.normalize();
      this.stick.multiplyScalar(Math.exp(-STICK_DECAY * dt));
    }

    if (this.opts.multiplayer) {
      this.spin.set(clamp(this.stick.y, -1, 1) * PITCH_RATE, clamp(this.stick.x, -1, 1) * YAW_RATE, rollIn * ROLL_RATE);
      this.quat.multiply(this.tmpQ.setFromAxisAngle(X_AXIS, this.spin.x * dt));
      this.quat.multiply(this.tmpQ.setFromAxisAngle(Y_AXIS, this.spin.y * dt));
      this.quat.multiply(this.tmpQ.setFromAxisAngle(Z_AXIS, this.spin.z * dt));
      this.quat.normalize();
      return;
    }

    // the spin eases toward the rate the stick asks for, and can change only so fast
    const agility = this.opts.agility * (1 - 0.3 * speed01) * (this.boosting ? 0.8 : 1);
    const cap = ANG_ACC * agility * dt, ease = 1 - Math.exp(-RESP * dt);
    const toward = (cur: number, target: number, c: number) => cur + clamp((target - cur) * ease, -c, c);
    this.spin.x = toward(this.spin.x, this.stick.y * PITCH_RATE * agility, cap);
    this.spin.y = toward(this.spin.y, this.stick.x * YAW_RATE * agility, cap);
    this.spin.z = toward(this.spin.z, rollIn * ROLL_RATE * agility, cap * 1.4);
    this.quat.multiply(this.tmpQ.setFromAxisAngle(X_AXIS, this.spin.x * dt));
    this.quat.multiply(this.tmpQ.setFromAxisAngle(Y_AXIS, this.spin.y * dt));
    this.quat.multiply(this.tmpQ.setFromAxisAngle(Z_AXIS, this.spin.z * dt));
    this.quat.normalize();
  }

  /**
   * Cursor steering: how far the pointer is from the middle of the scene is how hard the stick is pushed, with a dead zone in
   * the middle and a gentle curve so small movements are fine. With the pointer over a panel or outside the pane the stick
   * returns to centre, so the cursor is free to click things without the ship veering off. The ship still turns with its
   * usual weight: only where the stick comes from has changed.
   */
  private steerWithCursor(dt: number): void {
    let tx = 0, ty = 0;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.cursor.inside && !this.warp && w > 0 && h > 0) {
      const reach = Math.min(w, h) * CURSOR_REACH;
      const shape = (v: number) => {
        const m = Math.abs(v) * this.opts.sensitivity;
        return m <= DEAD_ZONE ? 0 : Math.sign(v) * Math.min(1, Math.pow((m - DEAD_ZONE) / (1 - DEAD_ZONE), 1.35));
      };
      tx = -shape((this.cursor.x - w / 2) / reach);
      ty = -shape((this.cursor.y - h / 2) / reach) * (this.opts.invertY ? -1 : 1);
    }
    const e = 1 - Math.exp(-CURSOR_EASE * dt);
    this.stick.x += (tx - this.stick.x) * e;
    this.stick.y += (ty - this.stick.y) * e;
  }

  /**
   * Translation. Thrust accelerates the ship along its own axes; drag grows with speed squared, so top speed is set by thrust
   * and a ship that lets go of the throttle coasts. The direction of travel swings toward the nose, so a turn carves
   * instead of sliding, and sharp turns bleed a little speed. The ship collides with the notes and bounces off.
   */
  private thrustAndDrag(dt: number, thrust: number, strafe: number, lift: number, brake: boolean): void {
    const q = this.quat, A = this.cruise * ACCEL;
    const fwd = this.fwdV.set(0, 0, -1).applyQuaternion(q);
    const right = this.tmpV2.set(1, 0, 0).applyQuaternion(q);
    const up = this.tmpV3.set(0, 1, 0).applyQuaternion(q);

    const main = thrust > 0 ? A * (this.boosting ? BOOST_ACCEL : 1) : thrust < 0 ? A * REVERSE : 0;
    this.vel.addScaledVector(fwd, main * Math.sign(thrust) * dt);
    this.vel.addScaledVector(right, strafe * A * SIDE * dt);
    this.vel.addScaledVector(up, lift * A * SIDE * dt);

    let sp = this.vel.length();
    if (brake && sp > 0) { const cut = Math.min(sp, A * RETRO * dt); this.vel.multiplyScalar((sp - cut) / sp); sp -= cut; }

    // drag: quadratic in speed, set so that the main engine alone holds cruise speed
    this.vel.divideScalar(1 + (A / (this.cruise * this.cruise)) * sp * dt);
    if (this.opts.multiplayer) { this.pos.addScaledVector(this.vel, dt); return; }
    this.vel.divideScalar(1 + TURN_BLEED * this.spin.length() * dt);

    // grip: turn the direction of travel toward the nose
    sp = this.vel.length();
    if (sp > 1) {
      const cos = this.vel.dot(fwd) / sp;
      if (cos > 0) {
        const g = 1 - Math.exp(-GRIP * dt);
        const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
        this.vel.divideScalar(sp).lerp(fwd, g).normalize().multiplyScalar(sp * (1 - GRIP_COST * sin * g));
      }
    }
    // move in small steps so a fast ship cannot pass straight through a note between frames
    const sub = clamp(Math.ceil((this.vel.length() * dt) / 0.8), 1, 40);
    let impact = 0, hit = -1;
    for (let s = 0; s < sub; s++) {
      this.pos.addScaledVector(this.vel, dt / sub);
      const r = this.collide();
      if (r.impact > impact) { impact = r.impact; hit = r.node; }
    }
    if (hit >= 0) this.bump(impact, hit);
  }

  /** Push the ship out of any note it is inside and bounce its velocity off. Returns how hard the worst impact was. */
  private collide(): { impact: number; node: number } {
    const nodes = this.host.nodes(), p = this.pos;
    let impact = 0, node = -1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], dx = p.x - n.x;
      const rad = this.host.nodeRadius(i) * HIT_SCALE + SHIP_RADIUS;
      if (dx > rad || dx < -rad) continue;
      const dy = p.y - n.y; if (dy > rad || dy < -rad) continue;
      const dz = p.z - n.z; if (dz > rad || dz < -rad) continue;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rad * rad || !this.host.solid(i)) continue;
      const d = Math.sqrt(d2) || 1e-3;
      const nx = dx / d, ny = dy / d, nz = dz / d;
      p.x += nx * (rad - d); p.y += ny * (rad - d); p.z += nz * (rad - d);
      const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
      if (vn < 0) {
        this.vel.x -= (1 + BOUNCE) * vn * nx; this.vel.y -= (1 + BOUNCE) * vn * ny; this.vel.z -= (1 + BOUNCE) * vn * nz;
        if (-vn > impact) { impact = -vn; node = i; }
      }
    }
    return { impact, node };
  }

  /** The ship has hit a note: shake the view, kick the spin, flash a wireframe burst, and thud. */
  private bump(impact: number, node: number): void {
    const hard = clamp(impact / (this.cruise * BOOST_TOP), 0, 1);
    if (hard < BUMP_MIN) return;
    this.shake = Math.max(this.shake, Math.min(1, hard * 3));
    this.vel.multiplyScalar(1 - 0.25 * hard);
    this.spin.x += (Math.random() - 0.5) * 3 * hard; this.spin.y += (Math.random() - 0.5) * 3 * hard; this.spin.z += (Math.random() - 0.5) * 4 * hard;
    if (this.clock - this.lastBump > 150) { this.lastBump = this.clock; this.audio.bump(Math.min(1, hard * 3)); }
    this.spawnBurst(node);
  }

  /** The ship cannot wander off into nothing: past four radii a soft spring pulls it back, and it loses the speed it was carrying outward. */
  private keepInRange(dt: number): void {
    const b = this.cachedBounds();
    const off = this.tmpV.set(b.cx, b.cy, b.cz).sub(this.pos);
    const d = off.length(), lim = Math.max(300, b.radius * 4);
    if (d <= lim) return;
    off.divideScalar(d);
    const outward = -this.vel.dot(off);
    if (outward > 0) this.vel.addScaledVector(off, outward * Math.min(1, 2 * dt));
    this.vel.addScaledVector(off, (d - lim) * 2 * dt);
  }

  private boundsAt = 0;
  private boundsCache: { cx: number; cy: number; cz: number; radius: number } | null = null;
  private cachedBounds() {
    // bounds() sorts every note, so ask at most twice a second
    const now = performance.now();
    if (!this.boundsCache || now - this.boundsAt > 500) { this.boundsCache = this.host.bounds(); this.boundsAt = now; }
    return this.boundsCache;
  }

  private stepWarp(): void {
    const w = this.warp!;
    const t = Math.min(1, (this.clock - w.t0) / w.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in and out: a long jump spools up and slows down
    const nodes = this.host.nodes();
    let target = w.centre;
    if (w.node >= 0 && nodes[w.node]) { const n = nodes[w.node]; target = this.tmpV2.set(n.x, n.y, n.z); } // the note keeps drifting; keep aiming at it
    const p1 = this.tmpV.copy(target).addScaledVector(w.dir, w.dist);
    this.tmpM.lookAt(p1, target, Y_AXIS);
    this.tmpQ2.setFromRotationMatrix(this.tmpM);
    this.pos.lerpVectors(w.p0, p1, e);
    this.quat.copy(w.q0).slerp(this.tmpQ2, Math.min(1, e * 1.6)); // turn to face the target early in the jump
    if (t >= 1) this.warp = null;
  }

  // ----------------------------------------------------------------- camera and the plane

  /** The chase camera trails the ship's orientation, so a turn swings the plane away from the middle of the screen before the view catches up. */
  private updateCamera(dt: number): void {
    const chase = this.chase, cam = this.camera;
    const rate = !chase ? 90 : this.warp ? 11 : CAM_RATE;
    this.camQuat.slerp(this.quat, 1 - Math.exp(-rate * dt));
    cam.quaternion.copy(this.camQuat);
    cam.position.copy(this.pos);
    if (chase) cam.position.add(this.tmpV.copy(CAM_OFFSET).setZ(this.opts.multiplayer ? 6.5 : CAM_OFFSET.z).applyQuaternion(this.camQuat));
    const rattle = (this.boosting ? 0.07 : 0) + this.shake * 0.6; // afterburner rattle, and the jolt of an impact
    if (rattle > 0) cam.position.add(this.tmpV.set(Math.random() - 0.5, Math.random() - 0.5, 0).multiplyScalar(rattle).applyQuaternion(this.camQuat));
    this.shake = Math.max(0, this.shake - dt * 2.5);
    if (!chase) { // the cockpit sits in front of the camera
      const c = this.cockpit.group;
      c.position.copy(cam.position); c.quaternion.copy(cam.quaternion);
      // scaled up so it sits beyond the camera's near plane (1 unit); the same angles on screen, just further away
      c.scale.set(COCKPIT_SCALE * Math.max(0.55, cam.aspect / 1.78), COCKPIT_SCALE, COCKPIT_SCALE);
      c.updateMatrixWorld(true);
    }
    cam.updateMatrixWorld(); // so aiming and firing use where the ship is now, not where it was last frame
  }

  /** Put the plane at the ship's position, leaning into turns and strafes, with its flames following the throttle. */
  private updateShip(dt: number, strafe: number, lift: number, speed01: number): void {
    const s = 1 - Math.exp(-dt * 8);
    this.bank += (clamp(this.spin.y * 0.32, -0.85, 0.85) - strafe * 0.22 - this.bank) * s;
    this.tilt += (clamp(this.spin.x * 0.14, -0.4, 0.4) + lift * 0.1 - this.tilt) * s;
    if (!this.chase) return;

    const g = this.ship.group;
    g.position.copy(this.pos);
    g.quaternion.copy(this.quat).multiply(this.tmpQ.setFromEuler(this.tmpE.set(this.tilt, 0, this.bank)));
    g.scale.setScalar(SHIP_SCALE * (this.opts.multiplayer ? 2 : 1));
    g.updateMatrixWorld(true);

    const len = 0.35 + speed01 * 2.0 + (this.boosting ? 1.2 : 0), flick = 1 + Math.sin(this.clock * 0.09) * 0.08;
    for (const f of this.ship.flames) f.scale.set(1 + speed01 * 0.5, len * flick, 1 + speed01 * 0.5);
    (this.ship.flames[0].material as THREE.MeshBasicMaterial).opacity = 0.55 + speed01 * 0.4;
  }

  /** Where the nose points, on screen: that is where the crosshair is drawn and what the guns aim at. */
  private updateAimPoint(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return; // the pane has no size right now (hidden or collapsed)
    const fwd = this.fwdV.set(0, 0, -1).applyQuaternion(this.quat);
    const v = this.tmpV4.copy(this.pos).addScaledVector(fwd, AIM_DIST).project(this.camera);
    const behind = v.z > 1;
    this.aimX = clamp((v.x * 0.5 + 0.5) * w, -50, w + 50);
    this.aimY = clamp((-v.y * 0.5 + 0.5) * h, -50, h + 50);
    this.cross.style.opacity = behind ? "0" : "1";
    this.cross.style.transform = `translate(${this.aimX.toFixed(1)}px, ${this.aimY.toFixed(1)}px)`;
    this.readout.style.transform = `translate(${this.aimX.toFixed(1)}px, ${(this.aimY + 30).toFixed(1)}px) translateX(-50%)`;
  }

  private updateHud(top01: number): void {
    if (this.opts.mouse === "cursor") { // the two rings: the dead zone, and where the turn is at full rate
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (w !== this.ringW || h !== this.ringH) {
        this.ringW = w; this.ringH = h;
        const reach = Math.min(w, h) * CURSOR_REACH;
        const sens = Math.max(0.2, this.opts.sensitivity);
        this.ringInner.style.width = this.ringInner.style.height = `${(2 * reach * DEAD_ZONE / sens).toFixed(0)}px`;
        this.ringOuter.style.width = this.ringOuter.style.height = `${(2 * reach / sens).toFixed(0)}px`;
      }
    }
    this.speedFill.style.width = (clamp(top01, 0, 1) * 100).toFixed(1) + "%";
    this.energyFill.style.width = (this.energy * 100).toFixed(1) + "%";
    this.healthFill.style.width = (clamp(this.health / 100, 0, 1) * 100).toFixed(1) + "%";
    this.energyFill.classList.toggle("cg-low", this.boostLocked);
    this.destruction.hidden = this.health > 0;
    if (this.health <= 0) this.destruction.textContent = `SHIP DESTROYED · RESPAWNING IN ${Math.ceil(this.respawnLeft / 1000)}s`;
    const text = this.health <= 0 ? "DESTROYED" : this.protectionLeft > 0 ? "SPAWN PROTECTED" : this.boosting ? "AFTERBURNER" : this.boostLocked ? (this.holdLeft > 0 ? `EMPTY ${this.holdLeft.toFixed(1)}s` : "RECHARGING") : "";
    if (text !== this.flagsText) { this.flagsText = text; this.flags.textContent = text; }
  }

  // ----------------------------------------------------------------- aim and fire

  private updateAim(): void {
    if (this.opts.multiplayer) {
      this.aim = -1; this.host.setAim(-1);
      this.aimDestination = this.host.pickDestinationAt(this.aimX, this.aimY, AIM_SLACK);
      this.readout.hidden = true;
      return;
    }
    const i = this.host.pickAt(this.aimX, this.aimY, AIM_SLACK);
    if (i !== this.aim) { this.aim = i; this.host.setAim(i); if (i >= 0) this.audio.tick(); }
    const n = i >= 0 ? this.host.nodes()[i] : null;
    this.readout.hidden = !n;
    if (!n) return;
    const dist = this.camera.position.distanceTo(this.tmpV.set(n.x, n.y, n.z));
    if (this.readName.textContent !== n.name) this.readName.textContent = n.name;
    this.readMeta.textContent = `${this.host.groupLabel(n.gi)} · ${n.deg} ${n.deg === 1 ? "link" : "links"} · ${Math.round(dist)} away`;
  }

  /** World position of one of the four guns (or of an imagined gun beside the ship in cockpit view). */
  private muzzle(gun: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.chase) return out.copy(this.ship.muzzles[gun % this.ship.muzzles.length]).applyMatrix4(this.ship.group.matrixWorld);
    return out.copy(this.cockpit.tips[gun % this.cockpit.tips.length]).applyMatrix4(this.cockpit.group.matrixWorld);
  }

  private fire(ctrl: boolean): void {
    if (this.health <= 0 || this.cooldown > 0) return;
    this.cooldown = FIRE_GAP;
    const point = new THREE.Vector3(0, 0, -RANGE).applyQuaternion(this.quat).add(this.pos);
    // guns fire in a rotating pattern: upper-left, lower-right, upper-right, lower-left
    const order = [0, 3, 1, 2], gun = order[this.gun++ % 4];
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
    if (this.opts.multiplayer) {
      const sequence = ++this.fireSequence;
      this.bolts.push({ from: this.muzzle(gun, new THREE.Vector3()), node: -1, point, travelled: 0, ctrl: false, landed: false, fade: 0, sequence });
      this.host.onFire(sequence, gun, point.toArray() as [number, number, number]);
    } else {
      const i = this.host.pickAt(this.aimX, this.aimY, FIRE_SLACK);
      this.bolts.push({ from: this.muzzle(gun, new THREE.Vector3()), node: i, point, travelled: 0, ctrl, landed: false, fade: 0 });
    }
    this.audio.laser(gun);
  }

  /** A bolt has reached the note it was aimed at. The first hit selects it; a second hit soon after opens it. */
  private land(b: Bolt): void {
    const i = b.node;
    this.audio.hit();
    this.spawnBurst(i);
    if (b.ctrl) { this.host.open(i, true); return; }
    const now = this.clock;
    if (this.lastShot.i === i && now - this.lastShot.t < DOUBLE_HIT_MS && this.host.selectedIndex() === i) {
      this.lastShot = { i: -1, t: -1e9 };
      this.audio.open();
      this.host.open(i, false); // the second hit on the same note opens it
      return;
    }
    this.lastShot = { i, t: now };
    this.host.select(i);
  }

  private updateBolts(dt: number): void {
    const nodes = this.host.nodes();
    const fwd = this.tmpV3.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let out = 0;
    for (let k = this.bolts.length - 1; k >= 0; k--) {
      const b = this.bolts[k];
      const n = b.node >= 0 ? nodes[b.node] : null;
      const end = n ? this.tmpV2.set(n.x, n.y, n.z) : b.point;
      const dir = this.tmpV.copy(end).sub(b.from), dist = dir.length() || 1;
      dir.divideScalar(dist);
      if (!b.landed) {
        b.travelled += (BOLT_SPEED + this.vel.length()) * dt; // a bolt inherits the ship's speed, so it never lags behind a fast ship
        if (b.travelled >= dist) { b.landed = true; b.travelled = dist; if (b.node >= 0) this.land(b); }
      } else { b.fade += dt; if (b.fade >= BOLT_FADE) { this.bolts.splice(k, 1); continue; } }
      if (out >= MAX_BOLTS) continue;
      const head = Math.min(b.travelled, dist), tail = Math.max(0, head - BOLT_LENGTH);
      const f = b.landed ? 1 - b.fade / BOLT_FADE : 1;
      const side = this.tmpV4.crossVectors(dir, fwd).normalize().multiplyScalar(0.07); // sideways to the bolt, as the camera sees it
      for (let w = -1; w <= 1; w++) {
        const o = (out * 3 + (w + 1)) * 6, core = w === 0;
        const ox = side.x * w, oy = side.y * w, oz = side.z * w;
        this.boltPos[o] = b.from.x + dir.x * tail + ox; this.boltPos[o + 1] = b.from.y + dir.y * tail + oy; this.boltPos[o + 2] = b.from.z + dir.z * tail + oz;
        this.boltPos[o + 3] = b.from.x + dir.x * head + ox; this.boltPos[o + 4] = b.from.y + dir.y * head + oy; this.boltPos[o + 5] = b.from.z + dir.z * head + oz;
        // red outside, white-hot core; dim at the tail, bright at the head
        const r = 1.0, gC = core ? 0.65 : 0.12, bC = core ? 0.55 : 0.08;
        this.boltCol[o] = r * 0.2 * f; this.boltCol[o + 1] = gC * 0.2 * f; this.boltCol[o + 2] = bC * 0.2 * f;
        this.boltCol[o + 3] = r * f; this.boltCol[o + 4] = gC * f; this.boltCol[o + 5] = bC * f;
      }
      out++;
    }
    const geo = this.boltLines.geometry;
    geo.setDrawRange(0, out * 3 * 2);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ----------------------------------------------------------------- wireframe dressing

  private wireMaterial(color: number | string, opacity: number): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  }

  /** A burst of wireframe where a bolt lands: an icosahedron that swells and fades. */
  private spawnBurst(i: number): void {
    if (!this.opts.wireframe) return;
    const n = this.host.nodes()[i]; if (!n) return;
    let b = this.bursts.find(x => !x.line.visible);
    if (!b && this.bursts.length < MAX_BURSTS) {
      const line = new THREE.LineSegments(this.burstGeo, this.wireMaterial(0xffb27a, 0.9));
      line.renderOrder = 4; line.frustumCulled = false;
      this.scene.add(line);
      b = { age: 0, pos: new THREE.Vector3(), size: 1, line };
      this.bursts.push(b);
    }
    if (!b) b = this.bursts[0];
    b.age = 0; b.pos.set(n.x, n.y, n.z); b.size = Math.max(3, this.host.nodeRadius(i) * 2);
    b.line.visible = true;
  }

  private refreshShells(): void {
    const list = this.host.clusters().slice(0, MAX_SHELLS);
    while (this.shells.length < list.length) {
      const s = new THREE.LineSegments(this.shellGeo, this.wireMaterial(0xffffff, 0.14));
      s.renderOrder = 0; s.frustumCulled = false; s.visible = false;
      this.scene.add(s); this.shells.push(s);
    }
    this.shells.forEach((s, k) => {
      const c = list[k];
      s.visible = !!c && this.active && this.opts.wireframe;
      if (!c) return;
      s.position.set(c.x, c.y, c.z); s.scale.setScalar(c.r);
      (s.material as THREE.LineBasicMaterial).color.set(c.color);
    });
  }

  private updateWireframes(dt: number): void {
    if (this.frame % SHELL_EVERY === 0) this.refreshShells();
    const on = this.opts.wireframe;
    for (const s of this.shells) if (s.visible) { s.rotation.y += dt * 0.05; s.rotation.x += dt * 0.02; }

    const nodes = this.host.nodes();
    const place = (r: THREE.LineSegments, i: number, grow: number, spin: number) => {
      const n = nodes[i];
      if (!on || !n) { r.visible = false; return; }
      const dist = this.camera.position.distanceTo(this.tmpV.set(n.x, n.y, n.z));
      r.visible = true;
      r.position.set(n.x, n.y, n.z);
      r.scale.setScalar(Math.max(this.host.nodeRadius(i) * 2.2, dist * 0.028) * grow);
      r.rotation.y += dt * spin; r.rotation.x += dt * spin * 0.6;
    };
    place(this.aimReticle, this.aim, 1, 1.3);
    place(this.lockReticle, this.host.selectedIndex(), 1.45, -0.9);

    for (const b of this.bursts) {
      if (!b.line.visible) continue;
      b.age += dt;
      const t = b.age / 0.45;
      if (t >= 1) { b.line.visible = false; continue; }
      b.line.position.copy(b.pos);
      b.line.scale.setScalar(b.size * (0.6 + 5 * (1 - Math.pow(1 - t, 3))));
      (b.line.material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - t);
    }
  }
}
