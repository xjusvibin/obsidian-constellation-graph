/**
 * Remappable keys for Pilot mode. Every action has a default key (a KeyboardEvent code). A reader can bind an action to another key;
 * the pilot then turns each physical key into the action's default code before it does anything else, so all the flight code keeps
 * working with the default codes.
 */
export interface KeyAction { id: string; label: string; code: string }

export const KEY_ACTIONS: KeyAction[] = [
  { id: "forward", label: "Thrust", code: "KeyW" },
  { id: "back", label: "Reverse", code: "KeyS" },
  { id: "left", label: "Strafe left", code: "KeyA" },
  { id: "right", label: "Strafe right", code: "KeyD" },
  { id: "up", label: "Up", code: "Space" },
  { id: "down", label: "Down", code: "KeyC" },
  { id: "rollLeft", label: "Roll left", code: "KeyQ" },
  { id: "rollRight", label: "Roll right", code: "KeyE" },
  { id: "boost", label: "Afterburner", code: "ShiftLeft" },
  { id: "brake", label: "Brake", code: "KeyX" },
  { id: "fire", label: "Fire", code: "KeyF" },
  { id: "weapon", label: "Switch weapon", code: "KeyR" },
  { id: "missile", label: "Missile", code: "KeyM" },
  { id: "lock", label: "Lock a pilot", code: "KeyT" },
  { id: "warp", label: "Warp to target", code: "KeyG" },
  { id: "hub", label: "Back to the hub", code: "KeyH" },
  { id: "fold", label: "Fold a group", code: "KeyB" },
  { id: "view", label: "Chase or cockpit view", code: "KeyV" },
  { id: "watch", label: "Watch other pilots", code: "KeyN" },
  { id: "keys", label: "Show or hide the controls", code: "KeyK" },
  { id: "volDown", label: "Volume down", code: "Minus" },
  { id: "volUp", label: "Volume up", code: "Equal" },
];

/** Keys that can never be bound: they leave Pilot mode, free the mouse, or are how the plugin itself is controlled. */
export const RESERVED = new Set(["Escape", "KeyP", "Tab", "F5", "F11", "F12", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ContextMenu"]);

export type Bindings = Record<string, string>;

const actionIds = new Set(KEY_ACTIONS.map(a => a.id));
const goodCode = (c: unknown): c is string => typeof c === "string" && c.length > 0 && c.length <= 20 && /^[A-Za-z0-9]+$/.test(c) && !RESERVED.has(c);

/** Read stored bindings: only known actions, only plain key codes that are allowed, and no key bound to two actions (the first one keeps it). */
export function sanitizeBindings(raw: unknown): Bindings {
  const out: Bindings = {};
  if (!raw || typeof raw !== "object") return out;
  const used = new Set<string>();
  for (const a of KEY_ACTIONS) {
    const code = (raw as Record<string, unknown>)[a.id];
    if (!goodCode(code) || code === a.code || used.has(code)) continue;
    out[a.id] = code; used.add(code);
  }
  return out;
}

export interface Translator { toDefault: Map<string, string>; disabled: Set<string> }

/** From the bindings: which physical key means which default code, and which default keys no longer do anything of their own. */
export function buildTranslator(bindings: Bindings): Translator {
  const toDefault = new Map<string, string>(), disabled = new Set<string>();
  for (const a of KEY_ACTIONS) {
    const code = bindings[a.id];
    if (!code || code === a.code) continue;
    toDefault.set(code, a.code); disabled.add(a.code);
  }
  return { toDefault, disabled };
}

/** The default code for a pressed key: a rebound key becomes its action; a default key whose action moved is ignored (null). */
export function translateCode(t: Translator, code: string): string | null {
  const mapped = t.toDefault.get(code);
  if (mapped) return mapped;
  return t.disabled.has(code) ? null : code;
}

/** The key currently bound to an action. */
export function codeFor(bindings: Bindings, id: string): string { return bindings[id] ?? KEY_ACTIONS.find(a => a.id === id)?.code ?? ""; }

/** A short label for a key cap. */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const names: Record<string, string> = { Space: "Space", ShiftLeft: "Shift", ShiftRight: "Shift", Minus: "-", Equal: "=", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backquote: "`", Backslash: "\\", Enter: "Enter", Backspace: "Backspace" };
  return names[code] ?? code.replace(/^Numpad/, "Num ");
}

/** Bind an action to a key. Returns the new bindings, or an error message when the key is not allowed or belongs to another action. */
export function bindKey(bindings: Bindings, id: string, code: string): { bindings: Bindings } | { error: string } {
  if (!actionIds.has(id)) return { error: "Unknown action." };
  if (RESERVED.has(code)) return { error: `${keyLabel(code)} is kept for leaving Pilot mode and cannot be used.` };
  if (!goodCode(code)) return { error: "That key cannot be used." };
  for (const a of KEY_ACTIONS) if (a.id !== id && codeFor(bindings, a.id) === code) return { error: `${keyLabel(code)} is already used for "${a.label}". Change that one first.` };
  const next = { ...bindings };
  const def = KEY_ACTIONS.find(a => a.id === id)!.code;
  if (code === def) delete next[id]; else next[id] = code;
  return { bindings: next };
}
