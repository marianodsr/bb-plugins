// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * The live inline size of an element, for layouts that switch on container
 * width (a 420 px side panel versus a full page) rather than on the window.
 * Prefer Tailwind `@container` classes for pure styling; use this when the
 * structure changes (margin rail versus folded comments).
 *
 * ```tsx
 * const { ref, width } = useContainerWidth<HTMLDivElement>();
 * const wide = width >= 880;
 * return <div ref={ref}>{wide ? <Rail /> : <Folded />}</div>;
 * ```
 *
 * `width` is 0 until the first measurement, which happens before paint.
 */
export function useContainerWidth<T extends HTMLElement = HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const node = useRef<T | null>(null);

  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    node.current = element;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    observer.current = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      setWidth((prev) => (Math.abs(prev - size) < 0.5 ? prev : size));
    });
    observer.current.observe(element);
  }, []);

  useLayoutEffect(() => () => observer.current?.disconnect(), []);

  return { ref, width, element: node };
}
