/**
 * transforms.ts — Mulligan's PURE context-filter transforms (the correctness heart).
 * spec/06-context-filter.md §2 (partitionIntoUnits — the cardinal pairing rule), spec/04-data-model.md,
 *   spec/08-edge-cases.md E1 (orphan toolResult → own plain unit), spec/10-testing.md §1.1 (partitionIntoUnits
 *   tier-1 tests), api_verification.md §6.4 (tool-pairing invariant: the model API rejects an orphaned
 *   toolCall/toolResult), spec/01-pi-context-internals.md §5 (the context event + the invariant), spec/03 §2.3/§7
 *   + spec/11 §1/§2 (transforms.ts = PURE, unit-tested without Pi; Step 3 "the most important step").
 *
 * DESIGN (read GOTCHA #1–#13 in the PRP):
 * - Foundation-tier and Pi-FREE. Imports NOTHING — not Pi, not config, not log, not runtime, NOT tokens.ts/ledger.ts.
 *   It is a pure, deterministic, side-effect-free function fully unit-testable in isolation (sibling of tokens.ts +
 *   ledger.ts per spec/11 §1). It defines its OWN local structural types (mirror tokens.ts/ledger.ts) and its OWN
 *   module-private isRecord/readOwn (each pure module keeps its own copy — the established convention).
 * - partitionIntoUnits is THE pairing primitive. Every removal transform (resolveLastToolCallGroup,
 *   resolveLastTurn, applyRewind, applyShrink, filterPipeline — sibling functions added by later P1.M3 subtasks)
 *   operates on UNITS, never raw indices, so pairing is preserved by construction (spec/06 §2: "All removal
 *   operations in Mulligan operate on units, never raw indices. This guarantees pairing by construction."). A unit
 *   is either a single non-tool message (plain) or an assistant message containing toolCalls grouped WITH every
 *   toolResult whose toolCallId matches (toolGroup). Hiding a toolGroup hides the call AND all its results together
 *   → the model API never sees an orphan (api_verification.md §6.4).
 * - NEVER throws (it sits on the context-handler hot path via filterPipeline; E13 fail-open discipline).
 *   isRecord/readOwn swallow Proxy-trap throws; null/non-array messages, malformed blocks, missing/non-string ids,
 *   orphan results, and assistant-with-no-results-yet are all handled defensively (GOTCHA #4–#9).
 *
 * NOTE: later P1.M3 subtasks (T2 resolveLastToolCallGroup/resolveLastTurn, T3 resolveCheckpoint, T4 applyRewind/
 *   applyShrink, T5 filterPipeline) APPEND to this file and REUSE the exported Unit/MessageLike + the module-private
 *   isRecord/readOwn (hoisted here — mirrors how tokens.ts/notes.ts siblings reuse their S1 helpers). This S1 ships
 *   ONLY partitionIntoUnits + Unit + MessageLike + isRecord/readOwn.
 */

// ── local structural types (mirror tokens.ts/ledger.ts; api_verification.md §6.1/§6.2) ────

/** A tool-call content block (assistant only) — partitionIntoUnits reads `.id` to pair call↔result. */
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Any content block (we only ever inspect toolCall blocks; text/thinking/image are ignored). */
type ContentBlock = ToolCallContent | { type: string; [key: string]: unknown };

/**
 * Minimal structural message shape for partitioning. Any Pi AgentMessage variant (user / assistant / toolResult /
 * custom / bashExecution / branchSummary / compactionSummary) satisfies this. partitionIntoUnits inspects ONLY:
 *   - `role` (to tell assistant/toolResult apart from plain messages),
 *   - assistant `content[]` for toolCall blocks (reading each `.id`),
 *   - toolResult `toolCallId` (via the index signature, read via readOwn).
 * A real Pi AgentMessage[] assigns in with NO cast (structural typing — api_verification.md §6.1/§6.3). EXPORTED so
 * tests + the later sibling resolve* / apply* functions + filter.ts (P1.M4) share one input type.
 */
export interface MessageLike {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

/**
 * Unit — a pairing-safe message group (spec/06-context-filter.md §2 canonical shape). A unit is EITHER:
 *   - kind:"plain"     — a single non-tool message (user, text-only assistant, custom, OR an orphan toolResult whose
 *                        toolCallId matches no assistant — spec/08 E1). `indices` ALWAYS has length 1.
 *   - kind:"toolGroup" — an assistant message that issued ≥1 toolCall, grouped WITH every toolResult whose
 *                        toolCallId maps to that assistant. `indices` = [assistant, ...results], sorted ascending.
 *                        (An assistant whose results have not arrived yet — mid-turn — is a toolGroup of just the
 *                        assistant: spec/06 §2 corner case.)
 * `indices` is sorted ascending; units are ordered by `indices[0]` (their minimum index). EXPORTED — it is the
 * return type of partitionIntoUnits AND the input type of every removal transform (resolveLastToolCallGroup,
 * applyRewind, … — sibling functions added by later P1.M3 subtasks).
 */
export interface Unit {
  /** Sorted ascending message indices this unit spans. plain → always exactly [i]; toolGroup → [assistant, ...results]. */
  indices: number[];
  kind: "plain" | "toolGroup";
}

/**
 * partitionIntoUnits — group a message list into pairing-safe units (spec/06 §2; the cardinal rule).
 *
 * ALGORITHM (spec/06 §2, steps a–e):
 *   (a) Walk `messages`; build `toolCallId → assistantIndex` from every assistant message's toolCall blocks (only
 *       blocks whose `.id` is a non-empty string are pairable — GOTCHA #4).
 *   (b)+(c) Group ALL result indices by their paired assistant: for every toolResult whose `.toolCallId` is a
 *       non-empty string AND is in the assistant map, push its index into that assistant's bucket. (Implemented as a
 *       join of callToResult × callToAssistant; uses number[] per assistant so duplicate callIds are orphan-safe —
 *       GOTCHA #9.) A result whose callId matches NO assistant is SKIPPED here → it falls through to a plain unit
 *       in (d) (orphan — spec/08 E1, GOTCHA #6).
 *   For each DISTINCT assistant that issued ≥1 pairable call (deduped via an `assigned` set — GOTCHA #5), form a
 *   toolGroup = {indices: sorted([assistantIndex, ...results]), kind:"toolGroup"}. An assistant with calls but no
 *   results yet → a toolGroup of just the assistant (spec/06 §2 corner case — GOTCHA #7).
 *   (d) Every index NOT in a toolGroup → a plain unit {indices:[i]}. This is where orphan toolResults, user
 *       messages, text-only assistants, and custom messages land.
 *   (e) Units are ordered by their minimum index (indices[0]).
 *
 * WHY (api_verification.md §6.4): the model API rejects a request containing a toolCall without its matching
 * toolResult, or vice versa. Because every removal transform operates on UNITS (never raw indices — spec/06 §2),
 * hiding a toolGroup hides the assistant call AND all its results together, so the filtered view never orphans
 * either side. This function is the correctness foundation for ALL of P1.M3.
 *
 * Pure + defensive: null/undefined/non-array `messages` → []; malformed messages/blocks, missing/non-string/empty
 * ids, duplicate toolCallIds, results appearing before their assistant, and throwing-Proxy messages are all handled
 * gracefully — NEVER throws (E13; context-handler hot path). Duplicate toolCallId across two assistant calls, or
 * two results for one callId: deterministic + orphan-safe (GOTCHA #9); such inputs should not occur in a well-formed
 * Pi context, but the function stays total regardless.
 *
 * @param messages the message list (a real Pi AgentMessage[] assigns in with no cast); null/undefined/non-array → []
 * @returns ordered Unit[] (plain + toolGroup), each with ascending indices; [] for empty/null input
 */
export function partitionIntoUnits(messages: MessageLike[] | null | undefined): Unit[] {
  const list = Array.isArray(messages) ? messages : [];

  // (a) toolCallId → assistantIndex, from every assistant's pairable toolCall blocks.
  const callToAssistant = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (!isRecord(msg) || readOwn(msg, "role") !== "assistant") continue;
    const content = readOwn(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || readOwn(block, "type") !== "toolCall") continue; // only toolCall blocks carry a pairable id
      const id = readOwn(block, "id");
      if (typeof id === "string" && id.length > 0) {
        callToAssistant.set(id, i); // duplicate id (shouldn't happen) → last wins (deterministic)
      }
    }
  }

  // (b)+(c) Group ALL result indices by their paired assistant (join of callToResult × callToAssistant). Orphan
  //         results (no matching assistant) are skipped here → they become plain units in step (d) (spec/08 E1).
  //         number[] per assistant (NOT a 1:1 map) so duplicate callIds group together → orphan-safe (GOTCHA #9).
  const assistantToResults = new Map<number, number[]>();
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (!isRecord(msg) || readOwn(msg, "role") !== "toolResult") continue;
    const id = readOwn(msg, "toolCallId");
    if (typeof id !== "string" || id.length === 0) continue;
    const assistantIndex = callToAssistant.get(id);
    if (assistantIndex === undefined) continue; // orphan result → leave for the plain pass (GOTCHA #6)
    let bucket = assistantToResults.get(assistantIndex);
    if (bucket === undefined) {
      bucket = [];
      assistantToResults.set(assistantIndex, bucket);
    }
    bucket.push(i);
  }

  // Build toolGroup units for every assistant that issued ≥1 pairable toolCall (distinct values of callToAssistant).
  // `assigned` dedups: one assistant with N calls appears N× in .values() → ONE toolGroup, not N (GOTCHA #5).
  const assigned = new Set<number>();
  const units: Unit[] = [];
  for (const assistantIndex of callToAssistant.values()) {
    if (assigned.has(assistantIndex)) continue;
    const results = assistantToResults.get(assistantIndex) ?? [];
    const indices = [assistantIndex, ...results].sort((a, b) => a - b); // ascending (GOTCHA #10)
    for (const idx of indices) assigned.add(idx);
    units.push({ indices, kind: "toolGroup" });
  }

  // (d) Every index NOT in a toolGroup → a plain unit. Orphan toolResults land here (their own plain unit).
  for (let i = 0; i < list.length; i++) {
    if (assigned.has(i)) continue;
    units.push({ indices: [i], kind: "plain" });
  }

  // (e) Order units by their minimum index (indices[0]).
  units.sort((a, b) => a.indices[0] - b.indices[0]);
  return units;
}

// ── module-private defensive helpers (mirror tokens.ts/ledger.ts — never throw) ────

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
