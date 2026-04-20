declare const __APP_VERSION__: string;

/** App version, injected at build time from package.json via vite.config.ts `define`. */
export const APP_VERSION: string = __APP_VERSION__;
