/**
 * rewind.ts — the `mulligan_rewind` agent-callable tool (spec/05 §1; spec/04 §3; spec/08 E1–E15).
 *
 * THE "MULLIGAN" ITSELF — the headline operation. When the agent realizes a recent tool interaction was a
 * bloated mistake or a turn pursued the wrong direction, it calls this tool with a structured four-field
 * note + a granularity. The tool: (1) refuses cleanly when disabled / the note is vacuous / a named checkpoint is
 * absent / the max-depth cap is hit; (2) does a BEST-EFFORT read-only resolution of the target span to extract a
 * deterministic FileLedger and estimate K (messages to hide) — purely advisory, never mutating live context;
 * (3) persists a `mulligan:rewind` marker (control state, NOT in context) carrying the targeting SPEC (granularity
 * + options + excludeToolCallId + the checkpoint name); (4) leaves the rendered note as an in-context
 * `mulligan:note` CustomMessage; (5) returns a short confirmation naming K, appending a side-effect warning when
 * the hidden span mutated files/ran bash. The marker is resolved AUTHORITATIVELY by the `context` filter on the
 * NEXT inference (D7 — record a spec, not indices).
 *
 * DESIGN:
 * - Thin, typebox-schema'd, validation-owning adapter on top of `appendRewindMarker`/`leaveNote` (src/markers.ts,
 *   P1.M3.T1.S1 — ALREADY shipped & unit-tested). This tool does NOT reimplement `pi.appendEntry`/`pi.sendMessage`,
 *   note-field validation (validateNote), partitioning/resolution (transforms resolvers), or ledger extraction
 *   (extractFileLedger) — it delegates all of that to the shipped pure/Pi-coupled helpers.
 * - The TOOL owns: config gate, note validation (via validateNote), checkpoint-existence scan, depth guard, the
 *   read-only preview (snapshot → resolvers → ledger → K), the persisted payload (incl. checkpoint),
 *   the mutation warning, and the success/refusal text.
 * - The tool is WRITE-ONLY w.r.t. the message list: it NEVER receives/transforms `event.messages` (it is not the
 *   context event). It builds a SNAPSHOT via `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)`
 *   for the ADVISORY ledger + K estimate. If that snapshot/resolution fails, it falls back to an empty ledger +
 *   K=0 + STILL succeeds (the marker spec is what matters; E13/E8 — never let an advisory computation block a
 *   legitimate rewind).
 * - Shared tool convention (spec/05 "Shared tool conventions"): the execute body is fail-open to text — it NEVER
 *   throws (E13). The whole body is wrapped in ONE try/catch → text result on any exception.
 * - CRITICAL: `toolCallId` is the FIRST execute arg (NOT params). It becomes `excludeToolCallId` on the marker so
 *   the filter skips the rewind's OWN tool-call group (spec/05 §1 step 6; api_verification.md §8 NOTE).
 * - CRITICAL: every `AgentToolResult<T>` return path includes a `details` field (spec/05 §1's `{ content:[...] }`
 *   only shape is a SIMPLIFICATION — `details` is REQUIRED by the Pi type; strict mode).
 * - `pi` (ExtensionAPI) is NOT passed to execute() — it is captured via the `makeRewindTool(pi)` factory closure
 *   (checkpoint.ts precedent). index.ts (P1.M7.T1.S1) does `pi.registerTool(makeRewindTool(pi))`.
 * - CRITICAL: `RewindMarkerInput` already has `checkpoint?: string` — NO cast needed when building the payload.
 * - CRITICAL: `leaveNote(pi, { content, rewindId })` takes an OBJECT arg (this repo's signature), NOT positional.
 *
 * This item does NOT modify src/index.ts (wiring is P1.M7.T1.S1).
 * This v1 task does NOT import runtime.js / filter.js / audit.js.
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
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { appendRewindMarker, leaveNote, type RewindMarkerInput } from "../markers.js";
import { validateNote, renderNote, NOTE_INVALID_REASON, type NoteInput } from "../notes.js";
import { extractFileLedger, type FileLedger } from "../ledger.js";
import { getConfig, type Granularity } from "../config.js";
import {
  partitionIntoUnits,
  resolveLastToolCallGroup,
  resolveLastTurn,
  resolveCheckpoint,
  type BranchEntry,
  type MessageLike,
} from "../transforms.js";

// ── Parameter schema (spec/05 §1 — Typebox, VERBATIM incl. every field description) ──────────

/**
 * RewindParams — the typebox parameter schema for `mulligan_rewind` (spec/05 §1, VERBATIM). `Static<typeof
 * RewindParams>` === `{ note: NoteInput, granularity, to_previous_prompt?, checkpoint? }`. EXPORTED for tests +
 * the index.ts wiring step.
 */
export const RewindParams = Type.Object({
  note: Type.Object(
    {
      what_happened: Type.String({
        description:
          "Past tense: what specifically went wrong and wasted context. Be concrete.",
      }),
      avoid: Type.String({
        description: "Imperative: what NOT to do again on resume.",
      }),
      true_current_state: Type.String({
        description:
          "The TRUE current state as of this rewind — files changed, commands run, decisions made on the span being discarded. This prevents redoing work. (A deterministic file ledger is auto-appended.)",
      }),
      next: Type.String({
        description: "Imperative: the immediate next action to take when you resume.",
      }),
    },
    { description: "The note your resumed self will read. All four fields required." },
  ),
  granularity: Type.Union(
    [
      Type.Literal("last_tool_call_group"),
      Type.Literal("last_turn"),
      Type.Literal("checkpoint"),
    ],
    {
      description:
        "last_tool_call_group = hide just the most recent tool interaction (the assistant turn that issued tool calls + their results). Surgical. " +
        "last_turn = hide all your work after the most recent user message, landing back at that prompt to re-attempt the turn. " +
        "checkpoint = hide back to a named checkpoint you set earlier (requires `checkpoint`).",
    },
  ),
  to_previous_prompt: Type.Optional(
    Type.Boolean({
      description:
        "Only for granularity=last_turn. If true, also discard the most recent user message (nuclear: you abandon the current ask entirely). Default false.",
    }),
  ),
  checkpoint: Type.Optional(
    Type.String({
      description:
        "Required when granularity=checkpoint. The name of a checkpoint set via mulligan_checkpoint.",
    }),
  ),
});

/** RewindArgs — the inferred execute-time params type. EXPORTED for ergonomics/tests. */
export type RewindArgs = Static<typeof RewindParams>;

// ── The LLM-facing description string (spec/05 §5 — VERBATIM) ────────────

/**
 * REWIND_DESC — the LLM-facing description (spec/05 §5 "Description strings", Mode A LLM-facing docs).
 * This string IS the tool's documentation. Copy verbatim — it drives LLM usage.
 */
export const REWIND_DESC =
  "Shed recent context you produced by mistake (a bloated tool result, or a whole wrong-direction turn) and leave yourself a note so you can try again with a clean view. The hidden content disappears from your view permanently (it stays on disk for the human). Costs only a short note. Use granularity 'last_tool_call_group' to undo just the last tool interaction, or 'last_turn' to redo the whole turn from the user's last message.";

// ── Mutation warning (spec/08 E5 — VERBATIM warning string) ──────────────────

/**
 * MUTATION_WARNING — the spec/08 E5 VERBATIM warning appended to the success text when the hidden span contained
 * side-effecting work (writes/bash) AND config.rewind.requireMutationWarning is true. The leading space + ⚠ are
 * load-bearing (do NOT rephrase). Module-local.
 */
const MUTATION_WARNING =
  "⚠ The hidden span modified files/ran side-effecting commands (see note). " +
  "Those effects PERSIST on disk; do not blindly redo them.";

// ── Result builders (always include `details` — CRITICAL GOTCHA #4) ──────────

/** RewindDetails — the structured `details` payload surfaced to logs/audit/UI on every return path. EXPORTED. */
export interface RewindDetails {
  /** The requested granularity (present on EVERY path for correlation). */
  granularity: Granularity;
  /** Estimated messages to hide (success path only). */
  k?: number;
  /** The extracted file ledger (success path only; empty on best-effort failure). */
  ledger?: FileLedger;
  /** The persisted marker's entry id (success path; null/omitted when append returned null). */
  markerId?: string | null;
}

/**
 * refusal — build a fail-open text result for any refusal / wrapper-reported-failure / unexpected-error case.
 * ALWAYS includes `details` (CRITICAL GOTCHA #4). The shared convention prefixes every refusal with
 * "Mulligan: refused — " (and closes the sentence with ".") so the agent can pattern-match a refusal regardless
 * of the underlying reason. NOTE: the caller passes a reason with NO trailing period (NOTE_INVALID_REASON has none);
 * this helper adds the ".".
 */
function refusal(reason: string, granularity: Granularity): AgentToolResult<RewindDetails> {
  return {
    content: [{ type: "text", text: `Mulligan: refused — ${reason}.` }],
    details: { granularity },
  };
}

/**
 * successText — build the success text (spec/05 §1 Return shape + step 8 K=0 honesty). Returns just the `text`
 * (the caller wraps it into the content block + details). K=0 appends "(nothing matched to hide)" so the agent is
 * not misled. The mutation warning is appended VERBATIM (spec/08 E5) when hasWarning is true.
 * Module-local.
 */
function successText(granularity: Granularity, k: number, hasWarning: boolean): { text: string } {
  const kClause =
    k === 0
      ? "0 messages will be hidden from your view starting next turn (nothing matched to hide)"
      : `${k} messages will be hidden from your view starting next turn`;
  let text = `Mulligan: rewound ${granularity}. ${kClause}. Note left.`;
  if (hasWarning) text += " " + MUTATION_WARNING; // spec/08 E5 VERBATIM
  return { text };
}

// ── Pure read-only preview helpers (snapshot → resolvers → ledger → K; best-effort) ──────────

/**
 * emptyLedger — the fail-open fallback ({ readFiles:[], modifiedFiles:[], bashSideEffects:[] }). Module-local.
 * Used when the read-only preview throws (resolvePreview catch) so the rewind STILL proceeds with an honest K=0.
 */
function emptyLedger(): FileLedger {
  return { readFiles: [], modifiedFiles: [], bashSideEffects: [] };
}

/**
 * countRewindMarkers — the depth-guard source. Scan `ctx.sessionManager.getEntries()` for entries
 * where `type === "custom" && customType === "mulligan:rewind"`; return the count. Markers are permanent (never
 * cleared), so ALL persisted rewind markers count toward maxDepth. Defensive (never throws; a throwing-Proxy
 * entry or a non-array → the entry is skipped / the count is 0). Module-local.
 */
function countRewindMarkers(ctx: ExtensionContext): number {
  let count = 0;
  let entries: unknown;
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return 0; // never let the depth guard throw
  }
  if (!Array.isArray(entries)) return 0;
  for (const e of entries) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    try {
      if ((e as { type?: unknown }).type === "custom" && (e as { customType?: unknown }).customType === "mulligan:rewind") {
        count++;
      }
    } catch {
      // a throwing-Proxy entry → skip (never throw on the tool hot path)
    }
  }
  return count;
}

/**
 * checkpointExists — the checkpoint-existence check (step 3, E10). A checkpoint is ACTIVE iff its label
 * currently maps to the `mulligan:checkpoint:<name>` string in Pi's LATEST-WINS label map. That map is
 * append-only in the raw entry stream (a `setLabel(id, undefined)` appends a clear entry), so scanning raw
 * `getEntries()` for a string match would find the HISTORICAL label even after it was consumed (validation
 * issue 1b). Pi's `ctx.sessionManager.getLabel(id)` applies the latest-wins semantics: it returns `undefined`
 * once a clear entry follows the set, which is exactly the consumed state we must refuse. We therefore walk
 * raw entries to discover candidate `label` targets, then ask `getLabel(targetId)` whether each is CURRENTLY
 * active. Defensive (never throws — a throwing getEntries/getLabel/Proxy trap → false). Module-local.
 *
 * @param ctx  the Pi ExtensionContext (getEntries to discover candidates; getLabel for latest-wins resolution)
 * @param name the checkpoint name (the suffix after `mulligan:checkpoint:`)
 * @returns true iff some entry's label target currently maps to `mulligan:checkpoint:<name>`
 */
function checkpointExists(ctx: ExtensionContext, name: string): boolean {
  const needle = `mulligan:checkpoint:${name}`;
  const candidates = new Set<string>();
  let entries: unknown;
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return false;
  }
  if (!Array.isArray(entries)) return false;
  for (const e of entries) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    try {
      const ee = e as { type?: unknown; label?: unknown; targetId?: unknown };
      if (ee.type === "label" && ee.label === needle && typeof ee.targetId === "string" && ee.targetId.length > 0) {
        candidates.add(ee.targetId);
      }
    } catch {
      // skip a throwing-Proxy entry
    }
  }
  if (candidates.size === 0) return false;
  for (const id of candidates) {
    try {
      if (ctx.sessionManager.getLabel(id) === needle) return true;
    } catch {
      // a throwing getLabel → treat this candidate as inactive (never throw on the tool hot path)
    }
  }
  return false;
}

/**
 * resolvePreview — the read-only ledger + K preview (step 5; best-effort). Builds a SNAPSHOT via
 * `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)` (NOT event.messages — the tool
 * is write-only w.r.t. messages), then mirrors filterPipeline's granularity dispatch (spec/06 §12) to resolve the
 * removal set, and feeds it to extractFileLedger. Returns `{ ledger, k }`.
 *
 * The CALLER wraps this in try/catch → { ledger: emptyLedger(), k: 0 } on ANY failure (the ledger is ADVISORY;
 * never let an advisory computation block a legitimate rewind — E13/E8). This helper is therefore NOT itself
 * responsible for catching — it lets exceptions propagate to the single caller try/catch.
 *
 * extractFileLedger's `range` is a number[] of MESSAGE INDICES (NOT a [start,end) tuple). The resolver's
 * removal set IS that index list.
 * resolveCheckpoint takes branchEntries DATA (getBranch(), root→leaf), NOT ctx.
 * Module-local.
 */
function resolvePreview(
  ctx: ExtensionContext,
  params: RewindArgs,
  toolCallId: string,
): { ledger: FileLedger; k: number } {
  const entries = ctx.sessionManager.buildContextEntries();
  // sessionEntryToContextMessages returns Pi's AgentMessage[]; transforms.ts MessageLike is a Pi-free
  // structural type that TS rejects across the boundary. Cast through unknown at this single boundary
  // (the established filter.ts idiom — runtime-identical).
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e)) as unknown as MessageLike[];

  let remove: number[];
  if (params.granularity === "last_tool_call_group") {
    const units = partitionIntoUnits(messages);
    remove = resolveLastToolCallGroup(units, messages, toolCallId) ?? [];
  } else if (params.granularity === "last_turn") {
    remove = resolveLastTurn(messages, { to_previous_prompt: params.to_previous_prompt }, toolCallId).remove;
  } else {
    // checkpoint (existence already verified by the caller; resolveCheckpoint is defensive regardless)
    const branchEntries = ctx.sessionManager.getBranch() as BranchEntry[];
    remove = resolveCheckpoint(messages, branchEntries, params.checkpoint ?? "", toolCallId)?.remove ?? [];
  }
  const ledger = extractFileLedger(messages, remove);
  return { ledger, k: remove.length };
}

// ── execute (spec/05 §1 behavior; shared tool convention = never throws — E13) ─────

/**
 * rewindExecute — the tool body (spec/05 §1 steps 1–8, in order). The WHOLE body is wrapped in ONE try/catch so
 * the tool NEVER throws (E13); any unexpected exception becomes a refusal text describing the failure.
 *
 * `pi` is captured by the `makeRewindTool(pi)` factory closure (it is NOT an execute argument). The execute first
 * arg `toolCallId` becomes `excludeToolCallId` on the persisted marker (GOTCHA #2).
 */
async function rewindExecute(
  pi: ExtensionAPI,
  toolCallId: string,
  params: RewindArgs,
  _signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<AgentToolResult<RewindDetails>> {
  // Defensive: if a caller violates the type and omits params, normalize the granularity for the catch fallback.
  const granularity: Granularity =
    params &&
    (params.granularity === "last_tool_call_group" ||
      params.granularity === "last_turn" ||
      params.granularity === "checkpoint")
      ? params.granularity
      : "last_tool_call_group";

  try {
    // (1) config gate (step 1; E14). Read ONCE. Master switch FIRST (E14 master-disable),
    //     then the sub-feature gate.
    const config = getConfig();
    if (!config.enabled) return refusal("Mulligan is disabled", granularity);
    if (!config.rewind.enabled) return refusal("rewind is disabled", granularity);

    // (2) note validation (step 2; E9). validateNote never throws; NOTE_INVALID_REASON has NO trailing period
    //     (refusal() adds the ".").
    const nv = validateNote((params?.note ?? {}) as NoteInput);
    if (!nv.valid) return refusal(NOTE_INVALID_REASON, granularity);

    // (3) checkpoint existence (step 3; E10). last_tool_call_group / last_turn are always valid.
    if (granularity === "checkpoint") {
      const name = params.checkpoint;
      if (!name || name.length === 0) {
        return refusal("checkpoint granularity requires a checkpoint name", "checkpoint");
      }
      if (!checkpointExists(ctx, name)) {
        return refusal(`checkpoint '${name}' not found on this branch`, "checkpoint");
      }
    }

    // (4) depth guard (step 4; E4). Markers are permanent → ALL persisted rewind markers count toward maxDepth.
    const depth = countRewindMarkers(ctx);
    if (depth >= config.rewind.maxDepth) {
      return refusal(
        `max rewind depth (${config.rewind.maxDepth}) reached — ${depth} active rewind marker(s). Consider mulligan_shrink or just continuing; if stuck in a loop, the human should intervene`,
        granularity,
      );
    }

    // (5) read-only ledger + K preview (step 5; best-effort — E13/E8). A failure falls back to empty ledger +
    //     K=0 + STILL succeeds (the marker spec is what matters; the ledger is ADVISORY).
    let ledger: FileLedger;
    let k: number;
    try {
      ({ ledger, k } = resolvePreview(ctx, params, toolCallId));
    } catch {
      // Snapshot/resolution failure → best-effort: empty ledger + K=0 + STILL proceed (E13/E8).
      ledger = emptyLedger();
      k = 0;
    }

    // (5b) protected-refusal check — spec/08 E3 ("the tool refuses before persisting") + spec/10 §2.1 F-protected
    //      ("no marker created"). resolveLastTurn returns { remove: [] } when nuclear last_turn would cross
    //      the first/only user message (iFirstUser === iLastUser); resolvePreview surfaces that as k === 0.
    //      Refuse HERE, before renderNote/persist, so a nuclear last_turn across the first user message refuses
    //      instead of persisting a no-op marker + stray note (BUG-006). NARROWLY SCOPED: the three-way AND
    //      excludes every legitimate K=0 — last_tool_call_group and default last_turn stay on success path.
    if (granularity === "last_turn" && params.to_previous_prompt === true && k === 0) {
      return refusal(
        "would cross a protected message (to_previous_prompt would rewind across the first/only user message — the original task)",
        "last_turn",
      );
    }

    // (6) render note (step 6 — note already validated by step 2; renderNote does NOT re-validate).
    const rendered = renderNote(
      (params.note as NoteInput) ?? ({} as NoteInput),
      ledger,
      granularity,
    );

    // (7) persist (step 7). excludeToolCallId === toolCallId. The marker's own id/seq/ts are stamped
    //     by appendRewindMarker. RewindMarkerInput already has checkpoint?: string → NO cast needed.
    const payload: RewindMarkerInput = {
      granularity,
      options: {
        to_previous_prompt: params.to_previous_prompt,
        protect: config.rewind.protectedRoles,
      },
      excludeToolCallId: toolCallId,
      note: params.note,
      ledger,
      checkpoint: params.checkpoint,
    };
    const markerId = appendRewindMarker(pi, ctx, payload);
    leaveNote(pi, { content: rendered, rewindId: markerId ?? toolCallId });

    // (8) mutation warning (step 8 / E5) — VERBATIM (spec/08 E5) iff configured + the ledger shows side effects.
    const hasWarning =
      config.rewind.requireMutationWarning &&
      (ledger.modifiedFiles.length > 0 || ledger.bashSideEffects.length > 0);

    // (9) return success (step 8 — K + K=0 honesty via successText).
    const { text } = successText(granularity, k, hasWarning);
    return {
      content: [{ type: "text", text }],
      details: { granularity, k, ledger, markerId },
    };
  } catch (e) {
    // Shared tool convention (E13): never throw — return a text result describing the failure.
    return refusal(
      `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      granularity,
    );
  }
}

// ── Factory: the testable `pi`-injection seam (checkpoint.ts precedent) ───────

/**
 * makeRewindTool — the tool factory. Captures `pi` (ExtensionAPI) via closure so `rewindExecute` can call
 * `appendRewindMarker(pi, ctx, …)` / `leaveNote(pi, …)` WITHOUT `pi` being an execute argument. `defineTool`
 * preserves `RewindParams` inference when assigning to a variable.
 *
 * index.ts (P1.M7.T1.S1) will do: `pi.registerTool(makeRewindTool(pi));`.
 * Unit tests do: `const tool = makeRewindTool(fakePi);`.
 */
export function makeRewindTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof RewindParams, RewindDetails> {
  return defineTool({
    name: "mulligan_rewind",
    label: "Mulligan Rewind",
    description: REWIND_DESC, // spec/05 §5 VERBATIM
    parameters: RewindParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return rewindExecute(pi, toolCallId, params, signal, onUpdate, ctx); // pi captured via closure
    },
  });
}
