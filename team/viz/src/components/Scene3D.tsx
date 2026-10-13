import { useEffect, useMemo, useRef } from "react";
import { airways } from "../data/geometry";
import { useStore } from "../data/store";
import { MineScene, ViewPreset } from "../scene/MineScene";

type Props = {
  selected: string | null;
  onSelect: (name: string | null) => void;
  view: ViewPreset;
  viewNonce: number;
};

export function Scene3D({ selected, onSelect, view, viewNonce }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<MineScene | null>(null);
  const built = useRef(0);
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
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = scene.current;
    if (!s || !aws.length) return;
    if (built.current !== count) {
      s.build(aws, things);
      built.current = count;
    } else {
      s.update(things);
    }
  }, [version, aws]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => scene.current?.select(selected), [selected]);
  useEffect(() => scene.current?.setView(view), [view, viewNonce]);

  return (
    <div className="scene" ref={host}>
      <noscript>3D-вид требует JavaScript и WebGL.</noscript>
      <p className="scene-fallback">3D-вид недоступен: браузер не поддерживает WebGL. Используйте вкладку «Схема».</p>
    </div>
  );
}
