/**
 * checkpoint.ts — the `mulligan_checkpoint` agent-callable tool (spec/05 §3; spec/04 §6; spec/08 E10/E13/E14).
 *
 * The third of Mulligan's four agent-callable tools. Tags the current session leaf with a
 * `mulligan:checkpoint:<name>` Pi label so a later `mulligan_rewind(granularity:"checkpoint")`
 * can target it precisely.
 *
 * DESIGN:
 * - Thin, typebox-schema'd, fail-open validation+persist adapter on top of `setCheckpoint` (markers.ts,
 *   P1.M3.T1.S1 — ALREADY shipped). This tool does NOT reimplement label prefixing or null-leaf handling.
 * - The TOOL owns: config gate (master enabled — E14), name validation (regex — E10), the success/refusal
 *   text, and the details payload. setCheckpoint owns the actual pi.setLabel call.
 * - Shared tool convention (spec/05 "Shared tool conventions"): execute wraps try/catch, NEVER throws (E13).
 *   The whole body is ONE try/catch → text result on any exception.
 * - CRITICAL: every `AgentToolResult<T>` return path includes a `details` field (GOTCHA #4).
 * - `pi` (ExtensionAPI) is NOT passed to execute() — captured via `makeCheckpointTool(pi)` factory closure.
 * - NO sub-feature config gate (MulliganConfig has no checkpoint sub-gate — gate on master only).
 *
 * This item does NOT modify src/index.ts (wiring is P1.M7.T1.S1).
 * This v1 task does NOT import runtime.js / filter.js / notes.js / ledger.js / audit.js.
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { setCheckpoint } from "../markers.js";
import { getConfig } from "../config.js";

// ── Parameter schema (spec/05 §3 — Typebox, VERBATIM incl. every field description) ──────────

/**
 * CheckpointParams — the typebox parameter schema for `mulligan_checkpoint` (spec/05 §3, VERBATIM).
 * `Static<typeof CheckpointParams>` === `{ name: string }`.
 * EXPORTED for tests + the index.ts wiring step.
 */
export const CheckpointParams = Type.Object({
  name: Type.String({
    description:
      "Checkpoint name. lowercase, digits, hyphen, underscore only; max 40 chars. e.g. 'before-refactor-experiment'.",
  }),
});

/** CheckpointArgs — the inferred execute-time params type. EXPORTED for ergonomics/tests. */
export type CheckpointArgs = Static<typeof CheckpointParams>;

// ── The LLM-facing description string (spec/05 §5 — VERBATIM) ────────────

/**
 * CKPT_DESC — the LLM-facing description (spec/05 §5 "Description strings", Mode A LLM-facing docs).
 * This string IS the tool's documentation. Copy verbatim — it drives LLM usage.
 */
export const CKPT_DESC =
  "Name the current position so a later mulligan_rewind can jump straight back to it. " +
  "Use before a speculative sub-task you might want to undo in one shot.";

// ── Result types (always include `details` — CRITICAL GOTCHA #4) ──────────

/** CheckpointDetails — the structured `details` payload surfaced to logs/audit/UI on every return path. EXPORTED. */
export interface CheckpointDetails {
  /** The checkpoint name (present on every path for correlation). */
  name: string;
  /** The labeled entry id (success path; undefined when refused). */
  entryId?: string | null;
}

// ── Module-private helpers ──────────────────────────────────────────────────

/** NAME_RE — the checkpoint name validation regex (spec/05 §3, spec/08 E10). */
const NAME_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * refusal — build a fail-open text result for any refusal / unexpected-error case.
 * ALWAYS includes `details` with `name` for correlation (CRITICAL GOTCHA #4).
 */
function refusal(reason: string, name: string): AgentToolResult<CheckpointDetails> {
  return {
    content: [{ type: "text", text: `Mulligan: refused — ${reason}.` }],
    details: { name },
  };
}

// ── execute (spec/05 §3 behavior; shared tool convention = never throws — E13) ─────

/**
 * checkpointExecute — the tool body (spec/05 §3 steps 1–4, in order). The WHOLE body is wrapped in ONE
 * try/catch so the tool NEVER throws (E13); any unexpected exception becomes a refusal text.
 *
 * `pi` is captured by the `makeCheckpointTool(pi)` factory closure (it is NOT an execute argument).
 * `toolCallId` is UNUSED for checkpoint (named `_toolCallId`).
 */
async function checkpointExecute(
  pi: ExtensionAPI,
  _toolCallId: string,
  params: CheckpointArgs,
  _signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<AgentToolResult<CheckpointDetails>> {
  let name = "";
  try {
    // (1) config gate (E14) — master switch ONLY (no checkpoint sub-gate). Read ONCE.
    const config = getConfig();
    if (!config.enabled) return refusal("Mulligan is disabled", name);

    // (2) name validation (E10). Defensive: params may be undefined under a type-violating caller.
    name = params?.name ?? "";
    if (typeof params?.name !== "string" || !NAME_RE.test(params.name)) {
      return refusal(
        "name must match /^[a-z0-9_-]{1,40}$/ (lowercase, digits, hyphen, underscore; max 40)",
        name,
      );
    }
    name = params.name;

    // (3) delegate the single write to setCheckpoint (markers.ts) — fail-open, returns leafId|null.
    const entryId = setCheckpoint(pi, ctx, name);
    if (entryId === null) {
      return refusal("could not set checkpoint (no current leaf or label write failed)", name);
    }

    // (4) success — VERBATIM spec/05 §3 text, <name> + <id> substituted.
    const text =
      `Mulligan: checkpoint '${name}' set at entry ${entryId}. ` +
      `Rewind to it with mulligan_rewind(granularity:'checkpoint', checkpoint:'${name}').`;
    return { content: [{ type: "text", text }], details: { name, entryId } };
  } catch (e) {
    // E13 never-throws.
    return refusal(`unexpected error: ${e instanceof Error ? e.message : String(e)}`, name);
  }
}

// ── Factory: the testable `pi`-injection seam (shrink.ts/rewind.ts precedent) ───────

/**
 * makeCheckpointTool — the tool factory. Captures `pi` (ExtensionAPI) via closure so `checkpointExecute`
 * can call `setCheckpoint(pi, ctx, …)` WITHOUT `pi` being an execute argument.
 *
 * index.ts (P1.M7.T1.S1) will do: `pi.registerTool(makeCheckpointTool(pi));`.
 * Unit tests do: `const tool = makeCheckpointTool(fakePi);`.
 */
export function makeCheckpointTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof CheckpointParams, CheckpointDetails> {
  return defineTool({
    name: "mulligan_checkpoint",
    label: "Mulligan Checkpoint",
    description: CKPT_DESC, // spec/05 §5 VERBATIM
    parameters: CheckpointParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return checkpointExecute(pi, toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
