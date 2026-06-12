import { Canvas } from "fabric/*";
import { RefObject, useEffect } from "react";
import { useDebounce } from "./debounce";

export default function useDebounceFabric<T>(
  canvas: RefObject<Canvas | undefined>,
  name: string,
  target: T,
  setTarget: (value: T) => void,
  timeout = 100
) {
  const debounced = useDebounce(target, timeout);

  useEffect(() => {
    const selected = canvas.current?.getActiveObject();

    if (selected) {
      const payload: { [name: string]: T } = {};
      payload[name] = debounced;

      selected.set(payload);
      canvas.current?.renderAll();
    }
    setTarget(debounced);
  }, [debounced]);
}
