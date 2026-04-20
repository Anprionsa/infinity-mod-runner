import { useState, useRef, useCallback, type ReactNode, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";

/** Reusable tooltip — renders a styled floating panel via React portal so it
 * escapes ancestor stacking contexts and overflow clipping. Position is
 * computed on hover.
 *
 * Styled content slots (all CSS classes defined in theme.css):
 *   .tip-title — Cinzel gold, bold, title line
 *   .tip-meta  — cyan, small meta line (mod, version, etc.)
 *   .tip-desc  — dimmed, body text
 *   .tip-warn  — orange + bold, "heads up" line
 *
 * Ported from Forge's `Tip` function component (index.html:3615).
 */
interface TipProps {
  /** The tooltip body. Pass `null` / `undefined` to disable the tooltip
   * entirely — the children render without any hover behavior. */
  content: ReactNode | null | undefined;
  children: ReactNode;
  className?: string;
  /** Inline style forwarded to the host span. Use this when wrapping
   * block-level children inside a flex/grid layout, e.g. `{ display: "block" }`
   * to override the default `inline-block`, or `{ display: "contents" }` to
   * let children inherit grid/flex placement from the grandparent. */
  style?: CSSProperties;
}

interface TipPos {
  x: number;
  y: number;
  placement: "top" | "bottom";
  arrowOffset: number;
}

interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** When display:contents is applied to the host, its own bounding box is
 * (0,0,0,0). Fall back to the union of child rects so the tooltip anchors
 * to visible content instead of the origin. */
function resolveAnchorRect(el: HTMLElement | null): AnchorRect | null {
  if (!el) return null;
  const own = el.getBoundingClientRect();
  if (own.width > 0 || own.height > 0) {
    return {
      left: own.left, top: own.top, right: own.right, bottom: own.bottom,
      width: own.width, height: own.height,
    };
  }
  let u: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const child of Array.from(el.children)) {
    const rc = resolveAnchorRect(child as HTMLElement);
    if (!rc) continue;
    if (!u) u = { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom };
    else {
      u.left = Math.min(u.left, rc.left);
      u.top = Math.min(u.top, rc.top);
      u.right = Math.max(u.right, rc.right);
      u.bottom = Math.max(u.bottom, rc.bottom);
    }
  }
  if (!u) return null;
  return {
    left: u.left, top: u.top, right: u.right, bottom: u.bottom,
    width: u.right - u.left, height: u.bottom - u.top,
  };
}

export default function Tip({ content, children, className, style }: TipProps) {
  const [tip, setTip] = useState<TipPos | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);

  const show = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    if (!hostRef.current) return;
    let r: AnchorRect | null = resolveAnchorRect(hostRef.current);
    // Final fallback to mouse coords if we still got nothing usable
    if (!r || (r.width === 0 && r.height === 0)) {
      if (e && e.clientX != null) {
        r = {
          left: e.clientX - 8,
          top: e.clientY - 8,
          right: e.clientX + 8,
          bottom: e.clientY + 8,
          width: 16,
          height: 16,
        };
      } else {
        return;
      }
    }
    const vw = window.innerWidth;
    const placement: "top" | "bottom" = r.top < 140 ? "bottom" : "top";
    // Gap must exceed the 7px arrow height so the arrow never extends
    // past the tooltip offset into the adjacent row. With a 6px gap the
    // arrow (7px tall, anchored at tooltip edge) overshot by 1px into
    // the line above the anchor — visible in tight-gap layouts like the
    // stats row's BCS readout, where the ETA row sits 2px above and the
    // arrow was visibly covering its trailing "remaining" text. 10px
    // gap leaves 3px of clean space between arrow tip and anchor.
    const y = placement === "top" ? r.top - 10 : r.bottom + 10;
    // Anchor center: where the arrow wants to point.
    const anchorX = r.left + r.width / 2;
    // Tooltip box center clamped into viewport so it never hangs off-screen.
    const x = Math.min(Math.max(anchorX, 170), vw - 170);
    // Arrow offset from tooltip center — clamped to ±150px so it stays
    // inside the visible tooltip regardless of content width.
    const arrowOffset = Math.max(-150, Math.min(anchorX - x, 150));
    setTip({ x, y, placement, arrowOffset });
  }, []);

  const hide = useCallback(() => setTip(null), []);

  if (!content) return <>{children}</>;

  return (
    <>
      <span
        ref={hostRef}
        className={"ui-tip-host" + (className ? ` ${className}` : "")}
        style={style}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {children}
      </span>
      {tip && createPortal(
        <div
          className={`ui-tip-float ui-tip-${tip.placement}`}
          style={{
            left: tip.x,
            top: tip.y,
            ["--tip-arrow-offset" as string]: `${tip.arrowOffset}px`,
          } as CSSProperties}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
