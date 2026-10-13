import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { Airway, HORIZONS, pointOn, SURFACE_Z, toWorld, worldY, XYZ, smokeCells, placeOf } from "../data/geometry";
import { attr, parseJson, prop, Thing } from "../data/store";
import { COLORS, crewColor, sensorColor } from "../data/status";

type Pick = (name: string | null) => void;

const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const airC = new THREE.Color(COLORS.air);
const smokeC = new THREE.Color(COLORS.smoke);
const denseC = new THREE.Color(COLORS.smokeDense);

function w(p: XYZ) {
  const [x, y, z] = toWorld(p);
  return new THREE.Vector3(x, y, z);
}

function label(text: string, cls = "lbl") {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

type Particle = { aw: Airway; u: number };

export type ViewPreset = "overview" | "h-480" | "h-560" | "h-640";

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
  private tube?: THREE.InstancedMesh;
  private cellRange = new Map<string, [number, number]>();
  private cellOwner: string[] = [];
  private particles?: THREE.InstancedMesh;
  private parts: Particle[] = [];
  private velocity = new Map<string, number>();
  private objects = new Map<string, THREE.Mesh>();
  private crewLabels = new Map<string, CSS2DObject>();
  private pickables: THREE.Object3D[] = [];
  private fire: THREE.Group;
  private fireCore: THREE.Mesh;
  private fireLight: THREE.PointLight;
  private fireLabel: CSS2DObject;
  private estimate: THREE.Mesh;
  private estimateLabel: CSS2DObject;
  private selected: string | null = null;
  private selBox: THREE.BoxHelper | null = null;
  private resize: ResizeObserver;
  private camGoal: THREE.Vector3 | null = null;
  private targetGoal: THREE.Vector3 | null = null;
  private down = { x: 0, y: 0 };
  private view: ViewPreset = "overview";
  private userMoved = false;

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
    this.controls.minDistance = 60;
    this.controls.addEventListener("start", () => {
      this.userMoved = true;
      this.camGoal = null;
      this.targetGoal = null;
    });
    this.setView("overview", true);

    this.scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x1a1f26, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 800, 400);
    this.scene.add(sun);

    // surface reference
    const sy = worldY(SURFACE_Z);
    const grid = new THREE.GridHelper(1000, 20, 0x2a323d, 0x1c222b);
    grid.position.set(0, sy, -180);
    this.scene.add(grid);
    const surf = label("Поверхность +420 м", "lbl lbl-muted");
    surf.position.set(-470, sy + 6, 300);
    this.scene.add(surf);
    for (const h of HORIZONS) {
      const l = label(`Горизонт ${h.label}`, "lbl lbl-horizon");
      l.position.set(-420, worldY(h.z), 220);
      this.scene.add(l);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(860, 820),
        new THREE.MeshBasicMaterial({ color: 0x151a21, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(0, worldY(h.z) - 4, -190);
      this.scene.add(plate);
    }

    // fire (scenario ground truth) and the advisor estimate
    this.fire = new THREE.Group();
    this.fireCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.9 }),
    );
    this.fireLight = new THREE.PointLight(0xff6a3d, 0, 260, 1.6);
    this.fireLabel = label("Очаг", "lbl lbl-alarm");
    this.fireLabel.position.set(0, 18, 0);
    this.fire.add(this.fireCore, this.fireLight, this.fireLabel);
    this.fire.visible = false;
    this.scene.add(this.fire);
    this.estimate = new THREE.Mesh(
      new THREE.TorusGeometry(16, 1.4, 8, 40),
      new THREE.MeshBasicMaterial({ color: COLORS.warn }),
    );
    this.estimate.rotation.x = Math.PI / 2;
    this.estimateLabel = label("Оценка советчика", "lbl lbl-warn");
    this.estimateLabel.position.set(0, 0, -24);
    this.estimate.add(this.estimateLabel);
    this.estimate.visible = false;
    this.scene.add(this.estimate);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) this.pick(e);
    });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
    this.container.removeChild(this.labels.domElement);
  }

  private fit() {
    const { clientWidth: wdt, clientHeight: hgt } = this.container;
    if (!wdt || !hgt) return;
    this.renderer.setSize(wdt, hgt);
    this.labels.setSize(wdt, hgt);
    this.camera.aspect = wdt / hgt;
    this.camera.fov = wdt < 640 ? 55 : 42;
    this.labels.domElement.classList.toggle("is-compact", wdt < 640);
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.setView(this.view, true);
  }

  /** Camera position and target that fit `box` on screen when looking along `dir`. */
  private frame(box: THREE.Box3, dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
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
      dist *= Math.max((x1 - x0) / 2, (y1 - y0) / 2) / 0.94;
    }
    return [center.clone().addScaledVector(d, dist), center];
  }

  setView(preset: ViewPreset, instant = false) {
    this.view = preset;
    this.userMoved = false;
    let box: THREE.Box3;
    let dir: THREE.Vector3;
    if (preset === "overview") {
      const labelRoom = this.container.clientWidth < 640 ? -450 : -560;
      box = new THREE.Box3(new THREE.Vector3(labelRoom, worldY(-640) - 10, -600), new THREE.Vector3(440, worldY(SURFACE_Z) + 10, 300));
      dir = new THREE.Vector3(0.45, 0.45, 1);
    } else {
      const y = worldY(HORIZONS.find((h) => h.id === preset)!.z);
      box = new THREE.Box3(new THREE.Vector3(-480, y - 10, -600), new THREE.Vector3(440, y + 10, 240));
      dir = new THREE.Vector3(0.12, 1, 0.8);
    }
    const [cam, tgt] = this.frame(box, dir);
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

  /** Build static geometry once the airway twins are known. */
  build(airways: Airway[], things: Record<string, Thing>) {
    if (this.tube) {
      this.scene.remove(this.tube);
      this.tube.dispose();
    }
    if (this.particles) {
      this.scene.remove(this.particles);
      this.particles.dispose();
    }
    this.airways = airways;
    this.awById = new Map(airways.map((a) => [a.id, a]));
    const total = airways.reduce((n, a) => n + a.cells, 0);
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.tube = new THREE.InstancedMesh(geo, mat, total);
    this.cellOwner = [];
    let k = 0;
    for (const aw of airways) {
      const r = Math.sqrt(aw.area) * (aw.kind === "shaft" ? 0.55 : 0.62);
      this.cellRange.set(aw.id, [k, aw.cells]);
      for (let i = 0; i < aw.cells; i++) {
        const p0 = w(pointOn(aw, i / aw.cells));
        const p1 = w(pointOn(aw, (i + 1) / aw.cells));
        const len = p0.distanceTo(p1);
        tmpV.subVectors(p1, p0).normalize();
        tmpQ.setFromUnitVectors(UP, tmpV);
        tmpS.set(r, len * 1.02, r);
        tmpM.compose(p0.clone().add(p1).multiplyScalar(0.5), tmpQ, tmpS);
        this.tube.setMatrixAt(k, tmpM);
        this.tube.setColorAt(k, airC);
        this.cellOwner[k] = aw.id;
        k++;
      }
    }
    this.tube.instanceMatrix.needsUpdate = true;
    this.tube.userData.kind = "airways";
    this.scene.add(this.tube);

    this.parts = [];
    for (const aw of airways) {
      const n = Math.max(2, Math.round(aw.length / 140));
      for (let i = 0; i < n; i++) this.parts.push({ aw, u: (i + 0.5) / n });
    }
    const cone = new THREE.ConeGeometry(2.2, 7, 6);
    this.particles = new THREE.InstancedMesh(
      cone,
      new THREE.MeshBasicMaterial({ color: 0xd7e6f5, transparent: true, opacity: 0.85 }),
      this.parts.length,
    );
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    this.buildObjects(things);
    this.update(things);
  }

  private addObject(name: string, mesh: THREE.Mesh, pos: THREE.Vector3) {
    mesh.position.copy(pos);
    mesh.userData.name = name;
    this.objects.set(name, mesh);
    this.pickables.push(mesh);
    this.scene.add(mesh);
  }

  private buildObjects(things: Record<string, Thing>) {
    for (const m of this.objects.values()) this.scene.remove(m);
    this.objects.clear();
    this.pickables = [];
    const mat = (c: string) => new THREE.MeshLambertMaterial({ color: c, transparent: true });
    for (const [name, t] of Object.entries(things)) {
      const kind = String(t.attributes?.kind ?? "");
      const p = placeOf(things, name);
      if (kind === "gas-station" && p) {
        this.addObject(name, new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), mat(COLORS.grey)), w(p).add(new THREE.Vector3(0, 7, 0)));
      } else if (kind === "fire-door" && p) {
        const aw = this.awById.get("aw-" + String(t.attributes.airway).split(":")[1]?.slice(3));
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 11, 11), mat(COLORS.equip));
        if (aw) {
          const d = w(aw.b).sub(w(aw.a)).normalize();
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
        }
        this.addObject(name, mesh, w(p));
      } else if (kind === "valve" && p) {
        this.addObject(name, new THREE.Mesh(new THREE.OctahedronGeometry(3.6), mat(COLORS.grey)), w(p).add(new THREE.Vector3(0, 6, 0)));
      } else if ((kind === "lhd" || kind === "truck") && p) {
        this.addObject(name, new THREE.Mesh(new THREE.BoxGeometry(kind === "truck" ? 12 : 9, 5, 5), mat(COLORS.equip)), w(p));
      } else if ((kind === "drill" || kind === "bolter") && p) {
        this.addObject(name, new THREE.Mesh(new THREE.BoxGeometry(8, 5, 5), mat(COLORS.equip)), w(p));
      } else if (kind === "crew" && p) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(4.6, 16, 12), mat(COLORS.white));
        const l = label("", "lbl lbl-crew");
        l.position.set(0, 10, 0);
        mesh.add(l);
        this.crewLabels.set(name, l);
        this.addObject(name, mesh, w(p));
      } else if (kind === "refuge" && p) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 16), new THREE.MeshLambertMaterial({ color: COLORS.ok, transparent: true, opacity: 0.35 }));
        const l = label("Убежище", "lbl lbl-ok");
        l.position.set(0, 12, 0);
        mesh.add(l);
        this.addObject(name, mesh, w(p).add(new THREE.Vector3(14, 0, 14)));
      } else if (kind === "substation") {
        const node = String(t.attributes.node ?? "");
        const pos = this.nodePos(node);
        if (pos) this.addObject(name, new THREE.Mesh(new THREE.BoxGeometry(7, 7, 7), mat(COLORS.grey)), pos.add(new THREE.Vector3(-14, 4, 10)));
      } else if (["crusher", "conveyor", "charger", "depot"].includes(kind) && p) {
        this.addObject(name, new THREE.Mesh(new THREE.BoxGeometry(10, 7, 10), mat(COLORS.grey)), w(p).add(new THREE.Vector3(0, 0, 12)));
      } else if (kind === "fan") {
        const pos = this.nodePos("VS0");
        if (pos) {
          const off = name === "fan-1" ? -14 : 14;
          const mesh = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 6, 16), mat(COLORS.grey));
          mesh.rotation.z = Math.PI / 2;
          this.addObject(name, mesh, pos.add(new THREE.Vector3(off, 8, 0)));
        }
      }
    }
    const shaftLabels: [string, string, number, number][] = [
      ["CS0", "Клетевой ствол", -40, 34],
      ["SS0", "Скиповой ствол", 50, 16],
      ["VS0", "Вентствол, ГВУ", 0, 26],
    ];
    for (const [name, text, dx, dy] of shaftLabels) {
      const pos = this.nodePos(name);
      if (pos) {
        const l = label(text, "lbl lbl-muted");
        l.position.copy(pos).add(new THREE.Vector3(dx, dy, 0));
        this.scene.add(l);
      }
    }
  }

  private nodePos(node: string): THREE.Vector3 | null {
    for (const aw of this.airways) {
      if (aw.frm === node) return w(aw.a);
      if (aw.to === node) return w(aw.b);
    }
    return null;
  }

  update(things: Record<string, Thing>) {
    if (!this.tube) return;
    for (const aw of this.airways) {
      const range = this.cellRange.get(aw.id);
      if (!range) continue;
      const cells = smokeCells(things, aw);
      for (let i = 0; i < range[1]; i++) {
        const s = Math.min(1, cells[i] ?? 0);
        if (s < 0.5) tmpC.copy(airC).lerp(smokeC, s * 2);
        else tmpC.copy(smokeC).lerp(denseC, (s - 0.5) * 2);
        this.tube.setColorAt(range[0] + i, tmpC);
      }
      this.velocity.set(aw.id, Number(prop(things, aw.id, "velocity") ?? 0));
    }
    if (this.tube.instanceColor) this.tube.instanceColor.needsUpdate = true;

    for (const [name, mesh] of this.objects) {
      const kind = String(things[name]?.attributes?.kind ?? "");
      const m = mesh.material as THREE.MeshLambertMaterial;
      if (kind === "gas-station") {
        m.color.set(sensorColor(String(prop(things, name, "state") ?? "ok")));
      } else if (kind === "fire-door") {
        const st = String(prop(things, name, "position") ?? "open");
        const closed = Number(prop(things, name, "closed") ?? 0) / 100;
        m.color.set(st === "fault" ? COLORS.alarm : closed > 0.02 ? COLORS.info : COLORS.equip);
        m.opacity = 0.25 + 0.75 * closed;
      } else if (kind === "valve") {
        const st = String(prop(things, name, "position") ?? "");
        const normal = String(attr(things, name, "normal") ?? "");
        m.color.set(st === "fault" ? COLORS.alarm : st !== normal ? COLORS.info : COLORS.grey);
      } else if (kind === "lhd" || kind === "truck") {
        const p = placeOf(things, name);
        if (p) mesh.position.copy(w(p)).add(new THREE.Vector3(0, 3, 0));
        const aw = this.awById.get("aw-" + String(prop(things, name, "location") ?? ""));
        if (aw) {
          const d = w(aw.b).sub(w(aw.a)).normalize();
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
        }
        const fire = prop(things, name, "fire_alarm") === true;
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(fire ? COLORS.alarm : st === "parked" ? "#6b7685" : COLORS.equip);
      } else if (kind === "crew") {
        const p = placeOf(things, name);
        if (p) mesh.position.copy(w(p)).add(new THREE.Vector3(0, 5, 0));
        const st = String(prop(things, name, "state") ?? "working");
        const fed = Number(prop(things, name, "fed") ?? 0);
        m.color.set(crewColor(st, fed));
        mesh.visible = st !== "surface";
        const l = this.crewLabels.get(name);
        if (l) {
          l.element.textContent = String(prop(things, name, "people") ?? "");
          l.visible = mesh.visible;
        }
      } else if (kind === "substation") {
        m.color.set(prop(things, name, "power") === "off" ? COLORS.info : COLORS.grey);
      } else if (["crusher", "conveyor", "charger", "depot"].includes(kind)) {
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(st === "fire" ? COLORS.alarm : ["stopped", "de-energized"].includes(st) ? COLORS.info : COLORS.grey);
      } else if (kind === "fan") {
        const st = String(prop(things, name, "state") ?? "");
        m.color.set(st === "tripped" ? COLORS.alarm : st === "reversing" || prop(things, name, "rotation") === "reverse" ? COLORS.warn : st === "running" ? COLORS.equip : "#56606e");
      }
    }

    // fire from the scenario ground truth (training mode), not used by the advisor
    const truth = parseJson<{ airway: string; s: number; hrr_mw: number; extinct: boolean } | null>(prop(things, "control", "fire_truth"), null);
    const fAw = truth ? this.awById.get("aw-" + truth.airway) : undefined;
    if (truth && fAw && !truth.extinct && truth.hrr_mw > 0.05) {
      this.fire.visible = true;
      this.fire.position.copy(w(pointOn(fAw, truth.s)));
      const r = 4 + Math.sqrt(truth.hrr_mw) * 3.2;
      this.fireCore.scale.setScalar(r);
      this.fireLight.intensity = 2 + truth.hrr_mw * 1.5;
      this.fireLabel.element.textContent = `Очаг ${truth.hrr_mw.toFixed(1)} МВт`;
      this.fireLabel.position.set(0, r + 8, 0);
    } else {
      this.fire.visible = false;
    }
    const est = parseJson<{ edge: string; s: number } | null>(prop(things, "advisor", "estimate"), null);
    const eAw = est ? this.awById.get("aw-" + est.edge) : undefined;
    if (est && eAw) {
      this.estimate.visible = true;
      this.estimate.position.copy(w(pointOn(eAw, est.s)));
    } else {
      this.estimate.visible = false;
    }
    this.highlight();
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
    const hits = ray.intersectObjects([...this.pickables.filter((p) => p.visible), ...(this.tube ? [this.tube] : [])], false);
    if (!hits.length) {
      this.onPick(null);
      return;
    }
    const h = hits[0];
    if (h.object === this.tube && h.instanceId !== undefined) this.onPick(this.cellOwner[h.instanceId]);
    else this.onPick(String(h.object.userData.name));
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.camGoal && this.targetGoal) {
      const k = 1 - Math.pow(0.002, dt);
      this.camera.position.lerp(this.camGoal, k);
      this.controls.target.lerp(this.targetGoal, k);
      if (this.camera.position.distanceTo(this.camGoal) < 1) {
        this.camGoal = null;
        this.targetGoal = null;
      }
    }
    this.controls.update();
    if (this.particles) {
      let i = 0;
      for (const p of this.parts) {
        const v = this.velocity.get(p.aw.id) ?? 0;
        const visible = Math.abs(v) > 0.08;
        if (!this.reduced && visible) {
          p.u += (v * 22 * dt) / Math.max(1, p.aw.length);
          p.u -= Math.floor(p.u);
        }
        const pos = w(pointOn(p.aw, p.u));
        tmpV.copy(w(p.aw.b)).sub(w(p.aw.a)).normalize();
        if (v < 0) tmpV.negate();
        tmpQ.setFromUnitVectors(UP, tmpV);
        tmpS.setScalar(visible ? 1 : 0.0001);
        tmpM.compose(pos, tmpQ, tmpS);
        this.particles.setMatrixAt(i++, tmpM);
      }
      this.particles.instanceMatrix.needsUpdate = true;
    }
    if (this.fire.visible && !this.reduced) {
      const t = performance.now() / 1000;
      (this.fireCore.material as THREE.MeshBasicMaterial).opacity = 0.75 + 0.2 * Math.sin(t * 6);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
