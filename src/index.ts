/**
 * index.ts — pi-mulligan extension entry point (P1.M5.T1.S1).
 *
 * Default-exports a SYNCHRONOUS factory that receives the Pi ExtensionAPI and wires
 * the four mulligan tools + five event handlers. The factory is synchronous
 * (no async, no try/catch, no forbidden-API calls per D8/C2).
 *
 * Wiring order (spec/11-build-order.md §2 Step 9):
 *   0. setConfig(loadMulliganSettings({}))        — load global config from disk (best-effort, never breaks load)
 *   1. setLogFile(getConfig().log.file)          — configure structured JSONL logger
 *   2. pi.registerTool(makeRewindTool(pi))      — mulligan_rewind
 *   3. pi.registerTool(makeShrinkTool(pi))       — mulligan_shrink
 *   4. pi.registerTool(makeCheckpointTool(pi))   — mulligan_checkpoint
 *   5. pi.registerTool(auditTool)                 — mulligan_audit (plain export, no factory)
 *   6. pi.on("context", contextHandler)           — filter pipeline (heart of the extension)
 *   7. pi.on("tool_result", ...)                  — bloat reminder (Nudge A)
 *   8. pi.on("turn_end", ...)                     — turn-end metric (Nudge B Phase 1)
 *   9. pi.on("session_start", ...)                — reset per-session runtime + re-read config
 *  10. pi.on("session_shutdown", ...)             — clear all runtimes
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, setConfig } from "./config.js";
import { loadMulliganSettings } from "./settingsLoader.js";
import { setLogFile } from "./log.js";
import { resetRuntime, clearAll } from "./runtime.js";
import { contextHandler } from "./filter.js";
import { registerBloatReminder, registerTurnEndMetric } from "./nudges.js";
import { makeRewindTool } from "./tools/rewind.js";
import { makeShrinkTool } from "./tools/shrink.js";
import { makeCheckpointTool } from "./tools/checkpoint.js";
import { auditTool } from "./tools/audit.js";

export default function (pi: ExtensionAPI): void {
  // 0. Load global config from disk (best-effort — never break load)
  try { setConfig(loadMulliganSettings({})); } catch { /* never break load */ }

  // 1. Configure structured JSONL logger from the just-set config
  setLogFile(getConfig().log.file);

  // 2–5. Register the four agent-callable tools
  pi.registerTool(makeRewindTool(pi));
  pi.registerTool(makeShrinkTool(pi));
  pi.registerTool(makeCheckpointTool(pi));
  pi.registerTool(auditTool);

  // 6. context filter (the heart of the extension)
  pi.on("context", contextHandler);

  // 7. bloat reminder on tool_result (Nudge A)
  registerBloatReminder(pi);

  // 8. turn-end metric (Nudge B Phase 1)
  registerTurnEndMetric(pi);

  // 9. session lifecycle: re-read config (with cwd + trust), reset runtime, re-apply log file
  pi.on("session_start", (event, ctx) => {
    try { setConfig(loadMulliganSettings({ cwd: ctx.cwd, isTrusted: ctx.isProjectTrusted() })); } catch { /* never break session start */ }
    resetRuntime(ctx.sessionManager.getSessionId());
    setLogFile(getConfig().log.file);
  });
  pi.on("session_shutdown", () => {
    clearAll();
  });
}
