/**
 * Install Trace — anonymized per-component timing record for Phase 7
 * baseline building. Consumed by Forge's `scripts/trace_to_baselines.ts`
 * to update `installProfile.baselineSec` on per-mod JSONs.
 *
 * Schema v1.
 */

import type { AppConfig } from "../App";
import { APP_VERSION } from "../constants/version";

// ─── Schema ───

export interface InstallTrace {
  schema: 1;
  event: "install_trace";
  id: string;
  timestamp: string;

  // Rig profile — bucketed to keep traces anonymizable
  rig: {
    os: "windows" | "linux" | "macos";
    cpuClass: "desktop" | "laptop" | "unknown";
    diskType: "nvme" | "ssd" | "hdd" | "unknown";
    /** RAM bucketed to 4GB steps so we don't emit raw byte counts */
    ramGbBucket: number;
  };

  // Accelerator state — identical keys to `accelerator-profile-ref.json`
  accelerators: {
    overrideFastDrive: boolean;
    experimentalWeidu: boolean;
    batchSize: number;
  };

  // Versioning — lets the aggregator gate on compatible traces
  runnerVersion: string;
  weiduVersion: string;

  // Install-level rollup
  totalComponents: number;
  totalDurationSec: number;
  /** True when user aborted or errors ended the run. Partial traces are
   * still useful — the aggregator just ignores components past the abort
   * point. */
  completed: boolean;

  // Per-component timing records (only components that actually started)
  entries: InstallTraceEntry[];
}

export interface InstallTraceEntry {
  mod: string;      // lowercase tp2 folder name
  cn: number;       // WeiDU component number
  /** Wall-clock seconds between component_start and the progress event
   * that counted this component's completion. Batch resolution: if a
   * batch contained multiple components, they share a duration = batch
   * wall-clock / components_in_batch. */
  sec: number;
  status: "success" | "warning" | "error" | "skipped" | "already";
}

// ─── Rig profile detection (best-effort, all optional) ───

function detectOS(): InstallTrace["rig"]["os"] {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}

/** Heuristic based on `navigator.hardwareConcurrency` and the presence
 * of battery API — rough, but keeps us from embedding raw CPU strings. */
function detectCpuClass(): InstallTrace["rig"]["cpuClass"] {
  const cores = navigator.hardwareConcurrency || 0;
  if (cores >= 8) return "desktop";
  if (cores >= 4) return "laptop";
  return "unknown";
}

function bucketRam(): number {
  // navigator.deviceMemory exists in Chromium; returns approx. GB
  // (max reported is 8GB for privacy, so "16GB" rigs show as 8).
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (typeof mem === "number" && mem > 0) return Math.round(mem / 4) * 4;
  return 0;
}

// ─── Builder ───

/** Accumulator — InstallRunner calls these as the install runs, then
 * `build()` produces the final InstallTrace for save/share.
 *
 * Two data paths, in priority order:
 *
 *   1. **High-resolution**: the Rust orchestrator emits
 *      `install:component_done` per component (parsed from WeiDU's
 *      "SUCCESSFULLY INSTALLED" / etc. stdout lines). Each event feeds
 *      `recordComponent()` which stores a record directly — resolution
 *      down to individual components, which is what the baseline
 *      aggregator wants.
 *   2. **Fallback**: if the Runner is talking to an older backend that
 *      doesn't emit `install:component_done`, `beginBatch()` +
 *      `endBatch()` apportion the batch wall-clock equally across its
 *      components. Lower resolution but never drops coverage.
 *
 * The recorder tracks which `(mod, cn)` pairs already got a
 * high-resolution entry so `endBatch()` only fills in the missing ones.
 */
export class TraceRecorder {
  private entries: InstallTraceEntry[] = [];
  private recordedKeys = new Set<string>();
  private startedAt: number = 0;
  private currentBatchStartMs: number = 0;

  start(): void {
    this.entries = [];
    this.recordedKeys.clear();
    this.startedAt = Date.now();
    this.currentBatchStartMs = 0;
  }

  /** High-resolution path: called for each install:component_done event. */
  recordComponent(
    modName: string,
    component: number,
    sec: number,
    status: InstallTraceEntry["status"],
  ): void {
    const mod = modName.toLowerCase();
    const key = `${mod}:${component}`;
    if (this.recordedKeys.has(key)) return;
    this.recordedKeys.add(key);
    this.entries.push({
      mod,
      cn: component,
      sec: Math.round(sec * 10) / 10,
      status,
    });
  }

  /** Called when install:batch_start event fires. */
  beginBatch(): void {
    this.currentBatchStartMs = Date.now();
  }

  /** Called when install:batch_done event fires — apportions the batch
   * wall-clock equally across any components that didn't get a
   * high-resolution entry from install:component_done. Components
   * already recorded via recordComponent() are left untouched. */
  endBatch(
    components: Array<{
      modName: string;
      component: number;
      status: InstallTraceEntry["status"];
    }>,
  ): void {
    if (this.currentBatchStartMs === 0) return;
    const missing = components.filter((c) => {
      const key = `${c.modName.toLowerCase()}:${c.component}`;
      return !this.recordedKeys.has(key);
    });
    if (missing.length > 0) {
      const now = Date.now();
      const batchSec = Math.max(0, (now - this.currentBatchStartMs) / 1000);
      const perComponent = batchSec / missing.length;
      for (const c of missing) {
        const mod = c.modName.toLowerCase();
        const key = `${mod}:${c.component}`;
        this.recordedKeys.add(key);
        this.entries.push({
          mod,
          cn: c.component,
          sec: Math.round(perComponent * 10) / 10,
          status: c.status,
        });
      }
    }
    this.currentBatchStartMs = 0;
  }

  /** Finalize. Produces a stable InstallTrace object. */
  build(opts: {
    config: AppConfig;
    weiduVersion: string;
    totalComponents: number;
    completed: boolean;
  }): InstallTrace {
    const now = Date.now();
    const totalDurationSec = Math.round((now - this.startedAt) / 1000);

    return {
      schema: 1,
      event: "install_trace",
      id: crypto.randomUUID ? crypto.randomUUID() : String(now),
      timestamp: new Date(now).toISOString(),
      rig: {
        os: detectOS(),
        cpuClass: detectCpuClass(),
        diskType: "unknown", // browser can't detect this; trace_to_baselines can infer from batch-size/override-fast-drive correlation
        ramGbBucket: bucketRam(),
      },
      accelerators: {
        overrideFastDrive: !!opts.config.override_fast_drive,
        experimentalWeidu: !!opts.config.use_experimental_weidu,
        batchSize: opts.config.max_batch_size ?? 25,
      },
      runnerVersion: APP_VERSION,
      weiduVersion: opts.weiduVersion || "unknown",
      totalComponents: opts.totalComponents,
      totalDurationSec,
      completed: opts.completed,
      entries: this.entries,
    };
  }

  /** Read access for the UI — lets the post-install card show the
   * recorded count before the user commits to save/share. */
  entryCount(): number {
    return this.entries.length;
  }
}

// ─── Serialization ───

/** Full trace JSON, pretty-printed for local save. */
export function serializeTrace(trace: InstallTrace): string {
  return JSON.stringify(trace, null, 2);
}

/** Compact form for GitHub Issue submission — same pattern as install-report
 * compaction: strip whitespace and drop very-short entries that would add
 * noise without improving the aggregate. */
export function compactTrace(trace: InstallTrace): string {
  const compact = {
    ...trace,
    entries: trace.entries.filter((e) => e.sec >= 0.5),
  };
  return JSON.stringify(compact);
}
