/** WeiDU's language codes (what the installer passes via --language).
 *
 * These are the locale-style codes WeiDU itself expects, distinct from the
 * app UI language codes. The list follows the common BG:EE / BG2:EE install
 * locales. Users can still enter a custom code via the "Other..." option. */
export interface WeiduLanguage {
  code: string;
  label: string;
}

export const WEIDU_LANGUAGES: WeiduLanguage[] = [
  { code: "en_US",    label: "English (US)" },
  { code: "de_DE",    label: "Deutsch" },
  { code: "fr_FR",    label: "Français" },
  { code: "es_ES",    label: "Español" },
  { code: "it_IT",    label: "Italiano" },
  { code: "pl_PL",    label: "Polski" },
  { code: "ru_RU",    label: "Русский" },
  { code: "cs_CZ",    label: "Čeština" },
  { code: "hu_HU",    label: "Magyar" },
  { code: "tr_TR",    label: "Türkçe" },
  { code: "pt_BR",    label: "Português (BR)" },
  { code: "pt_PT",    label: "Português (PT)" },
  { code: "sv_SE",    label: "Svenska" },
  { code: "nl_NL",    label: "Nederlands" },
  { code: "ja_JP",    label: "日本語" },
  { code: "ko_KR",    label: "한국어" },
  { code: "zh_CN",    label: "简体中文" },
  { code: "zh_TW",    label: "繁體中文" },
];

/** Fallback WeiDU language when the user's choice isn't supported by a mod. */
export const WEIDU_LANGUAGE_FALLBACK = "en_US";

/** True when the given code is in the known list. */
export function isKnownWeiduLanguage(code: string): boolean {
  return WEIDU_LANGUAGES.some((l) => l.code === code);
}
