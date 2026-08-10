/**
 * runtime.ts — Per-session in-memory (non-persisted) control-state map.
 * Source of truth: spec/04-data-model.md §8 (SessionRuntime core: sessionId, seq, tokenBaseline, lastTurnIndex),
 *   spec/06-context-filter.md §7 (lastFiltered/lastFilterTs audit cache — what mulligan_audit reads; D5: never getContextUsage),
 *   spec/02-proven-constraints.md §C12 (never cache a sessionManager handle across turns),
 *   spec/11-build-order.md §1/§2 Step 1 (runtime.ts is Step 1, foundational, Pi-free).
 *
 * Foundation-tier module: imports NOTHING (not Pi, not config.ts, not log.ts).
 * Downstream consumers: markers.ts (stamps seq), filter.ts (writes lastFiltered/lastFilterTs),
 *   nudges.ts (reads/writes tokenBaseline/lastTurnIndex/pendingBloatHits), tools/audit.ts (reads lastFiltered).
 */

/**
 * AgentMessage — opaque message type alias.
 * Local definition because Pi's AgentMessage is not importable from this Pi-free module.
 * Downstream consumers reference this alias for lastFiltered arrays.
 */
export type AgentMessage = Record<string, unknown>;

/**
 * SessionRuntime — per-session in-memory control state (spec/04 §8 + spec/06 §7).
 * Held in the module-scoped Map; created/reset on session_start; never caches handles (C12).
 */
export interface SessionRuntime {
  /** The Pi session identifier (primitive — never a handle, per C12). */
  sessionId: string;
  /** Monotonic marker counter; stamped INTO each persisted marker by markers.ts for deterministic filter ordering. */
  seq: number;
  /** Token count snapshot at the start of a turn, used for turn-metric delta (nudges.ts). */
  tokenBaseline: number | null;
  /** Index of the most recent turn processed. Rolled forward at turn_end (nudges.ts). */
  lastTurnIndex: number | null;
  /** Cached filtered context view — what the model actually saw on the last inference. Written by filter.ts each fire. */
  lastFiltered: AgentMessage[] | null;
  /** Timestamp (Date.now()) when lastFiltered was last written. Null until the first filter fire. */
  lastFilterTs: number | null;
  /** Accumulated bloated tool-result hits this turn (nudges.ts bloatReminderHandler pushes;
 *   turnEndMetricHandler reads+clears). Empty array between turns. */
  pendingBloatHits: { toolName: string; approxTokens: number }[];
}

/**
 * Module-scoped singleton map of active session runtimes, keyed by sessionId.
 * Tests MUST call clearAll() in beforeEach/afterEach to prevent cross-test contamination.
 */
const runtimes = new Map<string, SessionRuntime>();

/**
 * freshRuntime — create a new SessionRuntime with all fields at their default values.
 * seq starts at 0; nextSeq() pre-increments so the first marker receives seq 1.
 */
function freshRuntime(sessionId: string): SessionRuntime {
  return {
    sessionId,
    seq: 0,
    tokenBaseline: null,
    lastTurnIndex: null,
    lastFiltered: null,
    lastFilterTs: null,
    pendingBloatHits: [],
  };
}

/**
 * runtime(arg) — get-or-create the SessionRuntime for a session.
 * Accepts a plain string sessionId OR a ctx-shaped object exposing getSessionId().
 * Returns the SAME live mutable object per sessionId until reset/clearAll (no defensive copy).
 */
export function runtime(arg: string | { getSessionId(): string }): SessionRuntime {
  const sessionId = typeof arg === "string" ? arg : arg.getSessionId();
  let rt = runtimes.get(sessionId);
  if (rt === undefined) {
    rt = freshRuntime(sessionId);
    runtimes.set(sessionId, rt);
  }
  return rt;
}

/**
 * nextSeq(rt) — pre-increment the monotonic marker counter and return the new value.
 * First call on a fresh runtime returns 1 (seq 0 = no markers yet).
 * The returned value is stamped INTO each persisted marker for deterministic filter ordering.
 */
export function nextSeq(rt: SessionRuntime): number {
  return ++rt.seq;
}

/**
 * resetRuntime(sessionId) — drop one session's runtime from the map.
 * No-op if the sessionId is absent. Never throws (fail-open, spec/03 #4).
 * Wired by index.ts on session_start (P1.M7.T1 — NOT this task).
 */
export function resetRuntime(sessionId: string): void {
  runtimes.delete(sessionId);
}

/**
 * clearAll() — wipe the entire runtime map.
 * No-op if empty. Never throws (fail-open, spec/03 #4).
 * Wired by index.ts on session_shutdown (P1.M7.T1 — NOT this task).
 */
export function clearAll(): void {
  runtimes.clear();
}
