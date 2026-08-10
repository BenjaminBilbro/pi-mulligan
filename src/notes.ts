import type { FileLedger } from "./ledger.js";
import type { Granularity } from "./config.js";

/**
 * notes.ts — Mulligan's note validation + rendering (pure helpers).
 * spec/04-data-model.md §2.1 (NoteInput), §2.3 (renderNote),
 *   spec/05-tools.md §1 step 2 (validateNote: all four non-empty),
 *   spec/07-preventive-and-nudges.md §1 (renderBloatReminder), §2 (renderDriftNudge),
 *   spec/08-edge-cases.md E9 (note field validation failure → refuse), E13 (never throw),
 *   spec/10-testing.md §1.8 (field validation + snapshot tests),
 *   spec/03-architecture.md §2.3/§7 + spec/11 §1 (pure helper tier).
 *
 * DESIGN:
 * - Pure-helper tier and Pi-FREE. Imports TYPE-ONLY { FileLedger } from ./ledger.js (P1.M2.T2, Complete) +
 *   { Granularity } from ./config.js (P1.M1.T2, Complete) — erased at compile so notes.ts stays pure +
 *   unit-testable. No Pi surface, no session, no model, no filesystem access, no module-scoped mutable state.
 * - validateNote is the rewind tool's runtime guard against a vacuous note (spec/05 §1 step 2, E9).
 * - NEVER throws on adversarial input (rewind-tool + nudge-handler hot paths; E13).
 */

// ── Exported types (spec/04 §2.1, §2.3, §5) ────────────────────────────────

/**
 * NoteInput — what the agent passes to mulligan_rewind as the `note` (spec/04 §2.1).
 * All four fields are REQUIRED non-empty strings (enforced by validateNote; spec/05 §1 step 2 + spec/08 E9).
 * Field names are LOAD-BEARING — persisted verbatim into RewindMarker.note (spec/04 §3).
 */
export interface NoteInput {
  /** What went wrong, concretely. Past tense. */
  what_happened: string;
  /** What NOT to do again. Imperative. */
  avoid: string;
  /** The current TRUE world state as of the rewind. */
  true_current_state: string;
  /** The immediate next action to take on resume. Imperative. */
  next: string;
}

/** Result of validateNote. `reason` is present iff `valid` is false (always NOTE_INVALID_REASON). */
export interface NoteValidation {
  valid: boolean;
  reason?: string;
}

/**
 * NOTE_INVALID_REASON — the single, spec-pinned refusal reason (spec/05 §1 step 2, spec/08 E9).
 * NO trailing period — the rewind tool adds the prefix "Mulligan: refused — " and the trailing ".".
 */
export const NOTE_INVALID_REASON = "note fields must all be non-empty";

/**
 * DriftNudgeInput — the minimal projection of TurnMetric (spec/04 §5) that renderDriftNudge needs.
 * A real TurnMetric is structurally assignable to this with NO cast (mutable {}[] widens to ReadonlyArray).
 */
export interface DriftNudgeInput {
  /** Signed estimate of context growth this turn; null when unknown (first turn / post-reload). */
  deltaTokens: number | null;
  /** Bloated tool results recorded this turn (empty array if none). */
  bloatHits: ReadonlyArray<{ toolName: string; approxTokens: number }>;
}

// ── Module-private constants ─────────────────────────────────────────────────

/** The four required, non-empty note fields, in spec/04 §2.1 order. */
const NOTE_FIELDS: readonly (keyof NoteInput)[] = [
  "what_happened",
  "avoid",
  "true_current_state",
  "next",
];

/** The three ledger block descriptors, in spec/04 §2.3 order. */
const LEDGER_BLOCKS: ReadonlyArray<
  readonly [tag: string, field: keyof FileLedger]
> = [
  ["files-read", "readFiles"],
  ["files-modified", "modifiedFiles"],
  ["bash-side-effects", "bashSideEffects"],
];

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * validateNote — assert all four NoteInput fields are non-empty strings AFTER TRIM (spec/05 §1 step 2,
 * spec/08 E9, spec/10 §1.8). Returns { valid:true } or { valid:false, reason: NOTE_INVALID_REASON }.
 * NEVER throws (rewind-tool hot path; E13).
 */
export function validateNote(note: NoteInput): NoteValidation {
  if (!isRecord(note)) {
    return { valid: false, reason: NOTE_INVALID_REASON };
  }
  for (const field of NOTE_FIELDS) {
    const value = readOwn(note, field);
    if (typeof value !== "string" || value.trim().length === 0) {
      return { valid: false, reason: NOTE_INVALID_REASON };
    }
  }
  return { valid: true };
}

/**
 * renderNote — compose the markdown note the resumed model reads as the `mulligan:note` CustomMessage content
 * (spec/04 §2.3). Interpolates the NoteInput + FileLedger + Granularity into the pinned markdown shape.
 * Empty ledger lists → their blocks omitted. Granularity interpolated VERBATIM. Field values AS-IS.
 * Sections separated by "\n\n". NO trailing newline. NEVER throws (E13).
 */
export function renderNote(
  note: NoteInput,
  ledger: FileLedger,
  granularity: Granularity,
): string {
  const sections: string[] = [
    `## 🔄 Mulligan rewind (${granularity})`,
    `**What happened:** ${readNoteField(note, "what_happened")}`,
    `**Avoid:** ${readNoteField(note, "avoid")}`,
    `**Current true state:** ${readNoteField(note, "true_current_state")}`,
  ];
  for (const [tag, field] of LEDGER_BLOCKS) {
    const items = readLedgerList(ledger, field);
    if (items.length > 0) {
      sections.push(`<${tag}>\n${items.join("\n")}\n</${tag}>`);
    }
  }
  sections.push(`**Next:** ${readNoteField(note, "next")}`);
  return sections.join("\n\n");
}

/**
 * renderBloatReminder — Nudge A's text (spec/07 §1). The tool_result handler APPENDS this to a bloated result.
 * Returns `\n---\n` + a 4-line body. `toolName` accepted but unused in v1 (reserved). NO trailing newline.
 * Bad numbers (NaN/±Infinity/negative) → 0 KB. NEVER throws (E13).
 */
export function renderBloatReminder(
  _toolName: string,
  bytes: number,
  thresholdBytes: number,
): string {
  const resultKb = bytesToKb(bytes);
  const thresholdKb = bytesToKb(thresholdBytes);
  const body = [
    `[mulligan] This result is ~${resultKb} KB in your context (threshold ${thresholdKb} KB).`,
    "If you don't need the full output going forward, call `mulligan_shrink` with a",
    'summary, or `mulligan_rewind(granularity:"last_tool_call_group")` if the whole',
    "call was a mistake. (The hidden/shrunk content stays on disk for the human.)",
  ].join("\n");
  return `\n---\n${body}`;
}

/**
 * renderDriftNudge — Nudge B's text (spec/07 §2). Composes the per-turn annotation injected as an EPHEMERAL
 * `mulligan:nudge` custom message. First line varies by (delta!=null)×(bloat non-empty); 2 tail lines FIXED.
 * deltaTokens===null → delta clause dropped (NOT rendered as ~0k). NO trailing newline. NEVER throws (E13).
 */
export function renderDriftNudge(metric: DriftNudgeInput): string {
  const delta = readDelta(metric);
  const hits = readBloatHits(metric);
  let firstLine: string;
  if (delta != null && hits.length > 0) {
    firstLine = `Previous turn added ~${kTokens(delta)} tokens to your context and produced ${hits.length} bloated ${resultWord(hits.length)}`;
  } else if (delta != null) {
    firstLine = `Previous turn added ~${kTokens(delta)} tokens to your context`;
  } else if (hits.length > 0) {
    firstLine = `Previous turn produced ${hits.length} bloated ${resultWord(hits.length)}`;
  } else {
    firstLine = "Previous turn changed your context";
  }
  return [
    `[mulligan] ${firstLine}.`,
    "If that growth was wasteful, consider `mulligan_rewind` (undo the turn) or `mulligan_shrink` (compact a result).",
    "Run `mulligan_audit` for a breakdown.",
  ].join("\n");
}

// ── Module-private defensive helpers (mirror ledger.ts/tokens.ts — never throw) ──

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

/** Read a NoteInput field as a string ("" if absent/non-string); defensive, never throws. */
function readNoteField(
  note: unknown,
  key: "what_happened" | "avoid" | "true_current_state" | "next",
): string {
  const v = readOwn(note, key);
  return typeof v === "string" ? v : "";
}

/** Read a FileLedger list as a string[] (filtering to string elements; [] if absent/non-array). */
function readLedgerList(ledger: unknown, field: keyof FileLedger): string[] {
  const v = readOwn(ledger, field);
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** Convert a byte count to an integer KB value for display. Non-finite/negative → 0. */
function bytesToKb(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.round(n / 1024) : 0;
}

/** Render a token delta as a "k" string (1 decimal: 4200→"4.2k", 3000→"3k"). */
function kTokens(delta: number): string {
  return `${Math.round((delta / 1000) * 10) / 10}k`;
}

/** Pluralize "result": 1→"result", else→"results". */
function resultWord(n: number): string {
  return n === 1 ? "result" : "results";
}

/** Read metric.deltaTokens as a finite number, else null (null = unknown, e.g. first turn). */
function readDelta(metric: unknown): number | null {
  const v = readOwn(metric, "deltaTokens");
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read metric.bloatHits as a filtered array of {toolName, approxTokens}; [] if absent/non-array. */
function readBloatHits(
  metric: unknown,
): Array<{ toolName: string; approxTokens: number }> {
  const v = readOwn(metric, "bloatHits");
  if (!Array.isArray(v)) return [];
  const out: Array<{ toolName: string; approxTokens: number }> = [];
  for (const hit of v) {
    if (isRecord(hit)) {
      const toolName = readOwn(hit, "toolName");
      const approxTokens = readOwn(hit, "approxTokens");
      if (
        typeof toolName === "string" &&
        typeof approxTokens === "number" &&
        Number.isFinite(approxTokens)
      ) {
        out.push({ toolName, approxTokens });
      }
    }
  }
  return out;
}
