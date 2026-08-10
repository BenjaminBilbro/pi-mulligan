/**
 * shrink.ts — the `mulligan_shrink` agent-callable tool (spec/05 §2; spec/04 §4; spec/08 E8/E13/E14/E19).
 *
 * The second of Mulligan's four agent-callable tools. Lets the agent replace the content of one specific
 * past tool result (or message) with a compact replacement, persistently, in the model's view — WITHOUT
 * removing it and WITHOUT rewriting the session JSONL (C6: retroactive shrink is a VIEW SUBSTITUTION
 * persisted as a marker the `context` filter honors).
 *
 * DESIGN:
 * - Thin, typebox-schema'd, fail-open validation+persist adapter on top of `appendShrinkMarker` (markers.ts,
 *   P1.M3.T1.S1 — ALREADY shipped) and the PURE `resolveShrinkTarget` (transforms.ts, P1.M2.T6.S1 — ALREADY
 *   shipped). This tool does NOT reimplement marker persistence or target resolution.
 * - The TOOL owns: config gate (master enabled then shrink.enabled — E14), replacement non-empty validation,
 *   structural target validity (the ONE design judgment — a non-empty-but-currently-unmatched target is NOT
 *   refused, E8), best-effort match-now (advisory, never blocks persistence — E8/E13), the persisted payload
 *   ({target, replacement, reason?} — NO pinnedEntryId, NO leaveNote), and the success/refusal text.
 * - WRITE-ONLY w.r.t. the message list: builds a SNAPSHOT via
 *   `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)` for the ADVISORY match-now.
 *   The filter resolves the target LIVE each inference (D7).
 * - Shared tool convention (spec/05 "Shared tool conventions"): execute wraps try/catch, NEVER throws (E13).
 *   The whole body is ONE try/catch → text result on any exception.
 * - CRITICAL: every `AgentToolResult<T>` return path includes a `details` field (GOTCHA #4).
 * - `pi` (ExtensionAPI) is NOT passed to execute() — captured via `makeShrinkTool(pi)` factory closure.
 * - NO pinnedEntryId, NO ctx.ui.notify, NO leaveNote, NO cap()/describeTarget(), NO notifyMaxChars (oracle-
 *   evolved features OUT OF SCOPE for v1).
 *
 * This item does NOT modify src/index.ts (wiring is P1.M7.T1.S1).
 * This v1 task does NOT import runtime.js / filter.js / notes.js / ledger.js / audit.js.
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  defineTool,
  sessionEntryToContextMessages,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { appendShrinkMarker } from "../markers.js";
import { resolveShrinkTarget, type ShrinkTarget, type MessageLike } from "../transforms.js";
import { getConfig } from "../config.js";

// ── Parameter schema (spec/05 §2 — Typebox, VERBATIM incl. every field description) ──────────

/**
 * ShrinkParams — the typebox parameter schema for `mulligan_shrink` (spec/05 §2, VERBATIM).
 * `Static<typeof ShrinkParams>` === `{ target: ShrinkTarget, replacement: string, reason?: string }`.
 * EXPORTED for tests + the index.ts wiring step.
 */
export const ShrinkParams = Type.Object({
  target: Type.Union([
    Type.Object({
      by_tool_call_id: Type.String({
        description: "The toolCallId of the result to shrink.",
      }),
    }),
    Type.Object({
      by_tool_name: Type.String({
        description: "e.g. 'read', 'bash'",
      }),
      occurrence: Type.Union([Type.Literal("last"), Type.Literal("first")]),
    }),
    Type.Object({
      by_content_includes: Type.String({
        description: "Shrink the (first) message whose text contains this substring.",
      }),
    }),
  ], {
    description:
      "How to identify the message to shrink. Resolved live each turn (robust to compaction).",
  }),
  replacement: Type.String({
    description:
      "The compact text that replaces the matched message's content. Make it a faithful summary — the model will treat it as ground truth from now on.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Why (surfaced in audit). Optional.",
    }),
  ),
});

/** ShrinkArgs — the inferred execute-time params type. EXPORTED for ergonomics/tests. */
export type ShrinkArgs = Static<typeof ShrinkParams>;

// ── The LLM-facing description string (spec/05 §5 — VERBATIM) ────────────

/**
 * SHRINK_DESC — the LLM-facing description (spec/05 §5 "Description strings", Mode A LLM-facing docs).
 * This string IS the tool's documentation. Copy verbatim — it drives LLM usage.
 */
export const SHRINK_DESC =
  "Replace a specific past tool result with a compact summary you provide, in your view, going forward. " +
  "Use when the call was fine but its output is too big to keep carrying. Unlike rewind, the call stays in " +
  "context (just with your summary as its result).";

// ── Result types (always include `details` — CRITICAL GOTCHA #4) ──────────

/** ShrinkDetails — the structured `details` payload surfaced to logs/audit/UI on every return path. EXPORTED. */
export interface ShrinkDetails {
  /** Whether the target matched in the current snapshot (advisory). */
  matched?: boolean;
  /** The persisted marker's entry id (success path; null/omitted when append returned null). */
  markerId?: string | null;
}

// ── Module-private helpers ──────────────────────────────────────────────────

/**
 * isNonEmpty — true for a non-empty-after-trim string. Used for replacement and discriminator validation.
 */
function isNonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * targetIsStructurallyValid — the ONE design judgment: refuse ONLY a discriminator that can provably never
 * match. An empty/whitespace by_tool_call_id or by_tool_name → resolveShrinkTarget's length>0 guard → null
 * forever. An empty by_content_includes → degenerate first-message match → also refuse. A NON-EMPTY but
 * currently-unmatched target is NOT refused (E8 — persists with matched:false).
 */
function targetIsStructurallyValid(target: ShrinkArgs["target"] | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  if ("by_tool_call_id" in target) return isNonEmpty(target.by_tool_call_id);
  if ("by_tool_name" in target) return isNonEmpty(target.by_tool_name);
  if ("by_content_includes" in target) return isNonEmpty(target.by_content_includes);
  return false;
}

/**
 * bestEffortMatch — ADVISORY read-only match over a snapshot. Returns true if the target resolves to a
 * message in the current context entries; false otherwise. NEVER blocks persistence — wrapped in try/catch
 * so any failure returns false (E8/E13). The filter resolves the target LIVE each inference (D7).
 */
function bestEffortMatch(ctx: ExtensionContext, target: ShrinkArgs["target"]): boolean {
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    const messages = entries.flatMap((e) => sessionEntryToContextMessages(e)) as unknown as MessageLike[];
    return resolveShrinkTarget(messages, target as ShrinkTarget) !== null;
  } catch {
    return false;
  }
}

/**
 * refusal — build a fail-open text result for any refusal / unexpected-error case.
 * ALWAYS includes `details` (CRITICAL GOTCHA #4 — empty but PRESENT).
 */
function refusal(reason: string): AgentToolResult<ShrinkDetails> {
  return {
    content: [{ type: "text", text: `Mulligan: refused — ${reason}.` }],
    details: {},
  };
}

/**
 * feedbackText — build the VERBATIM spec/05 §2 success text. Substitutes the actual matched value.
 */
function feedbackText(matched: boolean): string {
  return `Mulligan: shrink recorded. Matched message will show the replacement from the next turn on. (Matched now: ${matched ? "yes" : "no"})`;
}

// ── execute (spec/05 §2 behavior; shared tool convention = never throws — E13) ─────

/**
 * shrinkExecute — the tool body (spec/05 §2 steps 1–5, in order). The WHOLE body is wrapped in ONE try/catch
 * so the tool NEVER throws (E13); any unexpected exception becomes a refusal text describing the failure.
 *
 * `pi` is captured by the `makeShrinkTool(pi)` factory closure (it is NOT an execute argument).
 * `toolCallId` is UNUSED for shrink (the target is explicit — named `_toolCallId`).
 */
async function shrinkExecute(
  pi: ExtensionAPI,
  _toolCallId: string,
  params: ShrinkArgs,
  _signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<AgentToolResult<ShrinkDetails>> {
  try {
    // (1) config gate (step 1; E14). Read ONCE. Master switch FIRST, then shrink.enabled.
    const config = getConfig();
    if (!config.enabled) return refusal("Mulligan is disabled");
    if (!config.shrink.enabled) return refusal("shrink is disabled");

    // (2) replacement non-empty (trim) else refuse.
    if (!isNonEmpty(params?.replacement)) return refusal("replacement must be non-empty");

    // (3) structural target validity — the ONE design judgment. Empty/whitespace discriminator → refuse.
    //     A non-empty-but-currently-unmatched target is NOT refused (E8).
    if (!targetIsStructurallyValid(params?.target)) return refusal("target discriminator must be non-empty");

    // (4) best-effort match-now (advisory — never blocks persistence).
    const matched = bestEffortMatch(ctx, params.target);

    // (5) persist via appendShrinkMarker. NO cast, NO pinnedEntryId, NO leaveNote.
    const markerId = appendShrinkMarker(pi, ctx, {
      target: params.target,
      replacement: params.replacement,
      reason: params.reason,
    });

    // (6) return VERBATIM spec/05 §2 success text.
    return {
      content: [{ type: "text", text: feedbackText(matched) }],
      details: { matched, markerId },
    };
  } catch (e) {
    // Shared tool convention (E13): never throw — return a text result describing the failure.
    return refusal(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Factory: the testable `pi`-injection seam (rewind.ts/checkpoint.ts precedent) ───────

/**
 * makeShrinkTool — the tool factory. Captures `pi` (ExtensionAPI) via closure so `shrinkExecute` can call
 * `appendShrinkMarker(pi, ctx, …)` WITHOUT `pi` being an execute argument. `defineTool` preserves
 * `ShrinkParams` inference when assigning to a variable.
 *
 * index.ts (P1.M7.T1.S1) will do: `pi.registerTool(makeShrinkTool(pi));`.
 * Unit tests do: `const tool = makeShrinkTool(fakePi);`.
 */
export function makeShrinkTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof ShrinkParams, ShrinkDetails> {
  return defineTool({
    name: "mulligan_shrink",
    label: "Mulligan Shrink",
    description: SHRINK_DESC, // spec/05 §5 VERBATIM
    parameters: ShrinkParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return shrinkExecute(pi, toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
