/**
 * nudges.ts — Mulligan's preventive nudges (spec/07-preventive-and-nudges.md).
 * Nudge A — `tool_result` bloated-result reminder (§1): appends a bloat reminder to large results,
 *   records hits into rt.pendingBloatHits.
 * Nudge B Phase 1 — `turn_end` metric (§2): computes turn token delta + bloat, persists a turn-metric.
 * Nudge B Phase 2 — `context` drift nudge (§2): shouldNudge/injectNudge/suppressCheck, wired into
 *   filter.ts's contextHandler after filterPipeline, injects an EPHEMERAL mulligan:nudge.
 *
 * spec/03-architecture.md §3 (design principle #3 zero extra requests, #4 fail open), §2.4 (every handler
 *   wrapped so an exception becomes a logged no-op), §7 (nudges.ts module list);
 * spec/07-preventive-and-nudges.md §1 (Nudge A mechanism), §2 (Nudge B mechanism + suppress);
 * spec/08-edge-cases.md E13 (handler never throws);
 * spec/11-build-order.md §2 Step 7 (nudges.ts).
 *
 * DESIGN:
 * - Two Pi-coupled handlers (bloatReminderHandler, turnEndMetricHandler) + three pure helpers
 *   (shouldNudge, injectNudge, suppressCheck) + two register functions (registerBloatReminder,
 *   registerTurnEndMetric). NEVER throws: every handler is wrapped in try/catch + logError (fail-open, E13).
 * - shouldNudge takes a SINGLE TurnMetric (v1); oracle's windowed recentMetrics version is P3 — OMIT.
 * - NO bloatThresholdFor (oracle P3 — OMIT); uses single config.nudges.bloatThresholdBytes.
 * - NO shouldHighWater/renderHighWaterNudge/injectHighWaterNudge (P4 — OMIT).
 * - NO mulligan:cancel (P3 — OMIT).
 */

import type {
  ToolResultEvent,
  TurnEndEvent,
  ExtensionContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TurnMetric } from "./markers.js";
import type { MessageLike } from "./transforms.js";
import { getConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { appendTurnMetric } from "./markers.js";
import {
  resultBytes,
  approxTokens,
  estimateTokens,
  type ResultContentBlock,
} from "./tokens.js";
import { renderBloatReminder, renderDriftNudge } from "./notes.js";
import { logError } from "./log.js";

// ── local structural types ──────────────────────────────────────────────────

/**
 * ToolResultContentBlock — the element type of ToolResultEvent["content"] (TextContent | ImageContent).
 * Pi's TextContent/ImageContent are NOT re-exported at the package root, so the indexed-access type
 * names them without importing them.
 */
type ToolResultContentBlock = ToolResultEvent["content"][number];

// ── module-private defensive helpers (mirror notes.ts/tokens.ts — never throw) ────

/** True for plain records (and Object.create(null)); false for null, primitives, and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an own property without throwing (a Proxy get-trap may throw); undefined if absent/unreadable. */
function readOwn(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

// ── exported constants ────────────────────────────────────────────────────────

/**
 * NUDGE_TURN_WINDOW_MS — the heuristic time window for suppressCheck (spec/07 §2 "Edge cases").
 * 10 minutes: a generous bound on a single agent turn's wall-clock duration.
 */
export const NUDGE_TURN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ── pure helpers (Phase 2 — no Pi, no side effects) ────────────────────────────

/**
 * shouldNudge — Nudge B Phase 2 gate (spec/07 §2). PURE boolean: fires the drift nudge iff
 * grewOverThreshold is true OR bloatHit is true (both arms OR'd per v1 contract).
 * bloatHit uses `=== true` so a malformed metric (undefined bloatHit from raw session data)
 * fails safe to no-bloat. grewOverThreshold uses Boolean() for similar defensive safety.
 * NEVER throws.
 */
export function shouldNudge(
  metric: unknown,
  _config: unknown,
): boolean {
  if (!isRecord(metric)) return false;
  const grewOverThreshold = readOwn(metric, "grewOverThreshold");
  const bloatHit = readOwn(metric, "bloatHit");
  return Boolean(grewOverThreshold) || bloatHit === true;
}

/**
 * suppressCheck — Nudge B Phase 2 suppress heuristic (spec/07 §2 "Edge cases"). PURE: returns true
 * (suppress the nudge) iff ANY rewind or shrink marker was created during the metric's turn,
 * approximated as: some marker.ts falls in the half-open window (metric.ts − NUDGE_TURN_WINDOW_MS, metric.ts].
 * Returns false otherwise (no markers / all older / ts in the future / non-finite ts).
 * NEVER throws.
 *
 * @param metric  the latest turn-metric (metric.ts bounds the window's upper end).
 * @param markers { rewinds, shrinks } — structurally assignable from MarkersBundle (extra metric field ignored).
 */
export function suppressCheck(
  metric: unknown,
  markers: { rewinds: ReadonlyArray<unknown>; shrinks: ReadonlyArray<unknown> },
): boolean {
  if (!isRecord(metric)) return false;
  const metricTsRaw = readOwn(metric, "ts");
  const metricTs =
    typeof metricTsRaw === "number" && Number.isFinite(metricTsRaw)
      ? metricTsRaw
      : 0;
  const lo = metricTs - NUDGE_TURN_WINDOW_MS;

  for (const m of markers.rewinds) {
    const ts = readTs(m);
    if (Number.isFinite(ts) && ts > lo && ts <= metricTs) return true;
  }
  for (const m of markers.shrinks) {
    const ts = readTs(m);
    if (Number.isFinite(ts) && ts > lo && ts <= metricTs) return true;
  }
  return false;
}

/** Read .ts from a marker record; returns NaN if not a finite number. */
function readTs(marker: unknown): number {
  const v = isRecord(marker) ? readOwn(marker, "ts") : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

/**
 * injectNudge — Nudge B Phase 2 injection (spec/07 §2 "Phase 2: inject at next context fire").
 * PURE: composes the annotation via renderDriftNudge and appends it as an EPHEMERAL mulligan:nudge
 * CustomMessage to a NEW copy of messages. NEVER calls pi.sendMessage — the nudge lives ONLY
 * in the returned copy. Input is NOT mutated.
 *
 * @param messages the filtered message copy (MessageLike[]).
 * @param metric   the latest turn-metric (TurnMetric is structurally assignable to DriftNudgeInput).
 * @returns a NEW array: [...messages, nudge].
 */
export function injectNudge(messages: MessageLike[], metric: unknown): MessageLike[] {
  const line = renderDriftNudge(metric as Parameters<typeof renderDriftNudge>[0]);
  const turnIndex = isRecord(metric) ? readOwn(metric, "turnIndex") : undefined;
  const nudge: MessageLike = {
    role: "custom",
    customType: "mulligan:nudge",
    content: line,
    display: false,
    details: { ephemeral: true, turnIndex },
    timestamp: Date.now(),
  };
  return [...messages, nudge];
}

// ── Pi-coupled handlers ──────────────────────────────────────────────────────

/**
 * bloatReminderHandler — Nudge A (spec/07 §1). Fires after every tool execution; if the result's
 * in-context byte size exceeds config.nudges.bloatThresholdBytes, APPENDS a short reminder to the
 * result's content and records a bloat hit for the per-turn drift nudge (Nudge B). Skips mulligan_*
 * tools. Rides the result — zero extra requests (D3/D4).
 *
 * NEVER throws: the ENTIRE body is ONE try/catch → logError + return nothing (pass-through, E13).
 * Read sessionId FIRST inside the try{} so the catch{} can log it.
 *
 * KNOWN FUTURE ENHANCEMENT: per-tool bloat thresholds (system_context.md §7). v1 uses a single
 * config.nudges.bloatThresholdBytes for all tools.
 *
 * @param event the tool_result event.
 * @param ctx   the Pi ExtensionContext.
 * @returns `{ content: [...original, {type:"text", text:reminder}] }` when over threshold; undefined otherwise.
 */
export function bloatReminderHandler(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): { content?: ToolResultContentBlock[] } | void {
  let sessionId = "";
  try {
    sessionId = ctx.sessionManager.getSessionId();
    const config = getConfig();
    if (!config.enabled || !config.nudges.bloatReminder) return;

    const tn = event.toolName;
    if (typeof tn === "string" && tn.startsWith("mulligan_")) return;

    // Per-tool thresholds are a known future enhancement (NOT v1).
    // v1 uses a single config.nudges.bloatThresholdBytes for all tools.
    const bytes = resultBytes(event.content as unknown as ResultContentBlock[]);
    if (bytes < config.nudges.bloatThresholdBytes) return;

    const reminder = renderBloatReminder(
      event.toolName,
      bytes,
      config.nudges.bloatThresholdBytes,
    );
    const block: ToolResultContentBlock = { type: "text", text: reminder };
    const content: ToolResultContentBlock[] = [...event.content, block];

    const rt = runtime(ctx.sessionManager);
    rt.pendingBloatHits.push({
      toolName: event.toolName,
      approxTokens: approxTokens(bytes),
    });

    return { content };
  } catch (e) {
    logError("nudge.bloat", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * turnEndMetricHandler — Nudge B Phase 1 (spec/07 §2). Fires at the end of every turn; measures
 * filtered context growth (delta vs tokenBaseline), snapshots bloat hits, persists a turn-metric
 * CustomEntry, clears bloat accumulator, and rolls the baseline forward.
 *
 * NEVER throws: the ENTIRE body is ONE try/catch → logError + return nothing (fail-open, E13).
 * deltaTokens is null on the first turn / post-reload (baseline missing) → nudge falls back to bloat-only.
 *
 * @param pi    the Pi ExtensionAPI (appendTurnMetric → pi.appendEntry).
 * @param event { type:"turn_end"; turnIndex; message; toolResults } — NO messages array.
 * @param ctx   the Pi ExtensionContext.
 */
export function turnEndMetricHandler(
  pi: ExtensionAPI,
  event: TurnEndEvent,
  ctx: ExtensionContext,
): void {
  let sessionId = "";
  try {
    sessionId = ctx.sessionManager.getSessionId();

    const config = getConfig();
    if (!config.enabled || !config.nudges.perTurnDrift) return;

    const rt = runtime(ctx.sessionManager);

    // Current filtered token count. Use lastFiltered (D5 honest bookkeeping) when available,
    // fallback to getContextUsage() only when no filtered view exists yet (first turn).
    const now = rt.lastFiltered
      ? estimateTokens(rt.lastFiltered).tokens
      : (ctx.getContextUsage()?.tokens ?? 0);

    // Delta vs baseline captured at previous turn_end. null on first turn.
    const delta = rt.tokenBaseline == null ? null : now - rt.tokenBaseline;

    // Snapshot + clear the bloat hits collected this turn by bloatReminderHandler.
    const bloat = rt.pendingBloatHits;
    rt.pendingBloatHits = [];

    // Build TurnMetricInput — 5 DATA fields ONLY (appendTurnMetric stamps envelope+seq+ts).
    appendTurnMetric(pi, ctx, {
      deltaTokens: delta,
      bloatHit: bloat.length > 0,
      bloatHits: bloat,
      grewOverThreshold:
        delta != null && delta > config.nudges.driftThresholdTokens,
      turnIndex: event.turnIndex,
    });

    // Roll baseline + turn index forward (happy path only).
    rt.tokenBaseline = now;
    rt.lastTurnIndex = event.turnIndex;
  } catch (e) {
    logError("nudge.turn_end", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── register functions (called by P1.M5.T1.S1 — NOT this task) ─────────────────

/**
 * registerBloatReminder — arm Nudge A. index.ts calls this once at startup.
 * @param pi the Pi ExtensionAPI (on() lives here).
 */
export function registerBloatReminder(pi: ExtensionAPI): void {
  pi.on("tool_result", bloatReminderHandler);
}

/**
 * registerTurnEndMetric — arm Nudge B Phase 1. index.ts calls this once at startup.
 * The closure CAPTURES pi (the turn_end callback only receives (event, ctx)).
 * @param pi the Pi ExtensionAPI (on() lives here).
 */
export function registerTurnEndMetric(pi: ExtensionAPI): void {
  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext): void => {
    turnEndMetricHandler(pi, event, ctx);
  });
}
