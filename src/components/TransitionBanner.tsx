import type { ReactNode } from "react";

/** A per-session "progress" banner that shows up at the top of a tab when
 * the *previous* step just completed. Example: when the user fills Setup
 * and switches to Mods, the Mods tab shows a green "Setup complete —
 * import your mod list to continue" banner until they dismiss it or
 * import a log.
 *
 * Ephemeral by design — state is not persisted. A returning user whose
 * Setup is already valid at launch doesn't see a "Setup complete" banner
 * because no transition fired on launch. This keeps the banners from
 * becoming persistent chrome that returning users have to scroll past.
 *
 * Callers drive visibility themselves (via a useState/Map held higher
 * up — see App.tsx's transitionBanners state). This component is just
 * the visual shell.
 */
interface Props {
  /** Headline — rendered bold + green. "Setup complete", "Mods imported", etc. */
  headline: string;
  /** Body copy — the "do this next" pitch. */
  body: string;
  /** Primary action button on the right. */
  primary?: { label: string; onClick: () => void };
  /** Secondary action(s). Rendered before the primary button. */
  secondary?: Array<{ label: string; onClick: () => void }>;
  /** Called when the user clicks the dismiss × button. Session-only. */
  onDismiss: () => void;
  /** Optional extra content (rarely needed — keep banners compact). */
  children?: ReactNode;
}

export default function TransitionBanner({
  headline,
  body,
  primary,
  secondary,
  onDismiss,
  children,
}: Props) {
  return (
    <div className="transition-banner">
      <div className="tb-copy">
        <strong>{headline}</strong>
        {"\u2003"}
        {body}
        {children}
      </div>
      <div className="tb-actions">
        {secondary?.map((a, i) => (
          <button
            key={i}
            className="btn"
            style={{ fontSize: 12, padding: "4px 12px" }}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
        {primary && (
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: "4px 14px" }}
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        )}
        <button
          className="tb-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          {"\u00d7"}
        </button>
      </div>
    </div>
  );
}
