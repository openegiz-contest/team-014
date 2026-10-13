import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { Airway, fireSpot, HORIZONS, pointOn, SURFACE_Z, toWorld, worldY, XYZ, smokeCells, placeOf } from "../data/geometry";
import { attr, parseJson, prop, Thing } from "../data/store";
import { COLORS, crewColor, fmt, sensorColor, smokeColor } from "../data/status";
import { declutter, LabelIn } from "../data/declutter";
import type { EvacRoute } from "../data/routes";

type Pick = (name: string | null) => void;

const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpW = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const REVERSE_ARROW = "#ffcf66";
const ARROW = "#e6eef7";

function w(p: XYZ) {
  const [x, y, z] = toWorld(p);
  return new THREE.Vector3(x, y, z);
}

function tubeRadius(aw: Airway) {
  return Math.sqrt(aw.area) * (aw.kind === "shaft" ? 0.95 : 1.2);
}

type Tag = {
  obj: CSS2DObject;
  chip: HTMLDivElement;
  leader: HTMLDivElement;
  pri: number;
  px: number;
  py: number;
  w: number;
  h: number;
  dirty: boolean;
  off?: [number, number];
  css: string;
  compactHide: boolean;
  /** preferred spot is to the left of the anchor, whatever the label width */
  leftOfAnchor?: boolean;
};

type Particle = { aw: Airway; u: number };

export type ViewPreset = "overview" | "h-480" | "h-560" | "h-640" | "fire";

// low-poly models, built along +x, standing on y = 0 (units: scene metres, symbolic scale)
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  wheel: new THREE.CylinderGeometry(1, 1, 1, 12).rotateX(Math.PI / 2),
  body: new THREE.CylinderGeometry(0.75, 1, 1, 8),
  head: new THREE.SphereGeometry(1, 10, 8),
  tank: new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2),
  hopper: new THREE.ConeGeometry(1, 1, 4, 1, true).rotateX(Math.PI),
  insulator: new THREE.CylinderGeometry(0.5, 0.7, 1, 8),
  oct: new THREE.OctahedronGeometry(1),
};
const DARK = new THREE.MeshLambertMaterial({ color: 0x2b333e });
const BURNING_BODY = "#f1e4d6";
const EDGES = new THREE.EdgesGeometry(GEO.box);
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x11161c });

/** Dark outline on the body parts, so a machine keeps its silhouette inside a coloured smoke halo. */
function outlined(g: THREE.Group) {
  for (const c of g.children) {
    const m = c as THREE.Mesh;
    if (m.geometry === GEO.box) m.add(new THREE.LineSegments(EDGES, EDGE_MAT));
  }
  return g;
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.z = rz;
  return m;
}

function wheels(g: THREE.Group, xs: number[], r: number, halfTrack: number, wdt = 1.8) {
  for (const x of xs) for (const z of [-halfTrack, halfTrack]) g.add(part(GEO.wheel, DARK, r, r, wdt, x, r, z));
}

/** Scooptram-like loader: articulated frame, side cab, bucket in front. */
function lhdModel(mat: THREE.Material) {
  const g = new THREE.Group();
  g.add(part(GEO.box, mat, 12, 4.4, 8, -5, 4.6, 0));
  g.add(part(GEO.box, mat, 8, 3.4, 7.4, 5, 4, 0));
  g.add(part(GEO.box, mat, 3.6, 3.8, 3.4, -0.5, 8.3, -2.4));
  g.add(part(GEO.box, mat, 3.4, 4.2, 10, 11.4, 3.4, 0, 0.35));
  wheels(g, [-7.5, 5.5], 2.6, 4.4);
  return g;
}

/** Minetruck-like hauler: dump body at the rear, cab and engine in front. */
function truckModel(mat: THREE.Material) {
  const g = new THREE.Group();
  g.add(part(GEO.box, mat, 16, 6, 10, -5, 8, 0, -0.05));
  g.add(part(GEO.box, mat, 9, 4.4, 8, 9, 5, 0));
  g.add(part(GEO.box, mat, 3.8, 4, 3.6, 10.5, 9.2, -2.6));
  wheels(g, [-8.5, -3.5, 9.5], 3, 5);
  return g;
}

/** Drill rig or bolter: carrier with a raised boom. */
function rigModel(mat: THREE.Material, boom: number) {
  const g = new THREE.Group();
  g.add(part(GEO.box, mat, 14, 4, 7.4, -2, 4.4, 0));
  g.add(part(GEO.box, mat, 3.6, 3.6, 3.2, 1, 8.2, 2.2));
  g.add(part(GEO.box, mat, boom, 1.4, 1.4, 5 + boom / 2 - 1, 8.5, -1.4, 0.32));
  wheels(g, [-6.5, 3], 2.2, 4);
  return g;
}

/** Crew: up to three standing figures. */
function crewModel(mat: THREE.Material, people: number) {
  const g = new THREE.Group();
  const n = Math.max(1, Math.min(3, people));
  const spots = [[0, 0], [-4.2, 3], [3.6, 3.4]];
  for (let i = 0; i < n; i++) {
    const [x, z] = spots[i];
    g.add(part(GEO.body, mat, 2.2, 7, 2.2, x, 3.5, z));
    g.add(part(GEO.head, mat, 1.9, 1.9, 1.9, x, 9.2, z));
  }
  return g;
}

export class MineScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private onPick: Pick;
  private raf = 0;
  private clock = new THREE.Clock();
  private reduced: boolean;
  private airways: Airway[] = [];
  private awById = new Map<string, Airway>();
  private awEnds = new Map<string, [THREE.Vector3, THREE.Vector3]>();
  private tube?: THREE.InstancedMesh;
  private halo?: THREE.InstancedMesh;
  private cellRange = new Map<string, [number, number]>();
  private cellOwner: string[] = [];
  private cellMatrix: THREE.Matrix4[] = [];
  private particles?: THREE.InstancedMesh;
  private parts: Particle[] = [];
  private velocity = new Map<string, number>();
  private reversed = false;
  private objects = new Map<string, THREE.Object3D>();
  private crewTags = new Map<string, Tag>();
  private crewSize = new Map<string, number>();
  private pickables: THREE.Object3D[] = [];
  private tags: Tag[] = [];
  private fire: THREE.Group;
  private flames: THREE.Mesh[] = [];
  private fireRing: THREE.Mesh;
  private fireLight: THREE.PointLight;
  private fireTag: Tag;
  private firePos: THREE.Vector3 | null = null;
  private fireR = 5;
  private shaftTags: Tag[] = [];
  private estimate: THREE.Mesh;
  private estimateTag: Tag;
  private reverseTag: Tag;
  private routeGroup = new THREE.Group();
  private routeKey = "";
  private routeLines: { pts: THREE.Vector3[]; len: number; cum: number[] }[] = [];
  private routeArrows: THREE.InstancedMesh;
  private routeTags = new Map<string, Tag>();
  private selected: string | null = null;
  private selBox: THREE.BoxHelper | null = null;
  private resize: ResizeObserver;
  private camGoal: THREE.Vector3 | null = null;
  private targetGoal: THREE.Vector3 | null = null;
  private down = { x: 0, y: 0 };
  private view: ViewPreset = "overview";
  private userMoved = false;
  private compact = false;

  constructor(container: HTMLElement, onPick: Pick) {
    this.container = container;
    this.onPick = onPick;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0e1116);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels-layer";
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 6000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.reduced;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 2600;
    this.controls.minDistance = 40;
    this.controls.addEventListener("start", () => {
      this.userMoved = true;
      this.camGoal = null;
      this.targetGoal = null;
    });

    this.scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x1a1f26, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 800, 400);
    this.scene.add(sun);

    const sy = worldY(SURFACE_Z);
    const grid = new THREE.GridHelper(1000, 20, 0x2a323d, 0x1c222b);
    grid.position.set(0, sy, -180);
    this.scene.add(grid);
    this.place(this.tag("Поверхность +420 м", "lbl lbl-muted", 10, 0, 0, true), new THREE.Vector3(-380, sy + 6, 300));
    for (const h of HORIZONS) {
      const t = this.tag(`Горизонт ${h.label}`, "lbl lbl-horizon", 40);
      t.leftOfAnchor = true;
      this.place(t, new THREE.Vector3(-350, worldY(h.z), 190));
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(860, 820),
        new THREE.MeshBasicMaterial({ color: 0x151a21, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(0, worldY(h.z) - 8, -190);
      this.scene.add(plate);
    }

    // fire (scenario ground truth): flame, beacon so it is found from the overview, ring on the floor
    this.fire = new THREE.Group();
    const flameMat = (c: string, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
    for (const [c, o, s] of [["#ef4b4b", 0.55, 1.35], ["#ff8a2a", 0.85, 1], ["#ffd36a", 0.95, 0.6]] as const) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 8), flameMat(c, o));
      f.userData.base = s;
      this.flames.push(f);
      this.fire.add(f);
    }
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), flameMat("#ef4b4b", 0.5));
    beacon.scale.set(1.1, 120, 1.1);
    beacon.position.y = 60;
    this.fire.add(beacon);
    this.fireRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.22, 48), new THREE.MeshBasicMaterial({ color: COLORS.alarm, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.fireRing.rotation.x = -Math.PI / 2;
    this.fire.add(this.fireRing);
    this.fireLight = new THREE.PointLight(0xff6a3d, 0, 300, 1.4);
    this.fireLight.position.y = 10;
    this.fire.add(this.fireLight);
    this.fireTag = this.tag("Очаг", "lbl lbl-alarm", 100, 0, -14);
    this.fireTag.obj.position.set(0, 122, 0);
    this.fire.add(this.fireTag.obj);
    this.fire.visible = false;
    this.scene.add(this.fire);

    this.estimate = new THREE.Mesh(new THREE.TorusGeometry(16, 1.6, 8, 40), new THREE.MeshBasicMaterial({ color: COLORS.warn }));
    this.estimate.rotation.x = Math.PI / 2;
    this.estimateTag = this.tag("Оценка советчика", "lbl lbl-warn", 90, 0, 26);
    this.estimate.add(this.estimateTag.obj);
    this.estimate.visible = false;
    this.scene.add(this.estimate);

    this.reverseTag = this.tag("ГВУ: реверс струи", "lbl lbl-warn", 75, 0, -16);
    this.reverseTag.obj.visible = false;
    this.scene.add(this.reverseTag.obj);

    this.scene.add(this.routeGroup);
    this.routeArrows = new THREE.InstancedMesh(new THREE.ConeGeometry(3.4, 9, 6), new THREE.MeshBasicMaterial({ color: COLORS.route }), 240);
    this.routeArrows.frustumCulled = false;
    this.routeArrows.count = 0;
    this.scene.add(this.routeArrows);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) this.pick(e);
    });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.setView("overview", true);
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== EDGES && !Object.values(GEO).includes(m.geometry as never)) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat && mat !== DARK && mat !== EDGE_MAT) mat.dispose();
    });
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
    this.container.removeChild(this.labels.domElement);
  }

  // ---- labels ---------------------------------------------------------------
  private tag(text: string, cls: string, pri: number, px = 0, py = 0, compactHide = false): Tag {
    const root = document.createElement("div");
    root.className = "tag";
    const leader = document.createElement("div");
    leader.className = "tag-leader";
    const chip = document.createElement("div");
    chip.className = cls;
    chip.textContent = text;
    root.append(leader, chip);
    const t: Tag = { obj: new CSS2DObject(root), chip, leader, pri, px, py, w: 0, h: 0, dirty: true, css: "", compactHide };
    this.tags.push(t);
    return t;
  }

  private place(t: Tag, pos: THREE.Vector3) {
    t.obj.position.copy(pos);
    this.scene.add(t.obj);
  }

  private text(t: Tag, s: string) {
    if (t.chip.textContent !== s) {
      t.chip.textContent = s;
      t.dirty = true;
    }
  }

  private dropTag(t: Tag) {
    t.obj.removeFromParent();
    this.tags = this.tags.filter((x) => x !== t);
  }

  /** Moves overlapping labels apart and draws a leader line to the object they belong to. */
  private layoutTags() {
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const items: LabelIn[] = [];
    const byId = new Map<string, Tag>();
    this.tags.forEach((t, i) => {
      const root = t.obj.element;
      if (!root.isConnected || root.style.display === "none" || (this.compact && t.compactHide)) {
        if (this.compact && t.compactHide) root.style.visibility = "hidden";
        return;
      }
      root.style.visibility = "";
      if (t.dirty || !t.w) {
        t.w = t.chip.offsetWidth;
        t.h = t.chip.offsetHeight;
        t.dirty = !t.w;
      }
      t.obj.getWorldPosition(tmpV).project(this.camera);
      const ax = ((tmpV.x + 1) / 2) * W;
      const ay = ((1 - tmpV.y) / 2) * H;
      // a label whose object is off screen would be pulled into view far from it
      if (ax < -8 || ax > W + 8 || ay < -8 || ay > H + 8) {
        root.style.visibility = "hidden";
        return;
      }
      const id = String(i);
      byId.set(id, t);
      items.push({ id, ax, ay, w: t.w, h: t.h, priority: t.pri, px: t.leftOfAnchor ? -(t.w / 2 + 12) : t.px, py: t.py, prev: t.off });
    });
    const placed = declutter(items, [], { x: 4, y: 4, w: W - 8, h: H - 8 });
    for (const [id, p] of placed) {
      const t = byId.get(id)!;
      t.off = [p.dx, p.dy];
      const dx = Math.round(p.dx);
      const dy = Math.round(p.dy);
      let leader = "";
      const away = Math.hypot(dx, dy) > Math.max(t.h, 18);
      if (p.moved || away) {
        const ex = Math.max(dx - t.w / 2, Math.min(0, dx + t.w / 2));
        const ey = Math.max(dy - t.h / 2, Math.min(0, dy + t.h / 2));
        const len = Math.hypot(ex, ey);
        if (len > 4) leader = `${len.toFixed(0)}|${Math.atan2(ey, ex).toFixed(3)}`;
      }
      const css = `${dx}|${dy}|${leader}`;
      if (css === t.css) continue;
      t.css = css;
      t.chip.style.transform = `translate(${dx - t.w / 2}px, ${dy - t.h / 2}px)`;
      if (leader) {
        const [len, ang] = leader.split("|");
        t.leader.style.display = "block";
        t.leader.style.width = `${len}px`;
        t.leader.style.transform = `rotate(${ang}rad)`;
        t.obj.element.classList.add("is-moved");
      } else {
        t.leader.style.display = "none";
        t.obj.element.classList.remove("is-moved");
      }
    }
  }

  // ---- camera ---------------------------------------------------------------
  private fit() {
    const { clientWidth: wdt, clientHeight: hgt } = this.container;
    if (!wdt || !hgt) return;
    this.renderer.setSize(wdt, hgt);
    this.labels.setSize(wdt, hgt);
    this.camera.aspect = wdt / hgt;
    this.camera.fov = wdt < 640 ? 50 : 42;
    this.compact = wdt < 640;
    this.labels.domElement.classList.toggle("is-compact", this.compact);
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.setView(this.view, true);
  }

  /** Camera position and target that fit `box` on screen when looking along `dir`. */
  private frame(box: THREE.Box3, dir: THREE.Vector3, margin = 0.94): [THREE.Vector3, THREE.Vector3] {
    const cam = this.camera.clone();
    const center = box.getCenter(new THREE.Vector3());
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const d = dir.clone().normalize();
    let dist = box.getSize(new THREE.Vector3()).length();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      cam.position.copy(center).addScaledVector(d, dist);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) {
        const p = c.clone().project(cam);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist;
      right.setFromMatrixColumn(cam.matrixWorld, 0);
      up.setFromMatrixColumn(cam.matrixWorld, 1);
      center.addScaledVector(right, ((x0 + x1) / 2) * halfH * cam.aspect).addScaledVector(up, ((y0 + y1) / 2) * halfH);
      dist *= Math.max((x1 - x0) / 2, (y1 - y0) / 2) / margin;
    }
    return [center.clone().addScaledVector(d, dist), center];
  }

  private goTo(cam: THREE.Vector3, tgt: THREE.Vector3, instant: boolean) {
    if (instant || this.reduced) {
      this.camera.position.copy(cam);
      this.controls.target.copy(tgt);
      this.camGoal = null;
      this.targetGoal = null;
    } else {
      this.camGoal = cam;
      this.targetGoal = tgt;
    }
    this.controls.update();
  }

  get currentView() {
    return this.view;
  }

  setView(preset: ViewPreset, instant = false) {
    if (preset === "fire" && !this.firePos) preset = "overview";
    this.view = preset;
    this.userMoved = false;
    const wdt = this.container.clientWidth;
    const portrait = this.container.clientHeight > wdt * 0.9;
    let box: THREE.Box3;
    let dir: THREE.Vector3;
    if (preset === "overview" && portrait) {
      box = new THREE.Box3(new THREE.Vector3(-380, worldY(-640) - 10, -560), new THREE.Vector3(360, worldY(-480) + 50, 340));
      dir = new THREE.Vector3(0.2, 1.35, 1);
    } else if (preset === "overview") {
      box = new THREE.Box3(new THREE.Vector3(-480, worldY(-640) - 10, -600), new THREE.Vector3(400, worldY(SURFACE_Z) + 10, 300));
      dir = new THREE.Vector3(0.45, 0.45, 1);
    } else if (preset === "fire") {
      const f = this.firePos!;
      const r = wdt < 640 ? 170 : 230;
      box = new THREE.Box3(new THREE.Vector3(f.x - r, f.y - 20, f.z - r), new THREE.Vector3(f.x + r, f.y + 60, f.z + r));
      dir = new THREE.Vector3(0.3, 0.85, 0.9);
    } else {
      const y = worldY(HORIZONS.find((h) => h.id === preset)!.z);
      box = new THREE.Box3(new THREE.Vector3(-400, y - 10, -600), new THREE.Vector3(440, y + 10, 240));
      dir = portrait ? new THREE.Vector3(0.05, 1, 0.35) : new THREE.Vector3(0.12, 1, 0.8);
    }
    const [cam, tgt] = this.frame(box, dir);
    this.goTo(cam, tgt, instant);
  }

  /** Brings an object into the middle of the view, keeping the current viewing angle. */
  focusObject(name: string) {
    const obj = this.objects.get(name);
    let pos: THREE.Vector3 | null = null;
    if (obj) pos = obj.getWorldPosition(new THREE.Vector3());
    else {
      const ends = this.awEnds.get(name);
      if (ends) pos = ends[0].clone().lerp(ends[1], 0.5);
    }
    if (!pos) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(dir.length(), this.compact ? 520 : 640);
    dir.setLength(dist);
    this.userMoved = true;
    this.goTo(pos.clone().add(dir), pos, false);
  }

  // ---- geometry ---------------------------------------------------------------
  build(airways: Airway[], things: Record<string, Thing>) {
    for (const m of [this.tube, this.halo, this.particles]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.airways = airways;
    this.awById = new Map(airways.map((a) => [a.id, a]));
    this.awEnds = new Map(airways.map((a) => [a.id, [w(a.a), w(a.b)]]));
    const total = airways.reduce((n, a) => n + a.cells, 0);
    this.tube = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), total);
    this.halo = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
      total,
    );
    this.halo.frustumCulled = false;
    this.cellOwner = [];
    this.cellMatrix = [];
    const air = new THREE.Color(COLORS.air);
    let k = 0;
    for (const aw of airways) {
      const r = tubeRadius(aw);
      this.cellRange.set(aw.id, [k, aw.cells]);
      for (let i = 0; i < aw.cells; i++) {
        const p0 = w(pointOn(aw, i / aw.cells));
        const p1 = w(pointOn(aw, (i + 1) / aw.cells));
        const len = p0.distanceTo(p1);
        tmpV.subVectors(p1, p0).normalize();
        tmpQ.setFromUnitVectors(UP, tmpV);
        tmpS.set(r, len * 1.02, r);
        const m = new THREE.Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), tmpQ, tmpS);
        this.cellMatrix[k] = m;
        this.tube.setMatrixAt(k, m);
        this.tube.setColorAt(k, air);
        this.halo.setMatrixAt(k, tmpM.makeScale(0, 0, 0));
        this.halo.setColorAt(k, air);
        this.cellOwner[k] = aw.id;
        k++;
      }
    }
    this.tube.instanceMatrix.needsUpdate = true;
    this.scene.add(this.tube, this.halo);

    this.parts = [];
    for (const aw of airways) {
      const n = Math.max(2, Math.round(aw.length / 120));
      for (let i = 0; i < n; i++) this.parts.push({ aw, u: (i + 0.5) / n });
    }
    this.particles = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), this.parts.length);
    this.particles.frustumCulled = false;
    for (let i = 0; i < this.parts.length; i++) this.particles.setColorAt(i, tmpC.set(ARROW));
    this.scene.add(this.particles);

    this.buildObjects(things);
    this.update(things, []);
  }

  private addObject(name: string, obj: THREE.Object3D, pos: THREE.Vector3, tint?: THREE.MeshLambertMaterial) {
    obj.position.copy(pos);
    obj.userData.name = name;
    obj.userData.tint = tint;
    this.objects.set(name, obj);
    this.pickables.push(obj);
    this.scene.add(obj);
  }

  private yawAlong(obj: THREE.Object3D, aw: Airway | undefined) {
    const ends = aw && this.awEnds.get(aw.id);
    if (!ends) return;
    tmpV.subVectors(ends[1], ends[0]);
    obj.rotation.set(0, Math.atan2(-tmpV.z, tmpV.x), 0);
  }

  private onTube(p: XYZ, awName: unknown, extra = 0) {
    const aw = this.awById.get(String(awName ?? "").replace(/^bolashak:/, ""));
    return w(p).add(new THREE.Vector3(0, (aw ? tubeRadius(aw) : 5) + extra, 0));
  }

  private buildObjects(things: Record<string, Thing>) {
    for (const m of this.objects.values()) {
      this.scene.remove(m);
      const tg = m.userData.tag as Tag | undefined;
      if (tg) this.dropTag(tg);
    }
    for (const t of this.crewTags.values()) this.dropTag(t);
    this.crewTags.clear();
    this.crewSize.clear();
    this.objects.clear();
    this.pickables = [];
    const mat = (c: string, opacity = 1) => new THREE.MeshLambertMaterial({ color: c, transparent: opacity < 1, opacity });
    for (const [name, t] of Object.entries(things)) {
      const kind = String(t.attributes?.kind ?? "");
      const p = placeOf(things, name);
      const awAttr = t.attributes?.airway;
      if (kind === "gas-station" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.box, m, 5, 5, 5, 0, 2.5, 0));
        this.addObject(name, g, this.onTube(p, awAttr, 1), m);
      } else if (kind === "fire-door" && p) {
        const aw = this.awById.get(String(awAttr ?? "").split(":")[1] ?? "");
        const r = aw ? tubeRadius(aw) : 5;
        const m = mat(COLORS.equip, 0.3);
        const g = new THREE.Group();
        const plate = part(GEO.box, m, 1.6, r * 2 + 6, r * 2 + 6, 0, 0, 0);
        const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.8, r * 2 + 7, r * 2 + 7)), new THREE.LineBasicMaterial({ color: COLORS.equip }));
        g.add(plate, frame);
        this.yawAlong(g, aw);
        this.addObject(name, g, w(p), m);
      } else if (kind === "valve" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.oct, m, 3.8, 3.8, 3.8, 0, 3.8, 0));
        this.addObject(name, g, this.onTube(p, awAttr, 1), m);
      } else if ((kind === "lhd" || kind === "truck") && p) {
        const m = mat(COLORS.equip);
        this.addObject(name, outlined(kind === "lhd" ? lhdModel(m) : truckModel(m)), w(p), m);
      } else if ((kind === "drill" || kind === "bolter") && p) {
        const m = mat(COLORS.equip);
        const g = outlined(rigModel(m, kind === "drill" ? 14 : 9));
        this.yawAlong(g, this.awById.get(String(awAttr ?? "").split(":")[1] ?? ""));
        this.addObject(name, g, this.onTube(p, awAttr, -1), m);
      } else if (kind === "crew" && p) {
        const m = mat(COLORS.white);
        const people = Number(prop(things, name, "people") ?? attr(things, name, "headcount") ?? 3);
        const g = crewModel(m, people);
        this.crewSize.set(name, Math.min(3, people));
        const tg = this.tag("", "lbl lbl-crew", 80, 0, -18);
        tg.obj.position.set(0, 12, 0);
        g.add(tg.obj);
        this.crewTags.set(name, tg);
        this.addObject(name, g, w(p), m);
      } else if (kind === "refuge" && p) {
        const m = new THREE.MeshLambertMaterial({ color: COLORS.ok, transparent: true, opacity: 0.45 });
        const g = new THREE.Group();
        g.add(part(GEO.box, m, 18, 10, 14, 0, 5, 0));
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(18, 10, 14)), new THREE.LineBasicMaterial({ color: COLORS.ok })).translateY(5));
        const tg = this.tag("Убежище", "lbl lbl-ok", 50, 0, -12);
        tg.obj.position.set(0, 12, 0);
        g.add(tg.obj);
        g.userData.tag = tg;
        this.addObject(name, g, w(p).add(new THREE.Vector3(16, -4, 16)));
      } else if (kind === "substation") {
        const pos = this.nodePos(String(t.attributes.node ?? ""));
        if (pos) {
          const m = mat(COLORS.grey);
          const g = new THREE.Group();
          g.add(part(GEO.box, m, 10, 7, 8, 0, 3.5, 0));
          for (const x of [-3, 0, 3]) g.add(part(GEO.insulator, DARK, 1, 3, 1, x, 8.5, 0));
          this.addObject(name, g, pos.add(new THREE.Vector3(-18, -4, 14)), m);
        }
      } else if (kind === "depot" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.tank, m, 13, 3.4, 3.4, 0, 3.4, -4), part(GEO.tank, m, 13, 3.4, 3.4, 0, 3.4, 4));
        this.addObject(name, g, w(p).add(new THREE.Vector3(0, -4, 16)), m);
      } else if (kind === "crusher" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.box, m, 10, 7, 10, 0, 3.5, 0), part(GEO.hopper, m, 8, 6, 8, 0, 10, 0));
        this.addObject(name, g, w(p).add(new THREE.Vector3(0, -4, 16)), m);
      } else if (kind === "conveyor" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.box, m, 70, 1.6, 5, 0, 4, 0));
        for (const x of [-30, -10, 10, 30]) g.add(part(GEO.box, DARK, 1.2, 4, 5, x, 1.6, 0));
        this.yawAlong(g, this.awById.get(String(awAttr ?? "").split(":")[1] ?? ""));
        this.addObject(name, g, w(p).add(new THREE.Vector3(0, -4, 12)), m);
      } else if (kind === "charger" && p) {
        const m = mat(COLORS.grey);
        const g = new THREE.Group();
        g.add(part(GEO.box, m, 12, 8, 6, 0, 4, 0));
        for (const x of [-3.5, 0, 3.5]) g.add(part(GEO.box, DARK, 2, 4, 0.6, x, 4.5, 3.1));
        this.addObject(name, g, w(p).add(new THREE.Vector3(0, -4, 14)), m);
      } else if (kind === "fan") {
        const pos = this.nodePos("VS0");
        if (pos) {
          const m = mat(COLORS.grey);
          const g = new THREE.Group();
          g.add(part(GEO.tank, m, 9, 6, 6, 0, 0, 0));
          this.addObject(name, g, pos.add(new THREE.Vector3(name === "fan-1" ? -16 : 16, 8, 0)), m);
        }
      }
    }
    const shaftLabels: [string, string][] = [
      ["CS0", "Клетевой ствол"],
      ["SS0", "Скиповой ствол"],
      ["VS0", "Вентствол, ГВУ"],
    ];
    this.shaftTags.forEach((t) => this.dropTag(t));
    this.shaftTags = [];
    for (const [node, text] of shaftLabels) {
      const pos = this.nodePos(node);
      if (!pos) continue;
      const t = this.tag(text, "lbl lbl-muted", 30, 0, -16, true);
      t.obj.position.copy(pos).add(new THREE.Vector3(0, 8, 0));
      this.scene.add(t.obj);
      this.shaftTags.push(t);
    }
    const vs = this.nodePos("VS0");
    if (vs) this.reverseTag.obj.position.copy(vs).add(new THREE.Vector3(0, 30, 0));
  }

  private nodePos(node: string): THREE.Vector3 | null {
    for (const aw of this.airways) {
      if (aw.frm === node) return w(aw.a);
      if (aw.to === node) return w(aw.b);
    }
    return null;
  }

  // ---- live state -------------------------------------------------------------
  update(things: Record<string, Thing>, routes: EvacRoute[]) {
    if (!this.tube || !this.halo) return;
    for (const aw of this.airways) {
      const range = this.cellRange.get(aw.id);
      if (!range) continue;
      const cells = smokeCells(things, aw);
      for (let i = 0; i < range[1]; i++) {
        const s = Math.min(1, cells[i] ?? 0);
        const k = range[0] + i;
        tmpC.set(smokeColor(s));
        this.tube.setColorAt(k, tmpC);
        if (s > 0.04) {
          const grow = 1.4 + 0.9 * s;
          tmpM.copy(this.cellMatrix[k]).multiply(tmpM2.makeScale(grow, 1, grow));
          this.halo.setMatrixAt(k, tmpM);
          this.halo.setColorAt(k, tmpC);
        } else {
          this.halo.setMatrixAt(k, tmpM.makeScale(0, 0, 0));
        }
      }
      this.velocity.set(aw.id, Number(prop(things, aw.id, "velocity") ?? 0));
    }
    if (this.tube.instanceColor) this.tube.instanceColor.needsUpdate = true;
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;

    const reversed = prop(things, "gvu", "mode") === "reverse" || ["fan-1", "fan-2"].some((f) => prop(things, f, "rotation") === "reverse");
    if (reversed !== this.reversed && this.particles) {
      this.reversed = reversed;
      for (let i = 0; i < this.parts.length; i++) this.particles.setColorAt(i, tmpC.set(reversed ? REVERSE_ARROW : ARROW));
      if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
    }
    this.reverseTag.obj.visible = reversed;

    for (const [name, obj] of this.objects) {
      const kind = String(things[name]?.attributes?.kind ?? "");
      const m = obj.userData.tint as THREE.MeshLambertMaterial | undefined;
      if (kind === "gas-station" && m) {
        m.color.set(sensorColor(String(prop(things, name, "state") ?? "ok")));
      } else if (kind === "fire-door" && m) {
        const st = String(prop(things, name, "position") ?? "open");
        const closed = Number(prop(things, name, "closed") ?? 0) / 100;
        m.color.set(st === "fault" ? COLORS.alarm : closed > 0.02 ? COLORS.info : COLORS.equip);
        m.opacity = 0.2 + 0.75 * closed;
        m.transparent = m.opacity < 1;
      } else if (kind === "valve" && m) {
        const st = String(prop(things, name, "position") ?? "");
        const normal = String(attr(things, name, "normal") ?? "");
        m.color.set(st === "fault" ? COLORS.alarm : st !== normal ? COLORS.info : COLORS.grey);
      } else if ((kind === "lhd" || kind === "truck") && m) {
        const p = placeOf(things, name);
        const loc = String(prop(things, name, "location") ?? "");
        if (p) obj.position.copy(this.onTube(p, "aw-" + loc, -2));
        this.yawAlong(obj, this.awById.get("aw-" + loc));
        const fire = prop(things, name, "fire_alarm") === true;
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(fire ? COLORS.alarm : st === "parked" ? "#6b7685" : COLORS.equip);
      } else if ((kind === "drill" || kind === "bolter") && m) {
        m.color.set(prop(things, name, "state") === "parked" ? "#6b7685" : COLORS.equip);
      } else if (kind === "crew" && m) {
        const p = placeOf(things, name);
        const loc = things[name]?.features?.location?.properties?.airway;
        if (p) obj.position.copy(this.onTube(p, "aw-" + String(loc ?? ""), -2));
        const st = String(prop(things, name, "state") ?? "working");
        const fed = Number(prop(things, name, "fed") ?? 0);
        const c = crewColor(st, fed);
        m.color.set(c);
        obj.visible = st !== "surface";
        const tg = this.crewTags.get(name);
        if (tg) {
          this.text(tg, `${prop(things, name, "people") ?? ""} чел.`);
          tg.chip.style.borderColor = c;
        }
      } else if (kind === "refuge") {
        const tg = obj.userData.tag as Tag | undefined;
        const occ = Number(prop(things, name, "occupants") ?? 0);
        if (tg) this.text(tg, occ > 0 ? `Убежище · ${occ} чел.` : "Убежище");
      } else if (kind === "substation" && m) {
        m.color.set(prop(things, name, "power") === "off" ? COLORS.info : COLORS.grey);
      } else if (["crusher", "conveyor", "charger", "depot"].includes(kind) && m) {
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(st === "fire" ? COLORS.alarm : ["stopped", "de-energized"].includes(st) ? COLORS.info : COLORS.grey);
      } else if (kind === "fan" && m) {
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(st === "tripped" ? COLORS.alarm : st === "reversing" || prop(things, name, "rotation") === "reverse" ? COLORS.warn : st === "running" ? COLORS.equip : "#56606e");
      }
    }

    const spot = fireSpot(things, this.airways);
    if (spot) {
      const pos = w(spot.xyz);
      // a burning machine keeps a light body and carries the flame on its roof,
      // otherwise it disappears inside the red smoke halo
      let host: THREE.Object3D | null = null;
      for (const [name, obj] of this.objects) {
        const kind = String(things[name]?.attributes?.kind ?? "");
        if ((kind === "lhd" || kind === "truck") && obj.position.distanceTo(pos) < 30) host = obj;
      }
      if (host) (host.userData.tint as THREE.MeshLambertMaterial | undefined)?.color.set(BURNING_BODY);
      this.fire.visible = true;
      this.fire.position.copy(host ? host.position.clone().add(new THREE.Vector3(0, 9, 0)) : pos);
      this.firePos = pos;
      const r = host ? 3 + Math.sqrt(spot.hrr) * 1.6 : 4 + Math.sqrt(spot.hrr) * 2.4;
      this.fireR = r;
      for (const f of this.flames) {
        const b = f.userData.base as number;
        f.scale.set(r * b * 0.7, r * b, r * b * 0.7);
        f.position.y = r * b * 1.3;
      }
      this.fireRing.scale.setScalar(r * 2.6);
      this.fireLight.intensity = 2 + spot.hrr * 1.5;
      this.text(this.fireTag, `Очаг · ${fmt(spot.hrr, 1)} МВт`);
    } else {
      this.fire.visible = false;
      this.firePos = null;
    }
    const est = parseJson<{ edge: string; s: number; hrr_mw?: number } | null>(prop(things, "advisor", "estimate"), null);
    const eAw = est ? this.awById.get("aw-" + est.edge) : undefined;
    if (est && eAw && prop(things, "advisor", "state") === "forecast") {
      this.estimate.visible = true;
      this.estimate.position.copy(w(pointOn(eAw, est.s))).add(new THREE.Vector3(0, tubeRadius(eAw) + 2, 0));
      this.text(this.estimateTag, est.hrr_mw !== undefined ? `Оценка советчика · ${fmt(est.hrr_mw, 1)} МВт` : "Оценка советчика");
    } else {
      this.estimate.visible = false;
    }
    this.updateRoutes(routes);
    this.highlight();
  }

  private updateRoutes(routes: EvacRoute[]) {
    const key = routes.map((r) => `${r.key}@${r.points[0].map((v) => Math.round(v / 10)).join(",")}`).join("|");
    if (key === this.routeKey) return;
    this.routeKey = key;
    for (const c of [...this.routeGroup.children]) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.routeGroup.remove(m);
    }
    this.routeLines = [];
    const used = new Set<string>();
    for (const r of routes) {
      const lift = (p: XYZ, aw?: Airway) => w(p).add(new THREE.Vector3(0, (aw ? tubeRadius(aw) : 5) + 7, 0));
      const pts: THREE.Vector3[] = r.points.map((p, i) => lift(p, r.legs[Math.max(0, i - 1)]?.aw));
      const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.5);
      if (clean.length < 2) continue;
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < clean.length; i++) path.add(new THREE.LineCurve3(clean[i - 1], clean[i]));
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(path, clean.length * 4, 1.7, 6, false),
        new THREE.MeshBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      this.routeGroup.add(mesh);
      const cum = [0];
      for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + clean[i].distanceTo(clean[i - 1]));
      this.routeLines.push({ pts: clean, len: cum[cum.length - 1], cum });
      used.add(r.targetLabel);
      let tg = this.routeTags.get(r.targetLabel);
      if (!tg) {
        tg = this.tag(`Выход: ${r.targetLabel}`, "lbl lbl-route", 60, 0, -14);
        this.scene.add(tg.obj);
        this.routeTags.set(r.targetLabel, tg);
      }
      tg.obj.position.copy(clean[clean.length - 1]).add(new THREE.Vector3(0, 6, 0));
    }
    for (const [label, tg] of this.routeTags) tg.obj.visible = used.has(label);
  }

  select(name: string | null) {
    this.selected = name;
    this.highlight();
  }

  private highlight() {
    if (this.selBox) {
      this.scene.remove(this.selBox);
      this.selBox.dispose();
      this.selBox = null;
    }
    const obj = this.selected ? this.objects.get(this.selected) : null;
    if (obj && obj.visible) {
      this.selBox = new THREE.BoxHelper(obj, 0xffd166);
      this.scene.add(this.selBox);
    }
  }

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects([...this.pickables.filter((p) => p.visible), ...(this.tube ? [this.tube] : [])], true);
    const h = hits.find((x) => x.object.type !== "LineSegments");
    if (!h) {
      this.onPick(null);
      return;
    }
    if (h.object === this.tube && h.instanceId !== undefined) {
      this.onPick(this.cellOwner[h.instanceId]);
      return;
    }
    let o: THREE.Object3D | null = h.object;
    while (o && !o.userData.name) o = o.parent;
    this.onPick(o ? String(o.userData.name) : null);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const raw = this.clock.getDelta();
    const dt = Math.min(0.1, raw);
    const t = performance.now() / 1000;
    if (this.camGoal && this.targetGoal) {
      // a slow software renderer still lands the flight in about a second
      const k = 1 - Math.pow(0.004, Math.min(0.3, raw));
      this.camera.position.lerp(this.camGoal, k);
      this.controls.target.lerp(this.targetGoal, k);
      if (this.camera.position.distanceTo(this.camGoal) < 1) {
        this.camGoal = null;
        this.targetGoal = null;
      }
    }
    this.controls.update();
    if (this.fire.visible) {
      // close up the top of the beacon leaves the frame and the tag would be hidden with it
      const d = this.camera.position.distanceTo(this.fire.position);
      this.fireTag.obj.position.y = Math.min(122, Math.max(16, d * 0.12));
    }
    if (this.particles) {
      let i = 0;
      for (const p of this.parts) {
        const v = this.velocity.get(p.aw.id) ?? 0;
        const visible = Math.abs(v) > 0.08;
        if (!this.reduced && visible) {
          p.u += (v * 22 * dt) / Math.max(1, p.aw.length);
          p.u -= Math.floor(p.u);
        }
        const [a, b] = this.awEnds.get(p.aw.id)!;
        tmpW.copy(a).lerp(b, p.u);
        tmpV.subVectors(b, a).normalize();
        if (v < 0) tmpV.negate();
        tmpQ.setFromUnitVectors(UP, tmpV);
        const r = tubeRadius(p.aw);
        tmpS.set(visible ? r * 1.6 : 0.0001, visible ? 18 : 0.0001, visible ? r * 1.6 : 0.0001);
        tmpM.compose(tmpW, tmpQ, tmpS);
        this.particles.setMatrixAt(i++, tmpM);
      }
      this.particles.instanceMatrix.needsUpdate = true;
    }
    let n = 0;
    for (const line of this.routeLines) {
      const step = 46;
      const phase = this.reduced ? 0 : (t * 28) % step;
      for (let d = phase; d < line.len && n < 240; d += step) {
        let j = 1;
        while (j < line.cum.length - 1 && line.cum[j] < d) j++;
        const a = line.pts[j - 1];
        const b = line.pts[j];
        const seg = line.cum[j] - line.cum[j - 1] || 1;
        tmpW.copy(a).lerp(b, (d - line.cum[j - 1]) / seg);
        tmpV.subVectors(b, a).normalize();
        tmpQ.setFromUnitVectors(UP, tmpV);
        tmpM.compose(tmpW, tmpQ, tmpS.set(1, 1, 1));
        this.routeArrows.setMatrixAt(n++, tmpM);
      }
    }
    this.routeArrows.count = n;
    this.routeArrows.instanceMatrix.needsUpdate = true;
    if (this.fire.visible && !this.reduced) {
      this.flames.forEach((f, i) => {
        f.scale.y = (f.scale.x / 0.7) * (1 + 0.18 * Math.sin(t * (7 + i * 2.3) + i));
      });
      const pulse = (t % 1.6) / 1.6;
      (this.fireRing.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - pulse);
      this.fireRing.scale.setScalar(this.fireR * 2.6 * (1 + 0.8 * pulse));
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.layoutTags();
  };
}
