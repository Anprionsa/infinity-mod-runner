/**
 * i18n — Multi-language support for EET Mod Runner.
 * Same pattern as EET Mod Forge: t(key, fallback) with flat JSON translation files.
 * English is always the fallback — no English JSON loaded at runtime.
 */

import { createContext, useContext, useState, useEffect, useMemo, useCallback } from "react";

// Supported UI languages
export const UI_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["de", "Deutsch"],
  ["fr", "Fran\u00e7ais"],
  ["pl", "Polski"],
];

// ── Context ──

interface I18nContextValue {
  t: (key: string, fallback: string) => string;
  uiLang: string;
  setUiLang: (lang: string) => void;
}

const I18nContext = createContext<I18nContextValue>({
  t: (_key, fallback) => fallback,
  uiLang: "en",
  setUiLang: () => {},
});

export function useI18n() {
  return useContext(I18nContext);
}

// ── Provider ──

interface I18nProviderProps {
  lang: string;
  onLangChange: (lang: string) => void;
  children: React.ReactNode;
}

// Vite dynamic import for translation files
const loaders: Record<string, () => Promise<Record<string, string>>> = {
  de: () => import("../lang/ui-de.json").then(m => m.default as unknown as Record<string, string>).catch(() => ({})),
  fr: () => import("../lang/ui-fr.json").then(m => m.default as unknown as Record<string, string>).catch(() => ({})),
  pl: () => import("../lang/ui-pl.json").then(m => m.default as unknown as Record<string, string>).catch(() => ({})),
};

export function I18nProvider({ lang, onLangChange, children }: I18nProviderProps) {
  const [strings, setStrings] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (lang === "en" || !loaders[lang]) {
      setStrings(null);
      return;
    }
    loaders[lang]().then(setStrings);
  }, [lang]);

  const t = useCallback((key: string, fallback: string): string => {
    if (lang === "en" || !strings) return fallback;
    return strings[key] || fallback;
  }, [lang, strings]);

  const value = useMemo(() => ({
    t,
    uiLang: lang,
    setUiLang: onLangChange,
  }), [t, lang, onLangChange]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

// ── Language Selector Component ──
// Styled to match EET Mod Forge: globe icon + language code, dropdown on click

export function LanguageSelector() {
  const { uiLang, setUiLang } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "transparent",
          border: "1px solid var(--brd)",
          color: "var(--txd)",
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 4,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
        title="UI Language"
      >
        <span style={{ fontSize: 12 }}>{"\uD83C\uDF10"}</span>
        <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5 }}>{uiLang}</span>
      </button>
      {open && (
        <>
          {/* Backdrop to close on click outside */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setOpen(false)}
          />
          <div style={{
            position: "absolute", top: "100%", right: 0, marginTop: 4,
            background: "var(--bg2, #141620)", border: "1px solid var(--brd2, #333)",
            borderRadius: 6, padding: 4, zIndex: 1000, minWidth: 130,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          }}>
            {UI_LANGUAGES.map(([code, name]) => (
              <div
                key={code}
                onClick={() => { setUiLang(code); setOpen(false); }}
                style={{
                  padding: "6px 10px", fontSize: 12, cursor: "pointer",
                  borderRadius: 4, display: "flex", alignItems: "center", gap: 8,
                  background: code === uiLang ? "var(--bg3, #1a1e2e)" : "transparent",
                  color: code === uiLang ? "var(--gold, #d4a843)" : "var(--tx, #c8ccd8)",
                }}
                onMouseEnter={(e) => { if (code !== uiLang) (e.currentTarget as HTMLDivElement).style.background = "var(--bg3, #1a1e2e)"; }}
                onMouseLeave={(e) => { if (code !== uiLang) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <span style={{ fontWeight: 600, width: 20, textTransform: "uppercase", fontSize: 10 }}>{code}</span>
                <span>{name}</span>
                {code === uiLang && <span style={{ marginLeft: "auto", fontSize: 10 }}>{"\u2713"}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
