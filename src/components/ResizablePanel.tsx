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
  const startY = useRef(0);
  const startH = useRef(height);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      startY.current = e.clientY;
      startH.current = height;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY.current;
        const effectiveMax = maxHeight ?? 10000; // Effectively unlimited — parent container constrains
        const newH = Math.min(effectiveMax, Math.max(minHeight, startH.current + delta));
        onHeightChange(newH);
      };

      const onMouseUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [height, minHeight, maxHeight, onHeightChange],
  );

  return (
    <div style={{ height, display: "flex", flexDirection: "column" }}>
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
