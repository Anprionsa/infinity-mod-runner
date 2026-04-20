import { useState, useRef, useCallback, type ReactNode, forwardRef } from "react";

interface Props {
  children: ReactNode;
  height: number;
  onHeightChange: (h: number) => void;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  onScroll?: () => void;
}

/** Walk up the DOM and find the nearest ancestor whose STYLE is overflow-y
 * auto or scroll. We intentionally DO NOT gate on `scrollHeight > clientHeight`
 * because at drag start that ancestor usually hasn't overflowed yet — but it
 * will once the panel grows. Gating would return `window` prematurely, and
 * this app runs inside a body with `overflow: hidden; height: 100vh` so
 * `window.scrollBy` is a no-op. */
function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return null;
}

const ResizablePanel = forwardRef<HTMLDivElement, Props>(function ResizablePanel(
  {
    children,
    height,
    onHeightChange,
    minHeight = 80,
    maxHeight,
    className = "",
    style = {},
    onScroll,
  },
  ref,
) {
  const [dragging, setDragging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Keep the live height in a ref so the edge-drag timer and accumulating
  // deltas can mutate it without racing React state updates (setState is
  // async; two consecutive increments would both read the same stale value).
  const liveHeight = useRef(height);
  liveHeight.current = height;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);

      const effectiveMax = maxHeight ?? 10000;
      // Accumulating-delta drag: each mousemove event adds
      // (clientY - lastClientY) to the height. Height is NOT a function of
      // absolute cursor position, so the cursor hitting the viewport edge
      // no longer caps growth — the user can release, re-grab the handle
      // (now at a lower screen position), and continue dragging.
      let lastClientY = e.clientY;
      let edgeTimer: ReturnType<typeof setInterval> | null = null;
      const scroller = findScrollableAncestor(wrapperRef.current);

      const applyHeight = (h: number) => {
        const clamped = Math.min(effectiveMax, Math.max(minHeight, h));
        liveHeight.current = clamped;
        onHeightChange(clamped);
      };

      const scrollToBottom = () => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      };

      const onMouseMove = (ev: MouseEvent) => {
        const dy = ev.clientY - lastClientY;
        lastClientY = ev.clientY;
        if (dy !== 0) {
          applyHeight(liveHeight.current + dy);
        }

        // If the cursor is within EDGE_PX of the viewport bottom, start a
        // timer that grows the panel at a fixed rate — independent of the
        // cursor position. This lets the user keep growing past the
        // viewport edge. Keep-growing tick also scrolls the parent so the
        // handle stays visible.
        const EDGE_PX = 60;
        const distFromBottom = window.innerHeight - ev.clientY;
        if (distFromBottom < EDGE_PX) {
          if (!edgeTimer) {
            edgeTimer = setInterval(() => {
              // Growth speed scales with how close to the edge the cursor
              // is (pinned to viewport bottom = max speed). Independent of
              // mouse movement so a still cursor at the edge still grows.
              const dist = Math.max(0, window.innerHeight - lastClientY);
              const speed = Math.max(8, EDGE_PX - dist);
              applyHeight(liveHeight.current + speed);
              scrollToBottom();
            }, 32); // ~30fps — smooth without burning CPU
          }
        } else if (edgeTimer) {
          clearInterval(edgeTimer);
          edgeTimer = null;
        }
      };

      const onMouseUp = () => {
        setDragging(false);
        if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [minHeight, maxHeight, onHeightChange],
  );

  return (
    <div ref={wrapperRef} style={{ height, display: "flex", flexDirection: "column" }}>
      <div
        ref={ref}
        className={`resizable-panel ${className}`}
        style={{ ...style, flex: 1, overflow: "auto", minHeight: 0 }}
        onScroll={onScroll}
      >
        {children}
      </div>
      <div
        className={`resize-handle ${dragging ? "dragging" : ""}`}
        onMouseDown={onMouseDown}
        style={{ position: "relative", flexShrink: 0 }}
      />
    </div>
  );
});

export default ResizablePanel;

/** Compute a sensible "fit to viewport" log height (~75% of window height).
 * Exported so call sites can bind a "Fit" button without re-implementing the
 * calculation. Ensures we never go below 200px (useful when the app launches
 * maximized on a tiny window). */
export function computeFitHeight(): number {
  return Math.max(200, Math.floor(window.innerHeight * 0.75));
}
