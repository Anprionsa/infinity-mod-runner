/** Infinity Engine game targets the Runner knows about. Used by:
 *   - `AppConfig` game-dir fields (one per kind)
 *   - Multi-game backup system (each backup is tied to a GameKind)
 *   - Setup tab path rows
 *
 * `bg1` and `bg2` are the primary EET install targets. `iwd` / `iwd2` / `pst`
 * are optional — users who run cross-game mods that touch these installs
 * get backup/restore coverage when they configure the paths. */
export type GameKind = "bg1" | "bg2" | "iwd" | "iwd2" | "pst";

export const GAME_KINDS: readonly GameKind[] = ["bg1", "bg2", "iwd", "iwd2", "pst"] as const;

export const GAME_LABELS: Record<GameKind, string> = {
  bg1: "BG:EE (+ SoD)",
  bg2: "BG2:EE",
  iwd: "IWD:EE",
  iwd2: "Icewind Dale II",
  pst: "Planescape: Torment EE",
};

/** `AppConfig` key that stores the configured directory for each game. */
export const GAME_CONFIG_KEYS: Record<GameKind, "bg1_game_dir" | "bg2_game_dir" | "iwd_game_dir" | "iwd2_game_dir" | "pst_game_dir"> = {
  bg1: "bg1_game_dir",
  bg2: "bg2_game_dir",
  iwd: "iwd_game_dir",
  iwd2: "iwd2_game_dir",
  pst: "pst_game_dir",
};

/** `AppConfig` key for the optional per-game backup directory override.
 * When set (non-null), the Backup panel uses THIS path for that game
 * instead of the global `backup_directory`. Useful when games live on
 * different drives and you want their backups co-located. */
export const GAME_BACKUP_DIR_KEYS: Record<GameKind, "backup_directory_bg1" | "backup_directory_bg2" | "backup_directory_iwd" | "backup_directory_iwd2" | "backup_directory_pst"> = {
  bg1: "backup_directory_bg1",
  bg2: "backup_directory_bg2",
  iwd: "backup_directory_iwd",
  iwd2: "backup_directory_iwd2",
  pst: "backup_directory_pst",
};

/** Games that are considered "core EET" — always shown in the Setup
 * wizard's required paths section. The others live under "Additional
 * games (optional)" and fold away by default. */
export const CORE_EET_GAMES: readonly GameKind[] = ["bg1", "bg2"] as const;
export const OPTIONAL_GAMES: readonly GameKind[] = ["iwd", "iwd2", "pst"] as const;
