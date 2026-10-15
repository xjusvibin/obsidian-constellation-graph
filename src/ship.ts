import * as THREE from "three";

export interface Ship {
  /** The fighter, nose toward -Z like the camera. Add it to the scene; the pilot positions it every frame. */
  group: THREE.Group;
  /** The lights that make the hull readable. They only touch lit materials, so the glowing notes are unaffected. */
  lights: THREE.Light[];
  /** Exhaust flames, one per engine; their length and brightness follow the throttle. */
  flames: THREE.Mesh[];
  /** Cannon tips on the four wings, in the ship's own space. */
  muzzles: THREE.Vector3[];
  /** The glowing wireframe outline drawn over the hull. */
  outline: THREE.LineBasicMaterial;
  dispose(): void;
}

const WING_SPREAD = 0.32; // how far the four wings fan out of the horizontal, in radians
export const SHIP_SCALE = 0.34;
export const MULTIPLAYER_SHIP_SCALE = SHIP_SCALE * 2;
export const SHIP_MUZZLES: readonly [number, number, number][] = [
  [-1.61, -0.51, -0.97], [-1.61, 0.51, -0.97], [1.61, -0.51, -0.97], [1.61, 0.51, -0.97],
];

/**
 * A small four-winged starfighter built from primitives, with a glowing wireframe outline over the hull.
 * Nothing is loaded from disk: the plugin ships no model files.
 */
export function buildShip(): Ship {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(o: T): T => { owned.push(o); return o; };

  // Transparent so it is drawn after the glowing notes (which ignore depth), never underneath them.
  const lit = (color: number, emissive: number, shininess = 50) =>
    own(new THREE.MeshPhongMaterial({ color, emissive, shininess, flatShading: true, transparent: true }));
  const hull = lit(0xdfe6f3, 0x0c1426);
  const dark = lit(0x3a4258, 0x06080f, 20);
  const glass = lit(0x55b4ff, 0x0b3a72, 140);
  const red = own(new THREE.MeshBasicMaterial({ color: 0xff4b3a, transparent: true }));
  const outline = own(new THREE.LineBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.9 }));

  /** Add a solid part and trace its hard edges in the glowing outline. */
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, place: (m: THREE.Mesh) => void, edges = true): THREE.Mesh => {
    const m = new THREE.Mesh(own(geo), mat);
    m.renderOrder = 6;
    place(m);
    if (edges) {
      const e = new THREE.LineSegments(own(new THREE.EdgesGeometry(geo, 25)), outline);
      e.renderOrder = 8;
      m.add(e);
    }
    group.add(m);
    return m;
  };

  // fuselage: a long nose cone into a round body
  part(new THREE.ConeGeometry(0.2, 1.7, 7), hull, m => { m.rotation.x = -Math.PI / 2; m.position.z = -0.9; });
  part(new THREE.CylinderGeometry(0.27, 0.3, 1.9, 8), hull, m => { m.rotation.x = Math.PI / 2; m.position.z = 0.5; });
  part(new THREE.SphereGeometry(0.25, 10, 8), glass, m => { m.scale.set(1, 0.75, 1.7); m.position.set(0, 0.24, -0.3); }, false);

  const flames: THREE.Mesh[] = [];
  const muzzles: THREE.Vector3[] = [];
  const flameMat = own(new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const flameGeo = own(new THREE.ConeGeometry(0.12, 1, 8));
  flameGeo.translate(0, 0.5, 0); // base at the origin, tip one unit along +Y

  // four wings in an X, each with a cannon on its tip and an engine at its root
  for (const side of [-1, 1]) {
    for (const up of [-1, 1]) {
      const tilt = WING_SPREAD * side * up;
      part(new THREE.BoxGeometry(1.5, 0.035, 0.95), hull, m => { m.position.set(side * 0.9, up * 0.28, 0.5); m.rotation.z = tilt; });
      part(new THREE.BoxGeometry(0.1, 0.05, 0.4), red, m => { m.position.set(side * 1.45, up * 0.47, 0.5); m.rotation.z = tilt; }, false);
      const tipX = side * 1.61, tipY = up * 0.51;
      part(new THREE.CylinderGeometry(0.03, 0.03, 1.7, 5), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(tipX, tipY, -0.1); }, false);
      muzzles.push(new THREE.Vector3(tipX, tipY, -0.97));
      part(new THREE.CylinderGeometry(0.15, 0.17, 1.0, 8), dark, m => { m.rotation.x = Math.PI / 2; m.position.set(side * 0.5, up * 0.2, 0.6); });
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.rotation.x = Math.PI / 2; // tip pointing away from the nose
      f.position.set(side * 0.5, up * 0.2, 1.1);
      f.renderOrder = 7;
      group.add(f); flames.push(f);
    }
  }

  const ambient = new THREE.AmbientLight(0x8fa4d0, 1.0);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 4, 3);

  return { group, lights: [ambient, sun], flames, muzzles, outline, dispose: () => { owned.forEach(o => o.dispose()); } };
}
