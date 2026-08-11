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

// ── resolveLastToolCallGroup (last_tool_call_group targeting; spec/06 §5) ───────────────

/**
 * resolveLastToolCallGroup — find the indices of the LAST toolGroup unit eligible for removal
 * (spec/06-context-filter.md §5). A helper for applyRewind (P1.M3.T4.S1) in `last_tool_call_group` granularity.
 *
 * ALGORITHM (spec/06 §5):
 *   1. Walk `units` from the last to the first.
 *   2. Skip plain units and malformed records — only toolGroups are candidates.
 *   3. If `excludeToolCallId` is a non-empty string and the toolGroup's assistant issued that call, skip it
 *      (the rewind's own toolGroup — spec/06 §9 / spec/08 E6).
 *   4. The first non-skipped toolGroup from the end → return its indices.
 *   5. No toolGroup found → null (nothing to rewind; applyRewind no-ops — spec/08 E8).
 *
 * RETURNS `number[] | null` — null = nothing to rewind; the indices array is a read-only reference into the
 * unit's `.indices` (applyRewind copies, never mutates).
 */
export function resolveLastToolCallGroup(
  units: Unit[],
  messages: MessageLike[],
  excludeToolCallId?: string,
): number[] | null {
  // Defensive: a non-array units (shouldn't happen) → nothing resolvable.
  if (!Array.isArray(units)) return null;

  const hasExclude = typeof excludeToolCallId === "string" && excludeToolCallId.length > 0;

  // 1) Walk units from the last to the first.
  for (let k = units.length - 1; k >= 0; k--) {
    const unit = units[k];
    // 2) Skip plain units (+ malformed records). Only toolGroups are candidates.
    if (!isRecord(unit) || unit.kind !== "toolGroup" || !Array.isArray(unit.indices)) continue;

    // 3) If exclusion is active, skip this toolGroup when its assistant issued the rewind's own call
    //    (the rewind's own toolGroup, or a parallel-shared message — spec/06 §9 / spec/08 E6).
    if (hasExclude && assistantIssuedCall(messages, unit.indices, excludeToolCallId)) {
      continue;
    }

    // 4) First non-skipped toolGroup from the end → return its indices (read-only reference; applyRewind copies).
    return unit.indices;
  }

  // 5) No toolGroup found → nothing to rewind (applyRewind no-ops; spec/08 E8).
  return null;
}

/**
 * Module-private: did the assistant message within this toolGroup issue a toolCall whose id === callId?
 * Defensive (isRecord/readOwn; never throws). `indices` is a toolGroup's member indices (assistant + results).
 * Scans ALL assistant members and ALL their toolCall blocks so a parallel-tool assistant (one message, several
 * calls) is handled (spec/06 §9). Returns false if `messages` is malformed, no assistant is present, or no match.
 */
function assistantIssuedCall(
  messages: MessageLike[] | unknown,
  indices: number[],
  callId: string,
): boolean {
  if (!Array.isArray(messages)) return false;
  for (const i of indices) {
    const msg = messages[i];
    if (!isRecord(msg) || readOwn(msg, "role") !== "assistant") continue;
    const content = readOwn(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || readOwn(block, "type") !== "toolCall") continue;
      if (readOwn(block, "id") === callId) return true; // this assistant issued the excluded call
    }
  }
  return false;
}

// ── resolveLastTurn (last_turn targeting; spec/06 §4) ─────────────────────────────────

/**
 * resolveLastTurn — find the removal set for a "last_turn" rewind (spec/06-context-filter.md §4).
 *
 * A TURN = a user message plus everything after it up to (not including) the next user message. The last turn
 * begins at iLastUser = index of the last message with role "user".
 *
 * ALGORITHM (spec/06 §4, steps 1–3):
 *   1. Find iLastUser = index of the last "user" message. If none → { remove: [] } (nothing to rewind).
 *   2. DEFAULT (opts.to_previous_prompt !== true): KEEP the user message; remove every message AFTER iLastUser
 *      EXCEPT (a) the rewind's OWN unit (assistant message that issued `excludeToolCallId` + its results via
 *      partitionIntoUnits + assistantIssuedCall), and (b) any `mulligan:*` custom messages at the tail.
 *   3. NUCLEAR (opts.to_previous_prompt === true): ALSO remove the user message at iLastUser (plus the same
 *      after-iLastUser removal with the same exclusions). REFUSED when iLastUser is the FIRST user message
 *      (iFirstUser === iLastUser) — would cross the protected first-user / original-task boundary (spec/06 §8,
 *      spec/08 E3).
 *
 * RETURNS `{ remove: number[] }` (NOT number[] | null — empty array = no-op/refusal).
 * `rw.options` carries `to_previous_prompt` (snake_case — the persisted marker field, spec/04 §3);
 * this function reads it VERBATIM (D1).
 *
 * Pure + defensive: a non-array `messages` → { remove: [] }; malformed messages, throwing-Proxy messages, a
 * non-string/empty `excludeToolCallId`, and malformed `opts` are all handled gracefully — NEVER throws (E13).
 */
export function resolveLastTurn(
  messages: MessageLike[],
  opts: { to_previous_prompt?: boolean } | undefined,
  excludeToolCallId?: string,
): { remove: number[] } {
  // Defensive: a non-array messages (shouldn't happen) → nothing to rewind.
  if (!Array.isArray(messages)) return { remove: [] };

  // 1) iLastUser = index of the LAST "user" message.
  let iLastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") iLastUser = i;
  }
  if (iLastUser === -1) return { remove: [] }; // no user message → nothing to rewind (protected)

  const nuclear = opts !== undefined && opts.to_previous_prompt === true;

  // 3) Nuclear protected check: refuse if iLastUser is the FIRST user message (would cross the original-task line).
  if (nuclear) {
    let iFirstUser = -1;
    for (let i = 0; i < messages.length; i++) {
      if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") {
        iFirstUser = i;
        break;
      }
    }
    if (iFirstUser === iLastUser) return { remove: [] }; // nuclear refused (spec/06 §8, spec/08 E3)
  }

  // 2) rewindOwnIndices = the set of message indices in the rewind's OWN unit (kept whole). Only when
  //    excludeToolCallId is a non-empty string; the unit is found via partitionIntoUnits + assistantIssuedCall.
  const rewindOwnIndices = new Set<number>();
  const hasExclude = typeof excludeToolCallId === "string" && excludeToolCallId.length > 0;
  if (hasExclude) {
    const units = partitionIntoUnits(messages);
    for (const unit of units) {
      if (unit.kind === "toolGroup" && assistantIssuedCall(messages, unit.indices, excludeToolCallId)) {
        for (const idx of unit.indices) rewindOwnIndices.add(idx); // keep the WHOLE unit (parallel-safe — §9)
      }
    }
  }

  // 4) Build the removal set, ASCENDING. Nuclear removes iLastUser too; then every index > iLastUser
  //    except the rewind's own unit and mulligan:* custom messages.
  const remove: number[] = [];
  if (nuclear) remove.push(iLastUser);
  for (let j = iLastUser + 1; j < messages.length; j++) {
    if (rewindOwnIndices.has(j)) continue; // the rewind's own assistant + results survive
    if (isMulliganCustomMessage(messages[j])) continue; // the note / nudge survives
    remove.push(j);
  }
  return { remove };
}

/**
 * Module-private: is this message a `mulligan:*` custom message (the note / nudge that MUST survive a rewind)?
 * Detected by a `customType` string with the `mulligan:` prefix. Defensive (isRecord/readOwn; never throws).
 */
function isMulliganCustomMessage(msg: unknown): boolean {
  if (!isRecord(msg)) return false;
  const customType = readOwn(msg, "customType");
  return typeof customType === "string" && customType.startsWith("mulligan:");
}

// ── resolveCheckpoint (checkpoint targeting — entry→message mapping; spec/06 §6) ─────────

/**
 * Minimal structural SessionEntry-like type for resolveCheckpoint's branchEntries param. A real Pi SessionEntry[]
 * from getBranch() assigns in with NO cast — structural typing. EXPORTED so tests build typed fixtures.
 */
export interface BranchEntry {
  type: string; // "message" | "custom_message" | "compaction" | "branch_summary" | "label" | "custom" | ...
  id: string;
  parentId?: string | null;
  timestamp?: string;
  /** LabelEntry only — the entry this label points at (the checkpointed entry). */
  targetId?: string;
  /** LabelEntry only — the label string, e.g. "mulligan:checkpoint:before-x". */
  label?: string;
  [key: string]: unknown; // message/customType/summary/firstKeptEntryId/... read defensively via readOwn
}

/**
 * resolveCheckpoint — map a named `mulligan:checkpoint:<name>` Pi LabelEntry to a message index, then compute
 * the removal set for a `checkpoint` rewind (spec/06-context-filter.md §6).
 *
 * ALGORITHM (spec/06 §6, steps 1–6):
 *   1. Defensive: non-array messages/branchEntries, or checkpointName not a non-empty string → null.
 *   2. Find the FIRST LabelEntry (scanning branchEntries in REVERSE / leaf→root) whose label ===
 *      `mulligan:checkpoint:${checkpointName}`. None → null. targetId = its targetId; non-string/empty → null.
 *   3. ctxEntries = branchEntries (root→leaf) filtered to context-producing types (message, custom_message,
 *      branch_summary, compaction — spec/06 §6 step 2).
 *   4. Walk ctxEntries with msgCursor. For each entry: yield = entryMessageYield(entry);
 *      yield < 0 (compaction/unknown → indeterminate) OR msgCursor+yield > messages.length → null.
 *      If entry.id === targetId → iTarget = msgCursor + yield - 1; break.
 *      Else msgCursor += yield. Loop end without match → null.
 *   4b. UNIT-SNAP: partitionIntoUnits(messages); if iTarget is inside a toolGroup, advance to the unit's MAX index
 *      so the assistant + ALL its toolResults are KEPT (never orphan — spec/06 §2, api_verification §6.4).
 *   5. remove (ascending): for j from (unit-snapped) iTarget+1..end, skip if rewindOwnIndices.has(j) or
 *      isMulliganCustomMessage(messages[j]). Else push.
 *   6. Return { remove }.
 *
 * COMPACTION: entryMessageYield returns -1 for compaction → this function returns null (refuse safely, never guess).
 *
 * RETURNS `{ remove: number[] } | null` — null = indeterminate/refuse; { remove: [] } = determinable-but-empty.
 */
export function resolveCheckpoint(
  messages: MessageLike[],
  branchEntries: BranchEntry[],
  checkpointName: string,
  excludeToolCallId?: string,
): { remove: number[] } | null {
  // 1) Defensive: arrays + a non-empty checkpoint name.
  if (!Array.isArray(messages) || !Array.isArray(branchEntries)) return null;
  if (typeof checkpointName !== "string" || checkpointName.length === 0) return null;

  const needle = `mulligan:checkpoint:${checkpointName}`;

  // 2) Find the FIRST (most-recent) LabelEntry with the matching label. branchEntries is ROOT→LEAF,
  //    so scan from the END (leaf→root) so the most-recent (leaf-most) match wins.
  let targetId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (!isRecord(e)) continue;
    if (readOwn(e, "type") !== "label") continue;
    if (readOwn(e, "label") !== needle) continue;
    const tid = readOwn(e, "targetId");
    if (typeof tid === "string" && tid.length > 0) {
      targetId = tid;
      break; // most-recent (leaf-most) match wins
    }
  }
  if (targetId === undefined) return null; // not found on this branch (spec/08 E10) → refuse

  // 3) ctxEntries = branchEntries (root→leaf) filtered to context-producing types.
  const ctxEntries = branchEntries.filter((e) =>
    isContextProducingType(isRecord(e) ? readOwn(e, "type") : undefined),
  );

  // 4) Walk in parallel with messages; stop at the target entry → iTarget = its last message index.
  let msgCursor = 0;
  let iTarget = -1;
  let found = false;
  for (const e of ctxEntries) {
    const y = entryMessageYield(e); // 1 for message/custom_message/branch_summary; -1 for compaction/unknown
    if (y < 0) return null; // compaction (or unknown) on the walked range → mapping indeterminate → refuse
    if (msgCursor + y > messages.length) return null; // alignment lost → refuse
    if (isRecord(e) && readOwn(e, "id") === targetId) {
      iTarget = msgCursor + y - 1; // the entry's LAST message index — KEPT
      found = true;
      break;
    }
    msgCursor += y;
  }
  if (!found) return null; // targetId labels a non-context-producing entry → refuse

  // 4b) UNIT-SNAP (BUG-003 secondary / spec/06 §2): if iTarget is inside a toolGroup unit, snap to the unit's MAX
  //     index so the entire unit (assistant + all results) is KEPT and remove begins strictly after it.
  const units = partitionIntoUnits(messages);
  for (const unit of units) {
    if (unit.indices.includes(iTarget)) {
      iTarget = Math.max(...unit.indices);
      break;
    }
  }

  // 5) remove = indices > iTarget, EXCEPT the rewind's own unit + mulligan:* notes (IDENTICAL to resolveLastTurn).
  const rewindOwnIndices = new Set<number>();
  const hasExclude = typeof excludeToolCallId === "string" && excludeToolCallId.length > 0;
  if (hasExclude) {
    for (const unit of units) {
      if (unit.kind === "toolGroup" && assistantIssuedCall(messages, unit.indices, excludeToolCallId)) {
        for (const idx of unit.indices) rewindOwnIndices.add(idx); // keep the WHOLE unit (parallel-safe — §9)
      }
    }
  }
  const remove: number[] = [];
  for (let j = iTarget + 1; j < messages.length; j++) {
    if (rewindOwnIndices.has(j)) continue; // the rewind's own assistant + results survive
    if (isMulliganCustomMessage(messages[j])) continue; // the note / nudge survives
    remove.push(j);
  }
  return { remove };
}

/**
 * Module-private: how many LLM messages does this branch entry produce? message/custom_message/branch_summary → 1;
 * compaction → -1 (indeterminate; raw getBranch misaligns with compaction-aware messages → caller refuses).
 * Non-context-producing types also return -1. Defensive (isRecord/readOwn; never throws).
 */
function entryMessageYield(entry: unknown): number {
  const type = isRecord(entry) ? readOwn(entry, "type") : undefined;
  if (type === "message" || type === "custom_message" || type === "branch_summary") return 1;
  return -1; // compaction (indeterminate) OR unknown/non-context-producing → caller refuses
}

/** Module-private: is this entry type one that produces a context message (spec/06 §6 step 2 list)? */
function isContextProducingType(type: unknown): boolean {
  return type === "message" || type === "custom_message" || type === "branch_summary" || type === "compaction";
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// APPLY-OPS + PROTECTION + COMPOSITION (P1.M2.T6.S1)
// Five contract functions + supporting types/helpers, all PURE + Pi-FREE (0 imports — zero-import invariant).
// Reuses partitionIntoUnits / resolveLastToolCallGroup / resolveLastTurn / resolveCheckpoint / MessageLike /
// BranchEntry / Unit + the module-private isRecord / readOwn (all in scope from T4/T5).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * applyRewind — gap-closed removal over resolved unit indices (spec/06 §3/§4).
 * Non-array messages → []; non-array/empty remove → messages UNCHANGED (SAME ref — no-op/idempotent;
 * spec/10 §1.4). Builds a Set of NUMERIC removal indices (non-numbers/NaN ignored); empty Set → SAME ref.
 * `messages.filter((_msg,i)=>!removeSet.has(i))` (gap-closed; callback IGNORES the element → throwing-Proxy
 * get-trap never fires → never throws — E13). Never mutates input.
 *
 * @param messages the message list; non-array → []
 * @param remove ascending message indices to drop (from a resolver); empty/non-array → messages unchanged
 * @returns a NEW array with `remove` indices dropped (gap closed); the SAME array reference when nothing is removed
 */
export function applyRewind(messages: MessageLike[], remove: number[]): MessageLike[] {
  if (!Array.isArray(messages)) return [];
  if (!Array.isArray(remove) || remove.length === 0) return messages;

  const removeSet = new Set<number>();
  for (const r of remove) {
    if (typeof r === "number" && !Number.isNaN(r)) removeSet.add(r);
  }
  if (removeSet.size === 0) return messages;

  return messages.filter((_msg, i) => !removeSet.has(i));
}

/**
 * ShrinkTarget — how a shrink identifies the message whose content to substitute (spec/04 §4; spec/06 §5).
 * Discriminated union; resolveShrinkTarget resolves it LIVE each inference against the current messages
 * (compaction-robust). STRUCTURALLY IDENTICAL to markers.ts's ShrinkTarget — declared LOCALLY so transforms.ts
 * stays Pi-FREE (0 imports). EXPORTED so the shrink tool (M4.T2) and tests share one shape at the pure tier.
 */
export type ShrinkTarget =
  | { by_tool_call_id: string }
  | { by_tool_name: string; occurrence: "last" | "first" }
  | { by_content_includes: string };

/**
 * resolveShrinkTarget — resolve a ShrinkTarget to a single message index, LIVE against the current messages
 * (spec/06 §5; spec/04 §4). Returns the matched index or null.
 *
 * MATCHER STRATEGIES (spec/06 §5):
 *   - by_tool_call_id: first toolResult whose toolCallId === id (unique → at most one).
 *   - by_tool_name + occurrence: among toolResults with toolName === name, LAST (default) or FIRST.
 *   - by_content_includes: first message (ANY role — E19) whose stringified content includes the substring.
 * First present non-empty-string discriminator wins; no recognizable discriminator → null.
 * NEVER throws (every field read via isRecord/readOwn; E13).
 *
 * @param messages the message list; non-array → null
 * @param target the ShrinkTarget (discriminated union); non-record → null
 * @returns the matched message index, or null when nothing matches
 */
export function resolveShrinkTarget(messages: MessageLike[], target: ShrinkTarget): number | null {
  if (!Array.isArray(messages)) return null;
  if (!isRecord(target)) return null;

  // by_tool_call_id: first toolResult whose toolCallId === id (unique → at most one).
  const callId = readOwn(target, "by_tool_call_id");
  if (typeof callId === "string" && callId.length > 0) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!isRecord(m) || readOwn(m, "role") !== "toolResult") continue;
      if (readOwn(m, "toolCallId") === callId) return i;
    }
    return null;
  }

  // by_tool_name + occurrence: among toolResults with toolName === name, last (default) or first.
  const name = readOwn(target, "by_tool_name");
  if (typeof name === "string" && name.length > 0) {
    const wantFirst = readOwn(target, "occurrence") === "first"; // anything else (incl. missing) → last
    let found = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!isRecord(m) || readOwn(m, "role") !== "toolResult") continue;
      if (readOwn(m, "toolName") === name) {
        if (wantFirst) return i;
        found = i;
      }
    }
    return found === -1 ? null : found;
  }

  // by_content_includes: first message (ANY role — E19) whose stringified content includes the substring.
  const needle = readOwn(target, "by_content_includes");
  if (typeof needle === "string") {
    for (let i = 0; i < messages.length; i++) {
      if (stringifyContent(readOwn(messages[i], "content")).includes(needle)) return i;
    }
    return null;
  }

  return null; // no recognizable discriminator key
}

/**
 * applyShrink — LIVE-ONLY 2-param content substitution (spec/06 §5; spec/08 E8/E17/E19).
 * Resolves the target to a message index; null/out-of-range → messages UNCHANGED (SAME ref — no-op, E8).
 * Else `{...orig, content:[{type:"text",text:replacement}]}` (spread preserves role/toolCallId/toolName/isError
 * → pairing intact + role preserved E19); try/catch on throwing-Proxy spread → minimal fallback.
 * New array via messages.map; non-matched copied by reference.
 * Multiple shrinks same target → seq order LAST wins (automatic via re-resolution; E17).
 * CONTRACT: 2-param LIVE-ONLY (no branchEntries/pinnedEntryId — later task; NO import from markers.ts).
 *
 * @param messages the message list; non-array → []
 * @param marker { target, replacement } (a real ShrinkMarker assigns in with no cast)
 * @returns a NEW array with the matched message's content substituted; the SAME array reference on a no-op
 */
export function applyShrink(
  messages: MessageLike[],
  marker: { target: ShrinkTarget; replacement: string },
): MessageLike[] {
  if (!Array.isArray(messages)) return [];
  if (!isRecord(marker)) return messages;

  const i = resolveShrinkTarget(messages, readOwn(marker, "target") as ShrinkTarget);
  if (i === null || i < 0 || i >= messages.length) return messages;

  const orig = messages[i];
  const rep = readOwn(marker, "replacement");
  const text = typeof rep === "string" ? rep : "";
  const newContent = [{ type: "text", text }];

  const role = readOwn(orig, "role");
  let replacement: MessageLike;
  try {
    replacement = { ...(orig as MessageLike), content: newContent };
  } catch {
    replacement = { role: typeof role === "string" ? role : undefined, content: newContent };
  }

  return messages.map((m, j) => (j === i ? replacement : m));
}

/**
 * Module-private: stringify a message's `content` for by_content_includes substring search.
 * String → verbatim; array → JSON.stringify; anything else → "". Never throws (try/catch on JSON.stringify).
 */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

// ── marker / config structural types (read-slice contract with markers.ts/config.ts) ─────────────────────

/**
 * RewindMarkerLike — the structural slice of a persisted RewindMarker that filterPipeline READS
 * (spec/04 §3; spec/06 §1/§12). Carries the optional pinned-target field hideEntryIds (see field doc).
 * Declared LOCALLY so transforms.ts stays Pi-FREE. A real markers.ts RewindMarker assigns in with NO cast.
 */
export interface RewindMarkerLike {
  seq: number;
  granularity: "last_tool_call_group" | "last_turn" | "checkpoint";
  options?: { to_previous_prompt?: boolean };
  excludeToolCallId?: string;
  checkpoint?: string;
  /**
   * Optional pinned target — the SessionEntry ids this rewind resolved to hide at
   * creation time. When present and non-empty, filterPipeline resolves the removal
   * set from these ids (stable) instead of the live granularity resolver.
   * Absent on legacy/unpinned markers → live resolution (backward compat).
   */
  hideEntryIds?: string[];
}

/**
 * ShrinkMarkerLike — the structural slice of a persisted ShrinkMarker that filterPipeline READS + ORDERS
 * (spec/04 §4; spec/06 §5). NO `pinnedEntryId` — that's a later fix task. Structurally assignable to
 * applyShrink's {target, replacement} param (extra `seq` is fine).
 */
export interface ShrinkMarkerLike {
  seq: number;
  target: ShrinkTarget;
  replacement: string;
}

/** MarkerBundle — the marker set filterPipeline transforms (spec/06 §1; spec/03 §5). */
export interface MarkerBundle {
  rewinds: RewindMarkerLike[];
  shrinks: ShrinkMarkerLike[];
}

/** ProtectedConfig — the config slice protectedOk reads (spec/06 §8; spec/04 §7). */
export interface ProtectedConfig {
  rewind: { protectedRoles: string[] };
}

// ── stableSortBySeq + readOwnSeq ────────────────────────────────────────────────────────────────────

/**
 * stableSortBySeq — return a NEW array of markers sorted ASCENDING by `seq` (oldest-first), preserving input
 * order for equal seq (stable). Non-array → []; seq missing/non-finite/throwing-Proxy → 0. Never mutates input.
 * (spec/06 §1; spec/03 §5.)
 */
export function stableSortBySeq<T extends { seq?: unknown }>(markers: T[]): T[] {
  if (!Array.isArray(markers)) return [];
  return [...markers].sort((a, b) => readOwnSeq(a) - readOwnSeq(b));
}

/** Module-private: read a marker's `seq` as a finite number (0 if missing/non-finite/throwing-Proxy). */
function readOwnSeq(marker: unknown): number {
  const s = readOwn(marker, "seq");
  return typeof s === "number" && Number.isFinite(s) ? s : 0;
}

// ── protectedOk (spec/06 §8) ────────────────────────────────────────────────────────────────────────

/**
 * protectedOk — the FILTER's defense-in-depth check for a rewind's removal set (spec/06 §8). Returns true when
 * the rewind is ALLOWED to remove; false when it must be SKIPPED. Enforces first:user: min(remove) > iFirstUser.
 * Empty/non-array remove → true (vacuous); non-array messages → true. Config omitting "first:user" from
 * protectedRoles → true (disabled). Malformed/missing config → enforce (fail safe). NEVER throws (E13).
 *
 * @param messages the CURRENT message list; non-array → true (vacuous)
 * @param remove the rewind's removal index set; empty/non-array → true
 * @param config the config slice; missing/malformed → enforce first:user (fail safe)
 * @returns true if the rewind may proceed; false if it must be skipped
 */
export function protectedOk(
  messages: MessageLike[],
  remove: number[],
  config: ProtectedConfig | undefined,
): boolean {
  if (!Array.isArray(remove) || remove.length === 0) return true;
  if (!Array.isArray(messages)) return true;

  let protectFirstUser = true;
  const rewindCfg = isRecord(config) ? readOwn(config, "rewind") : undefined;
  const roles = isRecord(rewindCfg) ? readOwn(rewindCfg, "protectedRoles") : undefined;
  if (Array.isArray(roles) && roles.length > 0) {
    protectFirstUser = roles.some((r) => r === "first:user");
  }
  if (!protectFirstUser) return true;

  let iFirstUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") {
      iFirstUser = i;
      break;
    }
  }
  if (iFirstUser === -1) return true;

  let minRemove = Infinity;
  for (const r of remove) {
    if (typeof r === "number" && !Number.isNaN(r) && r < minRemove) minRemove = r;
  }
  if (!Number.isFinite(minRemove)) return true;
  return minRemove > iFirstUser;
}

// ── filterPipeline (granularity dispatch ONLY — spec/06 §1/§5/§8/§11/§12; spec/03 §5) ──────────────────

/**
 * filterPipeline — Mulligan's composition core: apply persisted markers to a message list (spec/06 §1/§5/§8/§11/§12;
 * spec/03 §5). The single PURE entry point the context handler (filter.ts, M3) calls.
 *
 * ORDER (FIXED): (1) rewinds oldest-first, each resolving against the CURRENT (already-reduced) array, gated by
 * protectedOk → applyRewind; (2) shrinks oldest-first via applyShrink; (3) return. NO injectNudge (filter.ts's job
 * per external_deps §3.1). NO hideEntryIds/turnHasAdvanced/diag (later fix tasks — CONTRACT is granularity dispatch
 * only). RE-PARTITIONS fresh each rewind iteration.
 *
 * SAME reference as messages when no marker transforms anything. Never throws (E13). Pure + deterministic.
 *
 * @param messages      the message list; non-array → []
 * @param markers       { rewinds, shrinks }; undefined/non-record → pass-through
 * @param config        the config slice protectedOk reads; undefined → enforce first:user
 * @param branchEntries getBranch() output for checkpoint rewinds (root→leaf); optional
 * @returns the filtered message array; SAME ref when no transform
 */
export function filterPipeline(
  messages: MessageLike[],
  markers: MarkerBundle | undefined,
  config: ProtectedConfig | undefined,
  branchEntries?: BranchEntry[],
): MessageLike[] {
  if (!Array.isArray(messages)) return [];

  const bundle = isRecord(markers) ? markers : undefined;
  const rewindsRaw = bundle ? readOwn(bundle, "rewinds") : undefined;
  const shrinksRaw = bundle ? readOwn(bundle, "shrinks") : undefined;
  const rewinds: RewindMarkerLike[] = Array.isArray(rewindsRaw) ? (rewindsRaw as RewindMarkerLike[]) : [];
  const shrinks: ShrinkMarkerLike[] = Array.isArray(shrinksRaw) ? (shrinksRaw as ShrinkMarkerLike[]) : [];

  let m = messages;

  // 1) REWINDS, oldest-first (stableSortBySeq). RE-PARTITION fresh each iteration.
  for (const rw of stableSortBySeq(rewinds)) {
    const granularity = readOwn(rw, "granularity");
    const excludeRaw = readOwn(rw, "excludeToolCallId");
    const excludeId = typeof excludeRaw === "string" ? excludeRaw : undefined;

    let remove: number[];
    if (granularity === "last_tool_call_group") {
      const units = partitionIntoUnits(m); // RE-PARTITION fresh each iteration
      remove = resolveLastToolCallGroup(units, m, excludeId) ?? [];
    } else if (granularity === "last_turn") {
      remove = resolveLastTurn(
        m,
        readOwn(rw, "options") as { to_previous_prompt?: boolean } | undefined,
        excludeId,
      ).remove;
    } else if (granularity === "checkpoint") {
      const cpRaw = readOwn(rw, "checkpoint");
      const cpName = typeof cpRaw === "string" ? cpRaw : "";
      remove = resolveCheckpoint(m, Array.isArray(branchEntries) ? branchEntries : [], cpName, excludeId)?.remove ?? [];
    } else {
      remove = [];
    }

    if (!protectedOk(m, remove, config)) continue;
    m = applyRewind(m, remove);
  }

  // 2) SHRINKS, oldest-first (stableSortBySeq). ShrinkMarkerLike is structurally assignable to applyShrink's param.
  for (const sh of stableSortBySeq(shrinks)) {
    m = applyShrink(m, sh);
  }

  return m;
}
