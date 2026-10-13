import { useEffect, useMemo, useRef } from "react";
import { airways, fireSpot } from "../data/geometry";
import { evacRoutes } from "../data/routes";
import { prop, useStore } from "../data/store";
import { MineScene, ViewPreset } from "../scene/MineScene";

type Props = {
  selected: string | null;
  onSelect: (name: string | null) => void;
  view: ViewPreset;
  viewNonce: number;
  /** fly to the fire when a scenario starts and back to the overview on reset */
  follow: boolean;
  onAutoView: (v: ViewPreset) => void;
  focus: { name: string; nonce: number } | null;
};

export function Scene3D({ selected, onSelect, view, viewNonce, follow, onAutoView, focus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<MineScene | null>(null);
  const built = useRef(0);
  const fireKey = useRef<string>("");
  const { things, version } = useStore();
  const count = Object.keys(things).length;
  const aws = useMemo(() => airways(things), [count]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!host.current) return;
    let s: MineScene;
    try {
      s = new MineScene(host.current, onSelect);
    } catch {
      host.current.dataset.nogl = "1";
      return;
    }
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
      built.current = 0;
      fireKey.current = "";
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = scene.current;
    if (!s || !aws.length) return;
    const routes = evacRoutes(things, aws);
    if (built.current !== count) {
      s.build(aws, things);
      built.current = count;
    }
    s.update(things, routes);

    const seq = String(prop(things, "control", "scenario", "seq") ?? "");
    const spot = fireSpot(things, aws);
    const key = spot ? `fire:${seq}` : String(prop(things, "control", "scenario") ?? "normal") === "normal" ? "normal" : `other:${seq}`;
    const prev = fireKey.current;
    fireKey.current = key;
    if (!follow || prev === key || (!prev && !key.startsWith("fire:"))) return;
    if (key.startsWith("fire:")) {
      s.setView("fire");
      onAutoView("fire");
    } else if (key === "normal" && s.currentView !== "overview") {
      s.setView("overview");
      onAutoView("overview");
    }
  }, [version, aws]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (follow && fireKey.current.startsWith("fire:")) {
      scene.current?.setView("fire");
      onAutoView("fire");
    }
  }, [follow]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => scene.current?.select(selected), [selected]);
  useEffect(() => scene.current?.setView(view), [view, viewNonce]);
  useEffect(() => {
    if (focus) scene.current?.focusObject(focus.name);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="scene" ref={host}>
      <noscript>3D-вид требует JavaScript и WebGL.</noscript>
      <p className="scene-fallback">3D-вид недоступен: браузер не поддерживает WebGL. Используйте вкладку «Схема».</p>
    </div>
  );
}
