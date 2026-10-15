import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** What the layout tells the picture: where the hole is, how big, how much of the graph it has swallowed. */
export interface HoleState {
  active: boolean;
  x: number; y: number; z: number;
  /** The horizon radius in scene units. */
  rh: number;
  /** The share of notes swallowed so far (0 to 1). */
  frac: number;
  /** The disk's axis (the way the whole thing spins). */
  axis: [number, number, number];
}

// ---------------------------------------------------------------------------- shaders

const DISK_VERT = /* glsl */ `
varying float vR; varying float vA; varying vec3 vWorld;
void main() {
  vR = length(position.xy); vA = atan(position.y, position.x);
  vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** The accretion disk: hot and white near the hole, orange and red outside, turning faster the closer it is (Keplerian), and brighter on the side that moves toward you (relativistic beaming). */
const DISK_FRAG = /* glsl */ `
uniform float uTime; uniform float uAmt; uniform vec3 uCenter; uniform vec3 uAxis; uniform vec3 uCam;
varying float vR; varying float vA; varying vec3 vWorld;
void main() {
  float r = vR;
  float temp = pow(1.5 / r, 0.75);
  float omega = 2.4 / pow(r, 1.5);
  float ang = vA - omega * uTime * 3.0;
  float n = 0.5 + 0.5 * sin(ang * 7.0 + r * 3.1) * sin(ang * 3.0 - r * 5.7 + 1.3);
  n = 0.6 * n + 0.4 * (0.5 + 0.5 * sin(ang * 13.0 + r * 9.0 + uTime));
  float arms = 0.55 + 0.45 * sin(ang * 2.0 + log(r) * 7.0);
  float edge = smoothstep(1.5, 1.9, r) * (1.0 - smoothstep(5.6, 7.0, r));
  vec3 radial = normalize(vWorld - uCenter);
  vec3 vel = normalize(cross(uAxis, radial));
  float dop = dot(vel, normalize(uCam - vWorld));
  float beam = pow(clamp(1.0 + 0.8 * dop, 0.12, 2.0), 3.0);
  float I = temp * n * arms * edge * beam * 1.7 * uAmt;
  float tt = clamp(temp * 1.3 + dop * 0.14, 0.0, 1.0);
  vec3 col = mix(vec3(0.62, 0.08, 0.03), vec3(1.0, 0.52, 0.14), smoothstep(0.0, 0.5, tt));
  col = mix(col, vec3(1.0, 0.95, 0.85), smoothstep(0.5, 1.0, tt));
  gl_FragColor = vec4(col * max(1.0, I * 0.7), clamp(I, 0.0, 1.0));
}`;

const BILL_VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;

/** The lensed image of the far side of the disk and the photon ring, bent over the hole and facing you. */
const HALO_FRAG = /* glsl */ `
uniform float uAmt; uniform float uBoost; uniform float uTime;
varying vec2 vP;
void main() {
  float r = length(vP), a = atan(vP.y, vP.x);
  float band = smoothstep(1.02, 1.12, r) * (1.0 - smoothstep(1.55, 2.1, r));   // the lensed disk
  float ring = smoothstep(1.0, 1.04, r) * (1.0 - smoothstep(1.06, 1.16, r));   // the photon ring
  float side = 0.35 + 0.65 * pow(0.5 + 0.5 * cos(a - uBoost), 2.0);
  float flick = 0.85 + 0.15 * sin(a * 9.0 - uTime * 4.0 + r * 6.0);
  float I = (band * 0.9 * side * flick + ring * 2.2) * uAmt;
  vec3 col = mix(vec3(1.0, 0.5, 0.15), vec3(1.0, 0.95, 0.85), clamp(ring + band * 0.5, 0.0, 1.0));
  gl_FragColor = vec4(col * max(1.0, I * 0.6), clamp(I, 0.0, 1.0));
}`;

const JET_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;

const JET_FRAG = /* glsl */ `
uniform float uAmt; uniform float uTime;
varying vec2 vUv;
void main() {
  float y = vUv.y;                       // 0 at the hole, 1 at the tip
  float core = pow(1.0 - y, 1.6) * (0.6 + 0.4 * sin(y * 34.0 - uTime * 9.0));
  float side = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float I = core * pow(max(side, 0.0), 1.5) * uAmt;
  gl_FragColor = vec4(mix(vec3(0.55, 0.75, 1.0), vec3(1.0), 1.0 - y), clamp(I, 0.0, 1.0));
}`;

const GAS_VERT = /* glsl */ `
attribute float aR; attribute float aA; attribute float aS; attribute float aZ;
uniform float uTime; uniform float uPx; uniform float uAmt;
varying float vT; varying float vFade;
void main() {
  float omega = 2.4 / pow(aR, 1.5);
  float ang = aA + omega * uTime * 3.0;
  vec3 local = vec3(cos(ang) * aR, sin(ang) * aR, aZ * 0.12 * aR);
  vec4 mv = viewMatrix * modelMatrix * vec4(local, 1.0);
  vT = clamp(pow(1.5 / aR, 0.75) * 1.3, 0.0, 1.0);
  vFade = uAmt * smoothstep(1.4, 2.0, aR);
  gl_PointSize = clamp(aS * uPx / max(0.001, -mv.z), 1.5, 22.0);
  gl_Position = projectionMatrix * mv;
}`;

const GAS_FRAG = /* glsl */ `
varying float vT; varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.0) * vFade;
  vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.8), vT);
  gl_FragColor = vec4(col, a);
}`;

const LENS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Gravitational lensing of everything behind it: a point-lens deflection, so stars and notes bend into an Einstein ring around the hole. */
const LENS_FRAG = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec2 uCenter; uniform float uRE; uniform float uRH; uniform float uAspect; uniform float uAmt;
varying vec2 vUv;
void main() {
  vec2 p = vUv - uCenter; p.x *= uAspect;
  float r = length(p);
  if (uAmt <= 0.001 || uRE <= 0.0) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
  float re = uRE * uAmt;
  float rs = r - (re * re) / max(r, 0.0001);
  vec2 q = (r > 1e-5 ? p / r : vec2(0.0)) * rs;
  q.x /= uAspect;
  vec2 uv = clamp(uCenter + q, vec2(0.001), vec2(0.999));
  vec4 c = texture2D(tDiffuse, uv);
  float hole = smoothstep(uRH * 0.96, uRH * 1.04, r);       // inside the horizon: black
  gl_FragColor = vec4(c.rgb * hole, c.a);
}`;

// ---------------------------------------------------------------------------- the object

/**
 * A black hole to look at: an event horizon, an accretion disk with beaming and differential rotation, a lensed halo and
 * photon ring, jets once it has fed, orbiting gas, and (in the glow pass) lensing of the whole background. The layout does
 * the physics (gravity, orbits, swallowing); this only draws what that layout says.
 */
export class BlackHole {
  readonly pass: ShaderPass;
  private group = new THREE.Group();
  private horizon: THREE.Mesh; private halo: THREE.Mesh; private disk: THREE.Mesh; private gas: THREE.Points;
  private jets: THREE.Mesh[] = [];
  private diskMat: THREE.ShaderMaterial; private haloMat: THREE.ShaderMaterial; private jetMat: THREE.ShaderMaterial; private gasMat: THREE.ShaderMaterial;
  private owned: { dispose(): void }[] = [];
  private amt = 0;           // 0..1: how present the hole is (it fades in as it forms and out as it goes)
  private fading = false;
  private tmp = new THREE.Vector3(); private tmp2 = new THREE.Vector3(); private q = new THREE.Quaternion();
  private cam = new THREE.Vector3(); private right = new THREE.Vector3(); private up = new THREE.Vector3();
  private time = 0;
  private jx = new THREE.Vector3(); private jy = new THREE.Vector3(); private jz = new THREE.Vector3(); private jm = new THREE.Matrix4();

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const add = <T extends { dispose(): void }>(o: T): T => { this.owned.push(o); return o; };
    const shader = (v: string, f: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      add(new THREE.ShaderMaterial({ vertexShader: v, fragmentShader: f, uniforms, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, ...extra }));

    this.diskMat = shader(DISK_VERT, DISK_FRAG, { uTime: { value: 0 }, uAmt: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3(0, 1, 0) }, uCam: { value: new THREE.Vector3() } });
    this.disk = new THREE.Mesh(add(new THREE.RingGeometry(1.45, 7, 128, 10)), this.diskMat);
    this.disk.renderOrder = 6;

    this.horizon = new THREE.Mesh(add(new THREE.CircleGeometry(1, 64)), add(new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false })));
    this.horizon.renderOrder = 7;

    this.haloMat = shader(BILL_VERT, HALO_FRAG, { uAmt: { value: 0 }, uBoost: { value: 0 }, uTime: { value: 0 } });
    this.halo = new THREE.Mesh(add(new THREE.PlaneGeometry(4.4, 4.4)), this.haloMat);
    this.halo.renderOrder = 8;

    this.jetMat = shader(JET_VERT, JET_FRAG, { uAmt: { value: 0 }, uTime: { value: 0 } });
    const jetGeo = add(new THREE.PlaneGeometry(1, 1)); // a flat strip, turned to face the camera in update()
    for (const s of [1, -1]) { const j = new THREE.Mesh(jetGeo, this.jetMat); j.renderOrder = 6; j.userData.dir = s; this.jets.push(j); this.group.add(j); }

    const n = 1400, aR = new Float32Array(n), aA = new Float32Array(n), aS = new Float32Array(n), aZ = new Float32Array(n), pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { aR[i] = 1.6 + Math.pow(Math.random(), 1.6) * 5.2; aA[i] = Math.random() * 6.2832; aS[i] = 0.5 + Math.random() * 1.4; aZ[i] = Math.random() * 2 - 1; }
    const gasGeo = add(new THREE.BufferGeometry());
    gasGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); gasGeo.setAttribute("aR", new THREE.BufferAttribute(aR, 1));
    gasGeo.setAttribute("aA", new THREE.BufferAttribute(aA, 1)); gasGeo.setAttribute("aS", new THREE.BufferAttribute(aS, 1)); gasGeo.setAttribute("aZ", new THREE.BufferAttribute(aZ, 1));
    this.gasMat = shader(GAS_VERT, GAS_FRAG, { uTime: { value: 0 }, uPx: { value: 700 }, uAmt: { value: 0 } });
    this.gas = new THREE.Points(gasGeo, this.gasMat);
    this.gas.frustumCulled = false; this.gas.renderOrder = 6;

    for (const o of [this.disk, this.gas, this.horizon, this.halo]) { o.frustumCulled = false; this.group.add(o); }
    this.group.visible = false;
    scene.add(this.group);

    this.pass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uRE: { value: 0 }, uRH: { value: 0 }, uAspect: { value: 1 }, uAmt: { value: 0 } },
      vertexShader: LENS_VERT, fragmentShader: LENS_FRAG,
    });
    this.pass.enabled = false;
  }

  /** Is anything of it still showing? */
  get alive(): boolean { return this.group.visible; }

  /** The hole is gone: it fades out over a moment. */
  release(): void { this.fading = true; }

  /** Throw it away at once (a stopped show). */
  reset(): void { this.amt = 0; this.fading = false; this.group.visible = false; this.pass.enabled = false; (this.pass.uniforms.uAmt as THREE.IUniform).value = 0; }

  /**
   * Draw one frame. `st` comes from the layout; `lens` is whether the glow pass is in use (the lensing lives in it);
   * `pxPerUnit` is the number of screen pixels one scene unit at distance 1 covers (for the gas particles).
   */
  update(dt: number, st: HoleState, lens: boolean, pxPerUnit: number, aspect: number): void {
    if (!st.active && !this.fading && !this.group.visible) return;
    this.time += dt;
    const target = st.active && !this.fading ? 1 : 0;
    this.amt += (target - this.amt) * (1 - Math.exp(-dt * (target ? 2.2 : 7)));
    if (this.fading && this.amt < 0.01) { this.reset(); return; }
    this.group.visible = true;
    const rh = Math.max(0.5, st.rh) * (0.25 + 0.75 * this.amt);
    const axis = this.tmp.set(st.axis[0], st.axis[1], st.axis[2]).normalize();
    this.group.position.set(st.x, st.y, st.z);
    this.cam.copy(this.camera.position);

    // the disk lies in the plane across the axis; the camera-facing parts follow the camera
    this.q.setFromUnitVectors(this.tmp2.set(0, 0, 1), axis);
    this.disk.quaternion.copy(this.q); this.disk.scale.setScalar(rh);
    this.gas.quaternion.copy(this.q); this.gas.scale.setScalar(rh);
    this.horizon.quaternion.copy(this.camera.quaternion); this.horizon.scale.setScalar(rh);
    this.halo.quaternion.copy(this.camera.quaternion); this.halo.scale.setScalar(rh);

    // where the approaching side of the lensed disk is, in the screen's own directions
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion); this.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const toCam = this.tmp2.copy(this.cam).sub(this.group.position).normalize();
    const limb = this.tmp.copy(axis).cross(toCam).normalize();
    this.haloMat.uniforms.uBoost.value = Math.atan2(limb.dot(this.up), limb.dot(this.right));

    const frac = Math.max(0, Math.min(1, st.frac));
    this.diskMat.uniforms.uTime.value = this.time; this.diskMat.uniforms.uAmt.value = this.amt;
    (this.diskMat.uniforms.uCenter.value as THREE.Vector3).copy(this.group.position);
    (this.diskMat.uniforms.uAxis.value as THREE.Vector3).copy(axis);
    (this.diskMat.uniforms.uCam.value as THREE.Vector3).copy(this.cam);
    this.haloMat.uniforms.uAmt.value = this.amt; this.haloMat.uniforms.uTime.value = this.time;
    this.gasMat.uniforms.uTime.value = this.time; this.gasMat.uniforms.uAmt.value = this.amt; this.gasMat.uniforms.uPx.value = pxPerUnit;

    // jets along the axis once it has fed: strips turned toward the camera so they always read as beams
    this.jetMat.uniforms.uAmt.value = this.amt * Math.max(0, (frac - 0.2) / 0.5); this.jetMat.uniforms.uTime.value = this.time;
    for (const j of this.jets) {
      const dir = j.userData.dir as number, len = rh * 16, width = rh * 1.7;
      const along = this.jy.copy(axis).multiplyScalar(dir);              // the strip runs along the axis...
      const across = this.jx.crossVectors(along, toCam).normalize();      // ...and is as wide as the view of it is, turned to face the camera
      const facing = this.jz.crossVectors(across, along);
      j.quaternion.setFromRotationMatrix(this.jm.makeBasis(across, along, facing));
      j.scale.set(width, len, 1);
      j.position.copy(axis).multiplyScalar(dir * len * 0.5);
    }

    // lensing of everything behind it, in the glow pass
    const p = this.pass.uniforms;
    if (lens) {
      const ndc = this.tmp.copy(this.group.position).project(this.camera);
      const dist = this.camera.position.distanceTo(this.group.position), half = Math.tan((this.camera.fov * Math.PI) / 360);
      const rhs = (rh / (dist * half)) * 0.5; // the horizon as a fraction of the screen's height
      (p.uCenter.value as THREE.Vector2).set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
      p.uRH.value = rhs; p.uRE.value = rhs * 2.2; p.uAspect.value = aspect; p.uAmt.value = ndc.z < 1 ? this.amt : 0;
      this.pass.enabled = true;
    } else { this.pass.enabled = false; }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.owned.forEach(o => o.dispose());
    this.pass.dispose();
  }
}
