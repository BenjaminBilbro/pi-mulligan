/**
 * filter.ts — Mulligan's `context`-event handler glue: the heart of the extension.
 * spec/06-context-filter.md §1 (the handler pseudocode: read markers → pipeline → cache → fail-open),
 *   §7 (cache lastFiltered for audit);
 * spec/03-architecture.md §2.2 (context handler = the heart; thin read-only glue), §5 (fail-open principle #4);
 * spec/02-proven-constraints.md C4 (context event non-destructive, per-inference; return {messages}),
 *   C5 (filter takes effect on NEXT inference; auto-prompt free),
 *   C12 (read fresh from getEntries() EVERY invocation; never cache a handle);
 * spec/08-edge-cases.md E13 (tool/handler throws → fail-open pass-through, never break the turn),
 *   E14 (config.enabled===false → pass-through);
 * spec/11-build-order.md §2 Step 5 (filter.ts = thin Pi-coupled glue; transform logic in transforms.ts).
 *
 * DESIGN:
 * - TWO named exports + one owned interface: `readMarkers(ctx)`, `contextHandler(event, ctx)`,
 *   `MarkersBundle`. Wiring `pi.on("context", contextHandler)` into index.ts is P1.M5.T1 — NOT this task.
 * - `readMarkers` scans `ctx.sessionManager.getEntries()` FRESH each fire (C12), buckets
 *   `mulligan:rewind`/`mulligan:shrink`/`mulligan:turn-metric` CustomEntrys (type==="custom"),
 *   picks the latest turn-metric by highest `seq`, never throws (fail-open at marker level).
 * - `contextHandler` is thin glue: getConfig().enabled check → runtime(ctx.sessionManager) → readMarkers →
 *   getBranch().slice().reverse() → filterPipeline(messages, markers, config, branchEntries) →
 *   cache in rt.lastFiltered/lastFilterTs → return {messages}. Fail-open try/catch (E13).
 * - NO nudge code (no shouldNudge/injectNudge — deferred to P1.M3.T3).
 * - NO oracle P3/P4 features (cancel/cancelledIds, recentMetrics, high-water, RewindDiag,
 *   pinned-shrink retirement, rewindRefusedTurnIndex).
 */

import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RewindMarker, ShrinkMarker, TurnMetric } from "./markers.js";
import { filterPipeline, type BranchEntry } from "./transforms.js";
import { getConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { logError } from "./log.js";

// ── local structural types ──────────────────────────────────────────────────

/**
 * ContextMessage — a single message in the context event's deep-copied message list.
 * ContextEvent IS re-exported from package root; AgentMessage is NOT — define locally.
 */
type ContextMessage = NonNullable<ContextEvent["messages"]>[number];

/**
 * ContextEventResult — the return type for a context event handler.
 * ContextEventResult is NOT root-exported from the pi package — define locally (structurally identical;
 * `pi.on` resolves structurally).
 */
interface ContextEventResult {
  messages?: ContextMessage[];
}

/**
 * MarkersBundle — the complete set of persisted Mulligan markers for one session.
 * `metric` is the turn-metric with the highest `seq` (null when none).
 * Exported so tests and the audit tool can reference the shape.
 */
export interface MarkersBundle {
  rewinds: RewindMarker[];
  shrinks: ShrinkMarker[];
  metric: TurnMetric | null;
}

// ── module-private defensive helpers (mirror transforms.ts/markers.ts — never throw) ────

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

// ── readMarkers (spec/06 §1; spec/02 C12; fail-open E13) ─────────────────────

/**
 * readMarkers — scan `ctx.sessionManager.getEntries()` FRESH for persisted Mulligan markers.
 *
 * Scans ALL entries for `type==="custom"` with `customType` starting with `"mulligan:"`, then
 * buckets by (customType, kind): `mulligan:rewind`/`rewind` → rewinds[], `mulligan:shrink`/`shrink`
 * → shrinks[], `mulligan:turn-metric`/`turn-metric` → metrics[].
 *
 * Picks the LATEST turn-metric by highest `seq` (null when none).
 * Skips notes (custom_message), labels (checkpoints), malformed entries, and unknown mulligan:*
 * types WITHOUT throwing (fail-open at marker level — E13).
 *
 * NEVER throws: malformed entries → skip; getEntries() throws → empty bundle.
 * C12: reads FRESH each call (never caches ctx/sessionManager handle).
 *
 * @param ctx the ExtensionContext (reads ctx.sessionManager.getEntries() each call)
 * @returns { rewinds, shrinks, metric }
 */
export function readMarkers(ctx: ExtensionContext): MarkersBundle {
  const rewinds: RewindMarker[] = [];
  const shrinks: ShrinkMarker[] = [];
  const metrics: TurnMetric[] = [];

  let entries: unknown[];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return { rewinds, shrinks, metric: null };
  }

  for (const entry of entries) {
    // Skip non-records and non-custom entries (excludes notes=custom_message AND checkpoints=label)
    if (!isRecord(entry) || readOwn(entry, "type") !== "custom") continue;

    const customType = readOwn(entry, "customType");
    if (typeof customType !== "string" || !customType.startsWith("mulligan:")) continue;

    const data = readOwn(entry, "data");
    if (!isRecord(data)) continue;

    const kind = readOwn(data, "kind");

    if (customType === "mulligan:rewind" && kind === "rewind") {
      rewinds.push(data as unknown as RewindMarker);
    } else if (customType === "mulligan:shrink" && kind === "shrink") {
      shrinks.push(data as unknown as ShrinkMarker);
    } else if (customType === "mulligan:turn-metric" && kind === "turn-metric") {
      metrics.push(data as unknown as TurnMetric);
    }
    // else: unknown mulligan:* → skip defensively (forward-compat; NO mulligan:cancel — P3 OMIT)
  }

  // Pick the latest metric by highest seq
  let metric: TurnMetric | null = null;
  let best = -Infinity;
  for (const m of metrics) {
    const s = readOwn(m, "seq");
    const n = typeof s === "number" && Number.isFinite(s) ? s : -Infinity;
    if (n > best) {
      best = n;
      metric = m;
    }
  }

  return { rewinds, shrinks, metric };
}

// ── contextHandler (spec/06 §1/§7; spec/03 §2.2/§5; spec/02 C4/C5/C12; spec/08 E13/E14) ─────────

/**
 * contextHandler — Mulligan's `context`-event handler: the heart of the extension.
 *
 * On EVERY inference: reads persisted Mulligan markers fresh from the session, delegates ALL
 * message-list transformation to the pure `filterPipeline`, caches the filtered view in
 * `runtime.lastFiltered` for `mulligan_audit` (P1.M4.T4), and returns `{ messages }`.
 *
 * Fail-open on ANY error: catches, logs via `logError("filter.fire", ...)`, and returns
 * `undefined` (pass-through) WITHOUT overwriting `rt.lastFiltered` (E13).
 * Disabled when `config.enabled === false` — returns undefined WITHOUT caching (E14).
 *
 * C12: reads getEntries()/getBranch() FRESH each fire (never caches ctx/sessionManager handle).
 * C4: returns `{ messages }` replaces for ONE inference (non-destructive; Pi deep-copies).
 * C5: filter takes effect on NEXT inference (markers persisted by tools, read here).
 *
 * @param event the ContextEvent (Pi provides a deep copy of messages — safe to modify)
 * @param ctx the ExtensionContext (reads sessionManager for entries, branch, sessionId)
 * @returns `{ messages }` on success; `undefined` (pass-through) when disabled or on error
 */
export function contextHandler(
  event: ContextEvent,
  ctx: ExtensionContext,
): ContextEventResult | void {
  let sessionId = "unknown";
  try {
    // FIRST — so catch can log it; C12 fresh read
    sessionId = ctx.sessionManager.getSessionId();

    const config = getConfig();
    if (!config.enabled) return; // disabled → pass-through, NO cache write (E14)

    const rt = runtime(ctx.sessionManager); // get-or-create live SessionRuntime (NOT getRuntime)
    const markers = readMarkers(ctx); // fresh markers each fire (C12)
    const branchEntries = ctx.sessionManager.getBranch().slice().reverse() as unknown as BranchEntry[];

    const messages = filterPipeline(event.messages as unknown as import("./transforms.js").MessageLike[], markers, config, branchEntries);

    // Cache for mulligan_audit (spec/06 §7)
    rt.lastFiltered = messages;
    rt.lastFilterTs = Date.now();

    return { messages: messages as unknown as ContextMessage[] };
  } catch (e) {
    // Fail-open pass-through (E13): log and return undefined — never break the agent turn
    logError("filter.fire", sessionId, {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
}
