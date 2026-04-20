import type { ReactNode } from "react";

/** Shared empty-state block used at the top of Mods / Ready Check / Install
 * panels when a first-time user lands on them with no inputs loaded.
 * Goal: explain "what does this tab need, and how do I get it" in plain
 * English, with one-click affordances to either jump to the right tab or
 * open an external resource.
 *
 * Visual language: borrows the `.phase-banner` family but deliberately
 * subdued (neutral `gold` palette, not an alert color) so it reads as
 * guidance, not a warning.
 *
 * Not shown on returning-user launches because each panel gates its own
 * rendering of this block on an "inputs empty" predicate.
 */
interface Props {
  title: string;
  body: string;
  /** Optional actions. Render as a row of buttons below the body. The
   * first action is styled as primary; the rest are secondary. If a
   * caller needs custom button ordering (e.g. "Import" primary but
   * "Open Forge" to the right), just reorder the array. */
  actions?: Array<{
    label: string;
    onClick: () => void;
    /** Force this button into primary styling regardless of position.
     * Use when the "right answer" isn't the first action by layout. */
    primary?: boolean;
  }>;
  /** Optional extra content rendered after `body` and before `actions`
   * — e.g. a small inline note, or a link callout. Kept as ReactNode so
   * callers can drop in anchors without needing another prop. */
  children?: ReactNode;
}

export default function EmptyState({ title, body, actions, children }: Props) {
  return (
    <div
      className="phase-banner gold"
      style={{
        marginBottom: 16,
        padding: "14px 18px",
        letterSpacing: 0,
        textTransform: "none",
        fontWeight: 400,
      }}
    >
      <div
        style={{
          fontFamily: "Cinzel, serif",
          fontSize: 15,
          fontWeight: 600,
          color: "var(--gold)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, color: "var(--tx)", lineHeight: 1.5, marginBottom: children || actions ? 10 : 0 }}>
        {body}
      </div>
      {children}
      {actions && actions.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: children ? 10 : 0 }}>
          {actions.map((a, i) => (
            <button
              key={i}
              className={`btn${a.primary || i === 0 ? " btn-primary" : ""}`}
              style={{ fontSize: 12, padding: "4px 14px" }}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
