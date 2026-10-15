import * as THREE from "three";

export type ShipKind = "striker" | "dart" | "bulwark";
export const SHIP_KINDS: ShipKind[] = ["striker", "dart", "bulwark"];
export const SHIP_NAMES: Record<ShipKind, string> = { striker: "Striker", dart: "Dart", bulwark: "Bulwark" };
export function shipIndex(kind: ShipKind): number { return SHIP_KINDS.indexOf(kind); }
export function shipFromIndex(i: number): ShipKind { return SHIP_KINDS[i] ?? "striker"; }

/** Ship colours a pilot can choose (index 0 means "automatic": cyan for you, your place's colour for everyone else). */
export const SHIP_COLORS: { key: string; name: string; hex: string }[] = [
  { key: "auto", name: "Automatic", hex: "#7fe8ff" },
  { key: "orange", name: "Orange", hex: "#ffb347" }, { key: "violet", name: "Violet", hex: "#c792ff" }, { key: "green", name: "Green", hex: "#7dff9a" },
  { key: "rose", name: "Rose", hex: "#ff7a9a" }, { key: "gold", name: "Gold", hex: "#ffe14a" }, { key: "white", name: "White", hex: "#f2f6ff" }, { key: "red", name: "Red", hex: "#ff5a4a" },
  { key: "cyan", name: "Cyan", hex: "#7fe8ff" },
];
export function colorIndex(key: string): number { const i = SHIP_COLORS.findIndex(c => c.key === key); return i < 0 ? 0 : i; }

/** Tint a ship's outline and engine flames. */
export function paintShip(ship: Ship, hex: string): void {
  ship.outline.color.set(hex);
  const m = ship.flames[0]?.material as THREE.MeshBasicMaterial | undefined;
  if (m) m.color.set(hex).lerp(new THREE.Color(0xffffff), 0.35);
}

export interface Ship {
  kind: ShipKind;
  /** The ship, nose toward -Z like the camera. Add it to the scene; the pilot positions it every frame. */
  group: THREE.Group;
  /** The lights that make the hull readable. They only touch lit materials, so the glowing notes are unaffected. */
  lights: THREE.Light[];
  /** Exhaust flames, one per engine; their length and brightness follow the throttle. */
  flames: THREE.Mesh[];
  /** Cannon tips, in the ship's own space (always four, so the guns fire in the same pattern on every ship). */
  muzzles: THREE.Vector3[];
  /** The glowing wireframe outline drawn over the hull. */
  outline: THREE.LineBasicMaterial;
  dispose(): void;
}

/** One size for every ship, yours and everyone else's: a ship is the same size wherever it is, so distance reads as distance. */
export const SHIP_SCALE = 0.45;

const WING_SPREAD = 0.32; // the Striker's four wings fan out of the horizontal by this much, in radians

/** Everything a ship builder needs: owned resources, shared materials and a way to add solid parts with traced edges. */
function kit() {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(o: T): T => { owned.push(o); return o; };
  // Transparent so it is drawn after the glowing notes (which ignore depth), never underneath them.
  const lit = (color: number, emissive: number, shininess = 50) =>
    own(new THREE.MeshPhongMaterial({ color, emissive, shininess, flatShading: true, transparent: true, side: THREE.DoubleSide }));
  const outline = own(new THREE.LineBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.9 }));
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, place: (m: THREE.Mesh) => void, edges = true): THREE.Mesh => {
    const m = new THREE.Mesh(own(geo), mat);
    m.renderOrder = 6;
    place(m);
    if (edges) { const e = new THREE.LineSegments(own(new THREE.EdgesGeometry(geo, 25)), outline); e.renderOrder = 8; m.add(e); }
    group.add(m);
    return m;
  };
  const flames: THREE.Mesh[] = [];
  const flameMat = own(new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const flameGeo = own(new THREE.ConeGeometry(0.12, 1, 8));
  flameGeo.translate(0, 0.5, 0); // base at the origin, tip one unit along +Y
  const flame = (x: number, y: number, z: number, width = 1) => {
    const f = new THREE.Mesh(flameGeo, flameMat);
    f.rotation.x = Math.PI / 2; f.position.set(x, y, z); f.scale.set(width, 1, width); f.renderOrder = 7; // tip pointing away from the nose
    group.add(f); flames.push(f);
  };
  const tri = (pts: number[]) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); g.computeVertexNormals(); return g; };
  return { group, own, lit, outline, part, flames, flame, tri, owned };
}

function finish(kind: ShipKind, k: ReturnType<typeof kit>, muzzles: THREE.Vector3[]): Ship {
  const ambient = new THREE.AmbientLight(0x8fa4d0, 0.7);
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(2, 4, 3);
  return { kind, group: k.group, lights: [ambient, sun], flames: k.flames, muzzles, outline: k.outline, dispose: () => { k.owned.forEach(o => o.dispose()); } };
}

/** Striker: a four-winged fighter. Balanced, and the one the plugin shipped with. */
function striker(): Ship {
  const k = kit();
  const hull = k.lit(0xdfe6f3, 0x0c1426), dark = k.lit(0x3a4258, 0x06080f, 20), glass = k.lit(0x55b4ff, 0x0b3a72, 140);
  const red = k.own(new THREE.MeshBasicMaterial({ color: 0xff4b3a, transparent: true }));
  k.part(new THREE.ConeGeometry(0.2, 1.7, 7), hull, m => { m.rotation.x = -Math.PI / 2; m.position.z = -0.9; });
  k.part(new THREE.CylinderGeometry(0.27, 0.3, 1.9, 8), hull, m => { m.rotation.x = Math.PI / 2; m.position.z = 0.5; });
  k.part(new THREE.SphereGeometry(0.25, 10, 8), glass, m => { m.scale.set(1, 0.75, 1.7); m.position.set(0, 0.24, -0.3); }, false);
  const muzzles: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (const up of [-1, 1]) {
      const tilt = WING_SPREAD * side * up;
      k.part(new THREE.BoxGeometry(1.5, 0.035, 0.95), hull, m => { m.position.set(side * 0.9, up * 0.28, 0.5); m.rotation.z = tilt; });
      k.part(new THREE.BoxGeometry(0.1, 0.05, 0.4), red, m => { m.position.set(side * 1.45, up * 0.47, 0.5); m.rotation.z = tilt; }, false);
      const tipX = side * 1.61, tipY = up * 0.51;
      k.part(new THREE.CylinderGeometry(0.03, 0.03, 1.7, 5), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(tipX, tipY, -0.1); }, false);
      muzzles.push(new THREE.Vector3(tipX, tipY, -0.97));
      k.part(new THREE.CylinderGeometry(0.15, 0.17, 1.0, 8), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(side * 0.5, up * 0.2, 0.6); });
      k.flame(side * 0.5, up * 0.2, 1.1);
    }
  }
  return finish("striker", k, muzzles);
}

/** Dart: a slim delta-wing interceptor with twin tail fins and one big engine. */
function dart(): Ship {
  const k = kit();
  const hull = k.lit(0x4b5268, 0x0a0d18, 70), light = k.lit(0xaab4d0, 0x10152a), glass = k.lit(0xb58cff, 0x2c1260, 140);
  const trim = k.own(new THREE.MeshBasicMaterial({ color: 0xc792ff, transparent: true }));
  k.part(new THREE.ConeGeometry(0.15, 2.2, 6), light, m => { m.rotation.x = -Math.PI / 2; m.position.z = -1.0; });
  k.part(new THREE.CylinderGeometry(0.2, 0.26, 1.7, 8), hull, m => { m.rotation.x = Math.PI / 2; m.position.z = 0.6; });
  k.part(new THREE.SphereGeometry(0.2, 10, 8), glass, m => { m.scale.set(1, 0.7, 2.2); m.position.set(0, 0.2, -0.2); }, false);
  const muzzles: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    // the big swept wing, as two flat triangles (the order of the points keeps it facing the right way)
    k.part(side > 0 ? k.tri([0, 0, -0.5, side * 2.0, -0.02, 1.35, 0, 0, 1.35]) : k.tri([0, 0, -0.5, 0, 0, 1.35, side * 2.0, -0.02, 1.35]), hull, () => undefined);
    // a tail fin standing on the wing tip, and a trim stripe along the wing
    k.part(side > 0 ? k.tri([side * 1.75, 0.02, 0.5, side * 1.95, 0.7, 1.35, side * 1.75, 0.02, 1.35]) : k.tri([side * 1.75, 0.02, 0.5, side * 1.75, 0.02, 1.35, side * 1.95, 0.7, 1.35]), light, () => undefined);
    k.part(new THREE.BoxGeometry(0.9, 0.02, 0.05), trim, m => { m.position.set(side * 1.1, 0.02, 0.8); m.rotation.y = side * -0.5; }, false);
    // two guns on each wing
    for (const [x, z] of [[0.95, -0.25], [1.7, 0.45]] as [number, number][]) {
      k.part(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), hull, m => { m.rotation.x = Math.PI / 2; m.position.set(side * x, 0, z - 0.2); }, false);
      muzzles.push(new THREE.Vector3(side * x, 0, z - 0.68));
    }
  }
  k.part(new THREE.CylinderGeometry(0.24, 0.3, 0.7, 8), hull, m => { m.rotation.x = Math.PI / 2; m.position.set(0, 0, 1.5); });
  k.flame(0, 0, 1.85, 1.9);
  return finish("dart", k, muzzles);
}

/** Bulwark: a broad, heavy gunship with twin engine pods and four cannons in the nose. */
function bulwark(): Ship {
  const k = kit();
  const hull = k.lit(0xc9b98f, 0x16130a, 30), dark = k.lit(0x4a4636, 0x090806, 20), glass = k.lit(0xffb35a, 0x6a3a0a, 140);
  const trim = k.own(new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true }));
  k.part(new THREE.BoxGeometry(1.15, 0.52, 2.3), hull, m => { m.position.set(0, 0, 0.3); });
  k.part(new THREE.ConeGeometry(0.62, 1.1, 4), hull, m => { m.rotation.set(-Math.PI / 2, 0, Math.PI / 4); m.scale.set(1, 1, 0.55); m.position.set(0, 0, -1.4); });
  k.part(new THREE.SphereGeometry(0.3, 10, 8), glass, m => { m.scale.set(1.1, 0.7, 1.5); m.position.set(0, 0.34, -0.25); }, false);
  const muzzles: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    k.part(new THREE.BoxGeometry(1.1, 0.08, 0.85), hull, m => { m.position.set(side * 0.95, -0.05, 0.2); m.rotation.z = side * -0.12; });
    k.part(new THREE.BoxGeometry(0.12, 0.06, 0.5), trim, m => { m.position.set(side * 1.45, -0.1, 0.2); m.rotation.z = side * -0.12; }, false);
    k.part(new THREE.CylinderGeometry(0.28, 0.32, 1.7, 8), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(side * 0.95, -0.08, 0.75); });
    k.flame(side * 0.95, -0.08, 1.6, 1.8);
    for (const y of [0.17, -0.17]) {
      k.part(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 6), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(side * 0.42, y, -1.3); }, false);
      muzzles.push(new THREE.Vector3(side * 0.42, y, -1.88));
    }
  }
  return finish("bulwark", k, muzzles);
}

/**
 * A small starfighter built from primitives, with a glowing wireframe outline over the hull. Nothing is loaded from disk:
 * the plugin ships no model files. The three ships differ only in looks; they fly and fight the same.
 */
export function buildShip(kind: ShipKind = "striker"): Ship {
  return kind === "dart" ? dart() : kind === "bulwark" ? bulwark() : striker();
}
