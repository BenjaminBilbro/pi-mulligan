/**
 * markers.ts — Mulligan's thin, fail-open write-path wrappers around pi.appendEntry / pi.sendMessage / pi.setLabel.
 * spec/04-data-model.md §1 (MulliganEnvelope), §3 (RewindMarker), §4 (ShrinkMarker), §5 (TurnMetric),
 *   §3 (mulligan:note details), §6 (checkpoint = setLabel),
 * spec/02-proven-constraints.md C1 (writes via pi, reads via ctx.sessionManager),
 *   C7 (appendEntry returns void → capture leaf id via getLeafId() immediately, same tick),
 *   C8 (sendMessage from a tool must NOT pass triggerTurn:true — no options arg),
 *   C9 (setLabel/getLabel round-trip works),
 *   C12 (never cache a sessionManager handle across turns — read fresh each call),
 * spec/11-build-order.md §2 Step 4 ("Thin wrappers: appendRewindMarker, appendShrinkMarker, appendTurnMetric,
 *   leaveNote, setCheckpoint, each capturing the leaf id immediately after pi.appendEntry (C7) and incrementing seq."),
 * spec/03-architecture.md §2.1 (tools are write-only; markers.ts is the single write path), principle #4 (fail-open).
 *
 * DESIGN:
 * - This is the ONLY code that calls pi.appendEntry / pi.sendMessage / pi.setLabel for Mulligan persistence.
 *   Downstream consumers: tools/rewind.ts calls appendRewindMarker + leaveNote; tools/shrink.ts calls
 *   appendShrinkMarker; tools/checkpoint.ts calls setCheckpoint; nudges.ts turn_end calls appendTurnMetric.
 * - Every wrapper stamps the {schema:"pi-mulligan", v:1, kind} envelope, a monotonic per-session seq (from
 *   runtime.nextSeq), and ts. It captures the fresh marker's leaf id via ctx.sessionManager.getLeafId()
 *   IMMEDIATELY after pi.appendEntry in the same synchronous tick (C7 — appendEntry returns void).
 * - NEVER throws: each wrapper is wrapped in try/catch + logError; on failure returns null (append*) / void
 *   (leaveNote) / null (setCheckpoint). spec/03 principle #4, spec/08 E13.
 * - DUMB persistence layer: does NOT validate note fields, NOT validate checkpoint names, NOT resolve rewind
 *   targets, NOT read event.messages, NOT register handlers/tools. That is the tools' job (spec/05).
 * - Imports shared payload types from canonical owners (DRY): Granularity from config.ts, NoteInput from
 *   notes.ts, FileLedger from ledger.ts, ShrinkTarget from transforms.ts.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtime, nextSeq } from "./runtime.js";
import { logError } from "./log.js";
import type { Granularity } from "./config.js";
import type { NoteInput } from "./notes.js";
import type { FileLedger } from "./ledger.js";
import type { ShrinkTarget } from "./transforms.js";

// ── Persisted-shape types (spec/04 §1/§3/§4/§5; owned by this module) ──────────

/**
 * MulliganEnvelope — the versioning/tagging envelope inside every persisted CustomEntry's data.
 * spec/04-data-model.md §1. kind is a discriminated union: "rewind" | "shrink" | "turn-metric".
 */
export interface MulliganEnvelope {
  schema: "pi-mulligan";
  v: 1;
  kind: "rewind" | "shrink" | "turn-metric";
}

/**
 * RewindMarker — the full persisted shape of a mulligan:rewind CustomEntry.
 * spec/04-data-model.md §3. Carries the structured note + file ledger for self-containment (audit/debug).
 * checkpoint?: string is spec/05 §1 + spec/06 §6 widening — granularity "checkpoint" targets a named checkpoint.
 */
export interface RewindMarker extends MulliganEnvelope {
  kind: "rewind";
  /** mulligan-internal uuid; also used to correlate with the note. */
  id: string;
  /** What to rewind (spec/06 §4/§5/§6). Uses canonical Granularity (3 literals). */
  granularity: Granularity;
  options: {
    to_previous_prompt?: boolean;
    protect?: string[];
  };
  /** toolCallId of THIS rewind's own tool call, so the filter excludes it (spec/06 §9, spec/08 E6). */
  excludeToolCallId?: string;
  /** Checkpoint name when granularity is "checkpoint" (spec/06 §6). */
  checkpoint?: string;
  /**
   * Optional pinned target — the SessionEntry ids this rewind resolved to hide at
   * creation time. Populated by the capture step (tools/rewind.ts), consumed by
   * filterPipeline resolution. Absent → live resolution (backward compat).
   * Marker DATA, not config.
   */
  hideEntryIds?: string[];
  seq: number;
  note: NoteInput;
  ledger: FileLedger;
  ts: number;
}

/**
 * RewindMarkerInput — everything the caller provides; the wrapper stamps schema/v/kind/id/seq/ts.
 * Omit the envelope fields + id + seq + ts that the wrapper adds.
 */
export type RewindMarkerInput = Omit<RewindMarker, "schema" | "v" | "kind" | "id" | "seq" | "ts">;

/**
 * ShrinkMarker — the full persisted shape of a mulligan:shrink CustomEntry.
 * spec/04-data-model.md §4. target is resolved LIVE each inference by the filter (spec/06 §5).
 */
export interface ShrinkMarker extends MulliganEnvelope {
  kind: "shrink";
  id: string;
  target: ShrinkTarget;
  replacement: string;
  reason?: string;
  seq: number;
  ts: number;
}

/**
 * ShrinkMarkerInput — everything the caller provides; the wrapper stamps schema/v/kind/id/seq/ts.
 */
export type ShrinkMarkerInput = Omit<ShrinkMarker, "schema" | "v" | "kind" | "id" | "seq" | "ts">;

/**
 * TurnMetric — the full persisted shape of a mulligan:turn-metric CustomEntry.
 * spec/04-data-model.md §5. NO id field (deltaTokens is null when baseline missing; prose §5).
 */
export interface TurnMetric extends MulliganEnvelope {
  kind: "turn-metric";
  seq: number;
  ts: number;
  /** Signed estimate of context growth this turn; null when unknown (first turn / post-reload). */
  deltaTokens: number | null;
  /** Any tool_result this turn exceeded bloatThreshold. */
  bloatHit: boolean;
  bloatHits: { toolName: string; approxTokens: number }[];
  /** deltaTokens > driftThresholdTokens. */
  grewOverThreshold: boolean;
  /** The turn index this metric describes (from turn_end event.turnIndex). */
  turnIndex: number;
}

/**
 * TurnMetricInput — everything the caller provides; the wrapper stamps schema/v/kind/seq/ts.
 * TurnMetric has NO id, so we omit only envelope + seq + ts.
 */
export type TurnMetricInput = Omit<TurnMetric, "schema" | "v" | "kind" | "seq" | "ts">;

/**
 * NoteDetails — the details envelope carried by the mulligan:note CustomMessage.
 * spec/04-data-model.md §3: "Its details carries { schema:'pi-mulligan', v:1, kind:'note', rewindId: <marker.id> }."
 */
export interface NoteDetails {
  schema: "pi-mulligan";
  v: 1;
  kind: "note";
  rewindId: string;
}

/**
 * LeaveNoteInput — the payload for leaveNote (object-arg, not positional).
 * content is the rendered markdown note; rewindId correlates with the RewindMarker.id.
 */
export interface LeaveNoteInput {
  content: string;
  rewindId: string;
}

// ── Exported wrapper functions ──────────────────────────────────────────────

/**
 * appendRewindMarker — persist a rewind marker as a Pi CustomEntry (not in LLM context).
 * spec/04 §3, spec/02 C1/C7/C12, spec/11 §2 Step 4.
 *
 * Stamps {schema, v, kind, id:randomUUID(), seq, ts} onto the caller's data, calls pi.appendEntry,
 * then captures the new leaf id via ctx.sessionManager.getLeafId() IMMEDIATELY (C7 — appendEntry returns void).
 * NEVER throws (fail-open): on any error, logs via logError and returns null.
 *
 * @param pi  the ExtensionAPI (write path — spec/02 C1)
 * @param ctx the ExtensionContext (read path — getSessionId/getLeafId via ReadonlySessionManager)
 * @param data the caller-provided fields (granularity, note, ledger, options, etc.)
 * @returns the fresh leaf id (string), or null on failure / null getLeafId()
 */
export function appendRewindMarker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: RewindMarkerInput,
): string | null {
  let sessionId = "unknown";
  try {
    const rt = runtime(ctx.sessionManager);
    sessionId = rt.sessionId;
    const seq = nextSeq(rt);
    const entry: RewindMarker = {
      ...data,
      schema: "pi-mulligan",
      v: 1,
      kind: "rewind",
      id: randomUUID(),
      seq,
      ts: Date.now(),
    };
    pi.appendEntry("mulligan:rewind", entry);
    return ctx.sessionManager.getLeafId();
  } catch (e) {
    logError("markers.rewind", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * appendShrinkMarker — persist a shrink marker as a Pi CustomEntry (not in LLM context).
 * spec/04 §4, spec/02 C1/C7/C12, spec/11 §2 Step 4.
 *
 * Mirrors appendRewindMarker exactly: stamps envelope + id + seq + ts, calls pi.appendEntry,
 * captures leaf id via getLeafId() immediately (C7). NEVER throws.
 *
 * @param pi   the ExtensionAPI
 * @param ctx  the ExtensionContext
 * @param data the caller-provided fields (target, replacement, reason?, etc.)
 * @returns the fresh leaf id (string), or null on failure / null getLeafId()
 */
export function appendShrinkMarker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: ShrinkMarkerInput,
): string | null {
  let sessionId = "unknown";
  try {
    const rt = runtime(ctx.sessionManager);
    sessionId = rt.sessionId;
    const seq = nextSeq(rt);
    const entry: ShrinkMarker = {
      ...data,
      schema: "pi-mulligan",
      v: 1,
      kind: "shrink",
      id: randomUUID(),
      seq,
      ts: Date.now(),
    };
    pi.appendEntry("mulligan:shrink", entry);
    return ctx.sessionManager.getLeafId();
  } catch (e) {
    logError("markers.shrink", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * appendTurnMetric — persist a turn metric as a Pi CustomEntry (not in LLM context).
 * spec/04 §5, spec/02 C1/C7/C12, spec/11 §2 Step 4.
 *
 * Mirrors appendRewindMarker EXCEPT: does NOT stamp id (spec/04 §5 TurnMetric has no id field).
 * Stamps envelope + seq + ts, calls pi.appendEntry, captures leaf id via getLeafId() immediately (C7).
 * NEVER throws.
 *
 * @param pi   the ExtensionAPI
 * @param ctx  the ExtensionContext
 * @param data the caller-provided fields (deltaTokens, bloatHit, bloatHits, etc.)
 * @returns the fresh leaf id (string), or null on failure / null getLeafId()
 */
export function appendTurnMetric(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: TurnMetricInput,
): string | null {
  let sessionId = "unknown";
  try {
    const rt = runtime(ctx.sessionManager);
    sessionId = rt.sessionId;
    const seq = nextSeq(rt);
    const entry: TurnMetric = {
      ...data,
      schema: "pi-mulligan",
      v: 1,
      kind: "turn-metric",
      seq,
      ts: Date.now(),
    };
    pi.appendEntry("mulligan:turn-metric", entry);
    return ctx.sessionManager.getLeafId();
  } catch (e) {
    logError("markers.turn-metric", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * leaveNote — send the agent's note as a Pi CustomMessage (IN LLM context).
 * spec/04 §3, spec/02 C8, spec/11 §2 Step 4.
 *
 * Calls pi.sendMessage with customType:"mulligan:note", display:true, and the NoteDetails envelope.
 * NO second options arg (C8 — mid-turn; triggerTurn stays default false).
 * NEVER throws (fail-open): on error, logs via logError and returns void.
 *
 * @param pi   the ExtensionAPI
 * @param note { content, rewindId } — the rendered note text and the rewind marker id for correlation
 */
export function leaveNote(pi: ExtensionAPI, note: LeaveNoteInput): void {
  try {
    const details: NoteDetails = {
      schema: "pi-mulligan",
      v: 1,
      kind: "note",
      rewindId: note.rewindId,
    };
    pi.sendMessage({
      customType: "mulligan:note",
      content: note.content,
      display: true,
      details,
    });
  } catch (e) {
    logError("markers.note", "unknown", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * setCheckpoint — label the current leaf as a mulligan checkpoint.
 * spec/04 §6, spec/02 C9, spec/11 §2 Step 4.
 *
 * Gets the current leaf id via ctx.sessionManager.getLeafId() and calls pi.setLabel with the
 * "mulligan:checkpoint:" prefix. The wrapper ONLY prefixes; name validation (/^[a-z0-9_-]{1,40}$/,
 * spec/05 §3) is the checkpoint TOOL's job. No seq bump (checkpoints are LabelEntrys, not markers).
 * NEVER throws (fail-open): on error or null leaf id, logs via logError and returns null.
 *
 * @param pi   the ExtensionAPI
 * @param ctx  the ExtensionContext
 * @param name the checkpoint name (validated by the caller/tool)
 * @returns the leaf id (string), or null on failure / null getLeafId()
 */
export function setCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
): string | null {
  let sessionId = "unknown";
  try {
    sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === null) {
      logError("markers.checkpoint", sessionId, {
        error: "no leaf to checkpoint",
      });
      return null;
    }
    // Label the LAST CONTEXT-PRODUCING entry on the branch (message, custom_message,
    // branch_summary, compaction) — not necessarily the leaf itself (which may be a
    // non-context-producing entry like a turn-metric or label). resolveCheckpoint maps
    // the targetId to a message index via mapEntryIdsToMessageIndices, which only
    // walks context-producing entries; a non-context-producing targetId resolves to
    // nothing → K=0 → empty rewind.
    const branch = ctx.sessionManager.getBranch(); // ROOT→LEAF
    let targetId = leafId;
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      const type = e && typeof e === "object" ? (e as unknown as Record<string, unknown>).type : undefined;
      if (type === "message" || type === "custom_message" || type === "branch_summary" || type === "compaction") {
        targetId = (e as unknown as Record<string, unknown>).id as string;
        break;
      }
    }
    pi.setLabel(targetId, "mulligan:checkpoint:" + name);
    return targetId;
  } catch (e) {
    logError("markers.checkpoint", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
