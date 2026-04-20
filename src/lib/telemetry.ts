/**
 * Telemetry submission — copies a compact report to clipboard and opens
 * a GitHub Issue template. The user pastes the report and reviews before submitting.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import type { InstallReport } from "./install-report";
import { compactTrace, type InstallTrace } from "./install-trace";

const TELEMETRY_REPO = "Anprionsa/infinity-mod-telemetry";

/**
 * Build a compact version of the report for submission.
 * Components are compressed to "modId:cn:outcome" lines instead of full JSON objects.
 */
function compactReport(report: InstallReport): string {
  const header = {
    schema: report.schema,
    id: report.id,
    timestamp: report.timestamp,
    os: report.os,
    weiduVersion: report.weiduVersion,
    runnerVersion: report.runnerVersion,
    forgeDataDate: report.forgeDataDate,
    presetId: report.presetId,
    totalMods: report.totalMods,
    totalComponents: report.totalComponents,
    durationSeconds: report.durationSeconds,
    engineLimits: report.engineLimits,
  };

  // Compact components: only include non-ok outcomes in detail, ok components as count
  const okCount = report.components.filter(c => c.outcome === "ok").length;
  const nonOk = report.components
    .filter(c => c.outcome !== "ok")
    .map(c => `${c.tp2}:${c.cn}:${c.outcome}${c.errorPattern ? `:${c.errorPattern}` : ""}`);

  return JSON.stringify({
    ...header,
    okComponents: okCount,
    issues: nonOk,
  }, null, 2);
}

/**
 * Share install report via GitHub Issue.
 * Copies the compact report to clipboard, then opens GitHub with a template.
 * Returns true if successful.
 */
export async function shareReportOnGitHub(report: InstallReport): Promise<boolean> {
  try {
    const compact = compactReport(report);
    const okCount = report.components.filter(c => c.outcome === "ok").length;
    const errCount = report.components.filter(c => c.outcome === "err").length;
    const crashCount = report.components.filter(c => c.outcome === "crash").length;

    // Copy report to clipboard
    await navigator.clipboard.writeText("```json\n" + compact + "\n```");

    // Build a short GitHub Issue URL with title + instructions
    let title = `Install Report: ${report.totalMods}m/${report.totalComponents}c`;
    title += ` — ${okCount} ok`;
    if (errCount > 0) title += `, ${errCount} err`;
    if (crashCount > 0) title += `, ${crashCount} crash`;

    const body = [
      "## Install Report",
      "",
      "**Paste your report below** (it's already copied to your clipboard):",
      "",
      "<!-- Paste here (Ctrl+V) -->",
      "",
      "",
    ].join("\n");

    const params = new URLSearchParams({ title, body, labels: "install-report" });
    const url = `https://github.com/${TELEMETRY_REPO}/issues/new?${params.toString()}`;

    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share install trace (per-component timing) via GitHub Issue. Mirrors
 * shareReportOnGitHub: copies the compact trace to clipboard, opens the
 * issue template in the telemetry repo. The aggregation pipeline in
 * infinity-mod-telemetry consumes issues with the `install-trace` label.
 */
export async function shareTraceOnGitHub(trace: InstallTrace): Promise<boolean> {
  try {
    const compact = compactTrace(trace);
    await navigator.clipboard.writeText("```json\n" + compact + "\n```");

    const durationMin = Math.round(trace.totalDurationSec / 60);
    const title = `Install Trace: ${trace.entries.length}c / ${durationMin}m ` +
      `[${trace.rig.os}, ${trace.rig.cpuClass}]` +
      (trace.accelerators.overrideFastDrive ? " +fast-drive" : "") +
      (trace.accelerators.experimentalWeidu ? " +expweidu" : "");

    const body = [
      "## Install Trace",
      "",
      "Per-component timings from a completed install. Feeds baseline data for ETA accuracy — see Phase 7 plan.",
      "",
      "**Paste the JSON below** (it's already copied to your clipboard):",
      "",
      "<!-- Paste here (Ctrl+V) -->",
      "",
      "",
    ].join("\n");

    const params = new URLSearchParams({ title, body, labels: "install-trace" });
    const url = `https://github.com/${TELEMETRY_REPO}/issues/new?${params.toString()}`;

    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}
