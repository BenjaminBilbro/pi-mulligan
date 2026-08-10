/**
 * audit.ts — the `mulligan_audit` agent-callable tool (spec/05 §4; spec/06 §7; spec/08 E13/E14/E16).
 *
 * The fourth and final Mulligan agent-callable tool. Gives the agent a token-aware view of the context
 * THE MODEL ACTUALLY SEES (the filtered view, D5), flagging the biggest contributors against the bloat
 * threshold, listing active Mulligan markers, and suggesting a shrink target. The SINGLE read-only
 * exception in the tool set — it PERSISTS NOTHING and calls NO `pi` surface at all.
 *
 * DESIGN:
 * - CRITICAL DECISION: audit uses a PLAIN `export const auditTool` (NO `makeAuditTool(pi)` factory)
 *   because it writes nothing. Every read goes through `ctx` or pure helpers. index.ts (P1.M7.T1.S1)
 *   wires it as `pi.registerTool(auditTool)` directly.
 * - Two paths for the filtered view:
 *   PRIMARY: `runtime(ctx.sessionManager).lastFiltered` (cached by the filter each fire).
 *   E16 FALLBACK: `buildContextEntries()` → `sessionEntryToContextMessages` → `filterPipeline` re-run
 *   when `rt.lastFiltered` is null (audit called before any inference).
 * - D5 load-bearing: total computed from the FILTERED view via `estimateTokens(filtered)`, NEVER
 *   `ctx.getContextUsage()` (which counts hidden/rewound tokens — bookkeeping drift).
 * - Whole body in ONE try/catch (E13 never-throws); details on every return path (GOTCHA #4).
 * - Pure helpers (renderAuditReport, describeMessage, buildCallLookup, messageBytes, listCheckpoints)
 *   take DATA not ctx — directly unit-testable in isolation.
 *
 * This item does NOT modify src/index.ts (wiring is P1.M7.T1.S1).
 * This v1 task does NOT invent P3/P4 features (cancelledIds, computeFilteredTotal, bloatThresholdFor).
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  defineTool,
  sessionEntryToContextMessages,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens, resultBytes, type MessageLike } from "../tokens.js";
import { runtime } from "../runtime.js";
import { getConfig } from "../config.js";
import { filterPipeline, type BranchEntry } from "../transforms.js";
import { readMarkers } from "../filter.js";
import type { RewindMarker, ShrinkMarker } from "../markers.js";

// ── Parameter schema (spec/05 §4 — Typebox, VERBATIM) ──────────

/**
 * AuditParams — the typebox parameter schema for `mulligan_audit` (spec/05 §4, VERBATIM).
 * `Static<typeof AuditParams>` === `{ top?: number }`.
 * EXPORTED for tests + the index.ts wiring step.
 */
export const AuditParams = Type.Object({
  top: Type.Optional(
    Type.Number({
      description: "Report only the top N messages by token size. Default 8.",
    }),
  ),
});

/** AuditArgs — the inferred execute-time params type. EXPORTED for ergonomics/tests. */
export type AuditArgs = Static<typeof AuditParams>;

// ── The LLM-facing description string (spec/05 §5 — VERBATIM) ──────────

/**
 * AUDIT_DESC — the LLM-facing description (spec/05 §5 "Description strings", Mode A LLM-facing docs).
 * This string IS the tool's documentation. Copy verbatim — it drives LLM usage.
 */
export const AUDIT_DESC =
  "Show a token breakdown of the context you're currently carrying (what the model actually sees), " +
  "flag the biggest contributors, and list active Mulligan markers. Use this to decide whether to rewind or shrink.";

// ── Result types (always include `details` — CRITICAL GOTCHA #4) ──────────

/** AuditRow — one row in the "Top messages by size" block. EXPORTED for tests. */
export interface AuditRow {
  /** Estimated token count for this message. */
  tokens: number;
  /** The message's role (e.g. "toolResult", "assistant", "user"). */
  role: string;
  /** Human-readable label describing the message content. */
  label: string;
  /** Whether the message exceeds the bloat threshold (strictly > config.nudges.bloatThresholdBytes). */
  bloaty: boolean;
  /** The bloat threshold in bytes (for rendering). */
  thresholdBytes: number;
}

/** AuditDetails — the structured `details` payload surfaced to logs/audit/UI on every return path. EXPORTED. */
export interface AuditDetails {
  totalTokens: number;
  confidence: "low" | "medium" | "high";
  source: "cached" | "fallback";
  nRewinds: number;
  nShrinks: number;
  nCheckpoints: number;
  top: AuditRow[];
  error?: string;
}

// ── Module-private defensive helpers (never throw — mirror tokens.ts/filter.ts) ─────

/** True for plain records (including Object.create(null)); false for null, primitives, arrays. */
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

/** Read an own property as a string; undefined if absent, non-string, or unreadable. */
function readStr(obj: unknown, key: string): string | undefined {
  const v = readOwn(obj, key);
  return typeof v === "string" ? v : undefined;
}

/** Truncate a string to maxLen characters, appending "…" if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** Snippet: first 60 chars of a string, trimmed. */
function snippet(s: string): string {
  return truncate(s.trim(), 60);
}

// ── EXPORTED pure helpers (take DATA not ctx — unit-testable in isolation) ──────────

/**
 * contentFirstText — extract the text from the first `type:"text"` content block in a message.
 * Returns empty string if not found or not a record. NEVER throws.
 */
export function contentFirstText(msg: Record<string, unknown>): string {
  const content = readOwn(msg, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (isRecord(block) && readOwn(block, "type") === "text") {
      const t = readOwn(block, "text");
      return typeof t === "string" ? t : "";
    }
  }
  return "";
}

/**
 * summarizeAssistantContent — produce a compact summary of an assistant message's content blocks.
 * Returns e.g. "(thinking + toolCall x2)" or "(toolCall x3)" or "(text)" or "(message)".
 */
export function summarizeAssistantContent(content: unknown): string {
  if (typeof content === "string") return "(text)";
  if (!Array.isArray(content)) return "(message)";
  let thinking = 0;
  let toolCalls = 0;
  let text = 0;
  let other = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const t = readOwn(block, "type");
    if (t === "thinking") thinking++;
    else if (t === "toolCall") toolCalls++;
    else if (t === "text") text++;
    else other++;
  }
  const parts: string[] = [];
  if (thinking > 0) parts.push(`thinking`);
  if (toolCalls > 0) parts.push(`toolCall x${toolCalls}`);
  if (text > 0 && parts.length === 0) parts.push("text");
  if (parts.length === 0) parts.push("message");
  return `(${parts.join(" + ")})`;
}

/**
 * pickArg — extract a human-readable brief from a toolCall's arguments.
 * Precedence: path / file_path → command → query / pattern / search_query, truncated 40.
 */
function pickArg(args: Record<string, unknown> | undefined): string {
  if (!isRecord(args)) return "";
  for (const key of ["path", "file_path", "command", "query", "pattern", "search_query"]) {
    const v = readOwn(args, key);
    if (typeof v === "string" && v.length > 0) return truncate(v, 40);
  }
  return "";
}

/**
 * briefArgs — extract a brief summary of a toolCall's arguments.
 * If the callLookup has the args, uses pickArg; else tries the msg's own content fallback.
 */
function briefArgs(
  call: { name: string; args: Record<string, unknown> } | undefined,
  msg: Record<string, unknown>,
): string {
  if (call) {
    const a = pickArg(call.args);
    if (a) return a;
  }
  // Fallback: try to find toolCall content in the message itself for args
  const content = readOwn(msg, "content");
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && readOwn(block, "type") === "toolCall") {
        const args = readOwn(block, "arguments");
        if (isRecord(args)) {
          const a = pickArg(args);
          if (a) return a;
        }
      }
    }
  }
  return "";
}

/**
 * describeMessage — produce a human-readable label for a message (used in the Top messages block).
 *
 * - toolResult → `${toolName} ${briefArgs}` (uses the MATCHED toolCall's args via callLookup)
 * - assistant → `summarizeAssistantContent(content)`
 * - user → `user "<snippet>"`
 * - custom → customType
 * - else → role or "message"
 *
 * EXPORTED for direct unit testing.
 */
export function describeMessage(
  msg: Record<string, unknown>,
  callLookup: Map<string, { name: string; args: Record<string, unknown> }>,
): string {
  const role = readStr(msg, "role") ?? "message";

  if (role === "toolResult") {
    const toolName = readStr(msg, "toolName") ?? "tool";
    const callId = readStr(msg, "toolCallId");
    const call = callId ? callLookup.get(callId) : undefined;
    const args = briefArgs(call, msg);
    return args ? `${toolName} ${args}` : toolName;
  }

  if (role === "assistant") {
    return summarizeAssistantContent(readOwn(msg, "content"));
  }

  if (role === "user") {
    const content = readOwn(msg, "content");
    const text = typeof content === "string" ? content : contentFirstText(msg);
    return `user "${snippet(text)}"`;
  }

  const customType = readStr(msg, "customType");
  if (customType) return customType;

  return role;
}

/**
 * buildCallLookup — scan assistant messages' content for toolCall blocks and build a Map
 * of toolCallId → { name, args } so toolResult labels can reference the original call's args.
 *
 * EXPORTED for direct unit testing.
 */
export function buildCallLookup(
  messages: Record<string, unknown>[],
): Map<string, { name: string; args: Record<string, unknown> }> {
  const lookup = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const msg of messages) {
    if (!isRecord(msg) || readOwn(msg, "role") !== "assistant") continue;
    const content = readOwn(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || readOwn(block, "type") !== "toolCall") continue;
      const id = readOwn(block, "id");
      const name = readOwn(block, "name");
      const args = readOwn(block, "arguments");
      if (typeof id === "string" && id.length > 0 && typeof name === "string") {
        lookup.set(id, { name, args: isRecord(args) ? args : {} });
      }
    }
  }
  return lookup;
}

/**
 * messageBytes — compute the UTF-8 byte size of a message's in-context content.
 * - string content → Buffer.byteLength(s, "utf8")
 * - array content → resultBytes(content) (from tokens.ts)
 * - else → 0
 *
 * EXPORTED for direct unit testing.
 */
export function messageBytes(msg: Record<string, unknown>): number {
  const content = readOwn(msg, "content");
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (Array.isArray(content)) return resultBytes(content);
  return 0;
}

/**
 * listCheckpoints — scan getEntries() output for LabelEntries with `mulligan:checkpoint:` prefix,
 * using a latest-wins label map (a clear entry sets undefined overwriting a prior set — a consumed
 * checkpoint does NOT stay listed). Emit active checkpoint names prefix-stripped, in first-occurrence order.
 *
 * EXPORTED for direct unit testing.
 */
export function listCheckpoints(entries: unknown[]): string[] {
  // Latest-wins label map: walk entries in order, later entries for same id overwrite earlier ones.
  const labelMap = new Map<string, string>(); // entryId → label string
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (readOwn(entry, "type") !== "label") continue;
    const id = readOwn(entry, "id");
    const label = readOwn(entry, "label");
    if (typeof id !== "string" || typeof label !== "string") continue;
    labelMap.set(id, label);
  }

  // Now collect active mulligan:checkpoint: labels (prefix-stripped), in first-occurrence order.
  // First-occurrence = the order they first appear in the entries list (walk again).
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (readOwn(entry, "type") !== "label") continue;
    const id = readOwn(entry, "id");
    if (typeof id !== "string") continue;
    // Look up the LATEST label for this entry
    const label = labelMap.get(id);
    if (typeof label !== "string") continue;
    if (!label.startsWith("mulligan:checkpoint:")) continue;
    const name = label.slice("mulligan:checkpoint:".length);
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

// ── PRIVATE helpers ──────────────────────────────────────────────────────

/**
 * entriesToMessages — convert SessionEntry[] to Record<string,unknown>[] via Pi's canonical
 * sessionEntryToContextMessages helper. Defensive — wraps each conversion in try/catch.
 */
function entriesToMessages(entries: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const entry of entries) {
    try {
      const msgs = sessionEntryToContextMessages(entry as Parameters<typeof sessionEntryToContextMessages>[0]);
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (isRecord(m)) result.push(m);
        }
      }
    } catch {
      // skip malformed entries
    }
  }
  return result;
}

/**
 * describeProtected — render the protected roles string for the Protected line.
 * Empty list → "none"; else roles.join("/").
 */
function describeProtected(roles: string[]): string {
  return roles.length > 0 ? roles.join("/") : "none";
}

/**
 * refusal — build a fail-open text result for any refusal case.
 * ALWAYS includes `details` (CRITICAL GOTCHA #4).
 */
function refusal(reason: string): AgentToolResult<AuditDetails> {
  return {
    content: [{ type: "text", text: `Mulligan: refused — ${reason}.` }],
    details: {
      totalTokens: 0,
      confidence: "low",
      source: "fallback",
      nRewinds: 0,
      nShrinks: 0,
      nCheckpoints: 0,
      top: [],
    },
  };
}

// ── EXPORTED pure renderer (unit-testable, no ctx) ──────────────────────────

/**
 * renderAuditReport — render the spec/05 §4 VERBATIM markdown report.
 *
 * PURE function — takes only data, no ctx. EXPORTED for direct unit testing.
 *
 * Formatting rules (load-bearing):
 * - Total line: `Total (filtered): ~<N> tokens  (estimate, confidence: <c>)` — TWO spaces before "(estimate".
 * - Active markers: `<n> rewind (<distinct granularities comma-joined>), <n> shrink, <n> checkpoints [<names>]`.
 *   Empty checkpoint set renders `[]`. Distinct rewind granularities are deduped.
 * - Protected: `will not rewind past <roles.join("/")>`. Empty list → "none".
 * - Each top row: right-aligned 6-wide token count, 11-wide padded role, then label, then bloat flag.
 * - Empty filtered view → render `No messages in filtered view.` and OMIT the Suggestion.
 * - Suggestion names rows[0].label (the largest).
 */
export function renderAuditReport(args: {
  totalTokens: number;
  confidence: "low" | "medium" | "high";
  rewinds: RewindMarker[];
  shrinks: ShrinkMarker[];
  checkpointNames: string[];
  protectedRoles: string[];
  rows: AuditRow[];
  filtered: unknown[];
}): string {
  const {
    totalTokens,
    confidence,
    rewinds,
    shrinks,
    checkpointNames,
    protectedRoles,
    rows,
    filtered,
  } = args;

  const lines: string[] = [];

  // Header
  lines.push("## Mulligan audit — context you are currently carrying");

  // Total line — TWO spaces before "(estimate"
  lines.push(
    `Total (filtered): ~${totalTokens.toLocaleString()} tokens  (estimate, confidence: ${confidence})`,
  );

  // Active markers line
  const rewindGranularities = [...new Set(rewinds.map((r) => r.granularity))];
  const rewindStr = rewinds.length > 0
    ? `${rewinds.length} rewind (${rewindGranularities.join(", ")})`
    : "0 rewind";
  const shrinkStr = `${shrinks.length} shrink`;
  const cpStr = checkpointNames.length > 0
    ? `${checkpointNames.length} checkpoints [${checkpointNames.join(", ")}]`
    : "0 checkpoints []";
  lines.push(`Active markers: ${rewindStr}, ${shrinkStr}, ${cpStr}`);

  // Protected line
  lines.push(`Protected: will not rewind past ${describeProtected(protectedRoles)}.`);

  lines.push("");

  // Empty filtered view
  if (!Array.isArray(filtered) || filtered.length === 0) {
    lines.push("No messages in filtered view.");
    return lines.join("\n") + "\n";
  }

  // Top messages by size
  lines.push("Top messages by size:");
  for (const row of rows) {
    let line = `${String(row.tokens).padStart(6)}  ${row.role.padEnd(11)} ${row.label}`;
    if (row.bloaty) {
      line += `  ⚠ above bloat threshold (${Math.round(row.thresholdBytes / 1024)} KB)`;
    }
    lines.push(line);
  }

  lines.push("");

  // Suggestion — names rows[0].label (the largest); omitted when filtered is empty (handled above)
  if (rows.length > 0) {
    lines.push(
      `Suggestion: the \`${rows[0].label}\` result is the largest contributor. Consider mulligan_shrink.`,
    );
  }

  return lines.join("\n") + "\n";
}

// ── execute (spec/05 §4 behavior; E13 never-throws; E14 config gate) ─────

/**
 * auditExecute — the tool body. The WHOLE body is wrapped in ONE try/catch (E13 never-throws).
 * NEVER calls pi.* or ctx.getContextUsage() (D5).
 */
async function auditExecute(
  _toolCallId: string,
  params: AuditArgs,
  _signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<AgentToolResult<AuditDetails>> {
  try {
    // (1) Config gate (E14) — master switch ONLY. Read ONCE.
    const config = getConfig();
    if (!config.enabled) return refusal("Mulligan is disabled");

    // (2) Get session runtime
    const rt = runtime(ctx.sessionManager);

    // (3) Resolve FILTERED view — NEVER ctx.getContextUsage() (D5)
    let filtered: Record<string, unknown>[];
    let source: "cached" | "fallback";
    let confidence: "low" | "medium" | "high";

    if (Array.isArray(rt.lastFiltered)) {
      // PRIMARY path: use the filter's cached output
      filtered = rt.lastFiltered;
      source = "cached";
      confidence = config.audit.estimateConfidence;
    } else {
      // E16 FALLBACK: no cached filtered view (audit called before any inference)
      const entries = ctx.sessionManager.buildContextEntries();
      const base = entriesToMessages(entries);
      const branch = ctx.sessionManager.getBranch().slice().reverse();
      filtered = filterPipeline(
        base as unknown as import("../transforms.js").MessageLike[],
        readMarkers(ctx),
        config,
        branch as unknown as BranchEntry[],
      );
      source = "fallback";
      confidence = "low";
    }

    // (4) Compute total tokens (estimateTokens NEVER throws)
    const totalTokens = estimateTokens(filtered).tokens;

    // Parse top parameter
    const top =
      typeof params?.top === "number" && params.top > 0
        ? Math.floor(params.top)
        : 8;

    // Build call lookup for toolResult labeling
    const callLookup = buildCallLookup(filtered);
    const threshold = config.nudges.bloatThresholdBytes;

    // Rank messages by token size, take top-N
    const ranked = filtered
      .map((m) => ({
        tokens: estimateTokens([m]).tokens,
        msg: m,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, top);

    const rows: AuditRow[] = ranked.map(({ tokens, msg }) => ({
      tokens,
      role: readStr(msg, "role") ?? "?",
      label: describeMessage(msg, callLookup),
      bloaty: messageBytes(msg) > threshold,
      thresholdBytes: threshold,
    }));

    // (5) Read active markers + checkpoints
    const markers = readMarkers(ctx);
    const checkpointNames = listCheckpoints(
      ctx.sessionManager.getEntries() as unknown[],
    );

    // (6) Render the report
    const report = renderAuditReport({
      totalTokens,
      confidence,
      rewinds: markers.rewinds as RewindMarker[],
      shrinks: markers.shrinks as ShrinkMarker[],
      checkpointNames,
      protectedRoles: config.rewind.protectedRoles,
      rows,
      filtered,
    });

    // (7) Return
    return {
      content: [{ type: "text" as const, text: report }],
      details: {
        totalTokens,
        confidence,
        source,
        nRewinds: markers.rewinds.length,
        nShrinks: markers.shrinks.length,
        nCheckpoints: checkpointNames.length,
        top: rows,
      },
    };
  } catch (e) {
    // E13 never-throws: catch any exception and return a failure text
    const reason = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text" as const, text: `Mulligan: audit failed — ${reason}` }],
      details: {
        totalTokens: 0,
        confidence: "low",
        source: "fallback",
        nRewinds: 0,
        nShrinks: 0,
        nCheckpoints: 0,
        top: [],
        error: reason,
      },
    };
  }
}

// ── Tool definition (PLAIN export const — NO factory; audit needs no pi) ─────

/**
 * auditTool — the tool definition for `mulligan_audit`.
 * A PLAIN `export const` (NO `makeAuditTool(pi)` factory — audit needs no pi).
 * index.ts (P1.M7.T1.S1) does `pi.registerTool(auditTool)` directly.
 */
export const auditTool: ToolDefinition<typeof AuditParams, AuditDetails> = defineTool({
  name: "mulligan_audit",
  label: "Mulligan Audit",
  description: AUDIT_DESC, // spec/05 §5 VERBATIM
  parameters: AuditParams,
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return auditExecute(toolCallId, params, signal, onUpdate, ctx);
  },
});
