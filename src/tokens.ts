/**
 * Token & byte estimation helpers — Mulligan's approximate, no-tokenizer accounting.
 * spec/03-architecture.md §2.3 (pure helpers), spec/01-pi-context-internals.md §7 (estimate fuzziness +
 *   confidence flag), spec/04-data-model.md §5/§7 (TurnMetric.bloatHits, EstimateConfidence),
 * spec/05-tools.md §4 (audit consumes estimateTokens), spec/06-context-filter.md §7 (D5: never ctx.getContextUsage),
 * spec/07-preventive-and-nudges.md §1 (resultBytes + approxTokens + bloat threshold in BYTES),
 * spec/10-testing.md §1.7 (estimateTokens test tier), spec/11-build-order.md §1 (tokens.ts).
 *
 * DESIGN:
 * - Foundation-tier and Pi-FREE. Imports NOTHING — not Pi, not config, not log, not runtime. Pure,
 *   deterministic, side-effect-free functions fully unit-testable in isolation (spec/03 §2.3).
 * - NO tokenizer library. Tokens are estimated via a character-count heuristic: ~4 chars ≈ 1 token (OpenAI rule
 *   of thumb). Intentionally approximate; callers receive a TokenConfidence flag (spec/01 §7).
 * - Monotonic in input length, empty → 0, deterministic, and NEVER throws — malformed messages (missing content,
 *   throwing Proxy traps, circular toolCall.arguments) estimate to ≥0 so they can never crash the
 *   context/turn_end/audit hot path (mirrors config.ts's fail-open discipline).
 * - Byte-level measurement (resultBytes) uses UTF-8 byte length (Buffer.byteLength), NOT char length, so
 *   multibyte content ("café" = 5 bytes, not 4) is measured correctly (spec/07 §1).
 */

// ── local structural types ──────────────────────────────────────────────────
// Real Pi types live in @earendil-works/pi-agent-core which is NOT resolvable here. These local structural types
// match the verified Pi shapes; they are STRUCTURAL — a real Pi AgentMessage[] assigns to MessageLike[] with NO cast.

/** Text content block (user / assistant / toolResult / custom). */
interface TextContent {
  type: "text";
  text: string;
}

/** Thinking content block (assistant only). */
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

/** Image content block — `data` is base64 (counted at face value; a deliberate overestimate). */
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Tool call block (assistant only) — substance is name + arguments (id omitted as overhead). */
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Any content block across the message roles. */
type ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent;

/**
 * Minimal structural message shape for estimation. Any Pi AgentMessage variant satisfies this: each carries a
 * `content` that is either a plain string or an array of content blocks. Unknown roles and unsupported content
 * shapes are estimated defensively — estimation NEVER throws.
 * spec/01-pi-context-internals.md §5.
 */
export interface MessageLike {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

/**
 * Confidence label reported alongside a token estimate — conveys HOW APPROXIMATE the number is.
 * spec/04 §7 + spec/01 §7 ("reports estimates as estimates").
 *
 * Structurally identical to config.ts's EstimateConfidence, so the audit tool can mix values from the two modules
 * with no cast. estimateTokens returns "medium" by default; the audit TOOL overrides it with
 * config.audit.estimateConfidence when rendering.
 */
export type TokenConfidence = "low" | "medium" | "high";

/** Result of estimateTokens. */
export interface TokenEstimate {
  /** Non-negative integer token estimate (Math.ceil(totalChars / CHARS_PER_TOKEN)). */
  tokens: number;
  /** Honesty label; defaults to "medium". */
  confidence: TokenConfidence;
}

/**
 * A content block as carried by a Pi `tool_result`. resultBytes inspects ONLY `type`, `text`, `data`, so this
 * deliberately LOOSE structural shape captures exactly what it needs. Unknown/future block types flow through
 * (they contribute 0 bytes — forward-compat).
 * spec/07 §1, spec/01 §5.
 */
export interface ResultContentBlock {
  type: string;
  /** Present on `text` blocks. */
  text?: string;
  /** Present on `image` blocks (base64). */
  data?: string;
  [key: string]: unknown;
}

// ── exported constants ────────────────────────────────────────────────────────

/**
 * CHARS_PER_TOKEN — the character-count heuristic ratio. ~4 characters of English text ≈ 1 token (OpenAI rule of
 * thumb). EXPORTED so consumers and tests reference the same ratio transparently.
 */
export const CHARS_PER_TOKEN = 4;

/** The confidence estimateTokens returns by default (spec/04 §7). */
const DEFAULT_TOKEN_CONFIDENCE: TokenConfidence = "medium";

// ── exported functions ───────────────────────────────────────────────────────

/**
 * estimateTokens — approximate the in-context token cost of a message list via a character-count heuristic.
 *
 * spec/03 §2.3, spec/05 §4, spec/06 §7, spec/10 §1.7. For each message it stringifies the content (plain string
 * or array of content blocks: text, thinking, toolCall name+arguments, image base64 data), sums the character
 * lengths, and returns Math.ceil(totalChars / CHARS_PER_TOKEN). Monotonic; empty → 0. NEVER throws.
 *
 * The `confidence` flag ("medium") conveys that the estimate is approximate (no tokenizer). The audit tool
 * overrides the reported label via config.audit.estimateConfidence. The `model` parameter is accepted for
 * forward-compat but is NOT used in v1.
 *
 * @param messages the message list (single message via estimateTokens([msg]))
 * @param model OPTIONAL model descriptor (v1: unused; reserved for future calibration)
 * @returns { tokens, confidence }
 */
export function estimateTokens(
  messages: MessageLike[] | null | undefined,
  _model?: unknown,
): TokenEstimate {
  const list = Array.isArray(messages) ? messages : [];
  let chars = 0;
  for (const msg of list) {
    chars += messageCharLength(msg);
  }
  return { tokens: Math.ceil(chars / CHARS_PER_TOKEN), confidence: DEFAULT_TOKEN_CONFIDENCE };
}

/**
 * resultBytes — the UTF-8 BYTE size of a tool_result's in-context content.
 * spec/07 §1: "the threshold is in BYTES of the in-context text representation … UTF-8 byte length".
 *
 * For each content block: `text` → Buffer.byteLength(text, "utf8") (multibyte-aware — "café"=5 bytes, NOT 4);
 * `image` → data.length (base64 is ASCII → char length == byte length); unknown type → 0.
 * Pure + defensive: non-array → 0; non-record elements skipped; throwing-Proxy → 0. NEVER throws.
 *
 * @param content the tool_result content array
 * @returns non-negative integer byte count
 */
export function resultBytes(content: ResultContentBlock[] | null | undefined): number {
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = readOwn(block, "type");
    if (type === "text") {
      bytes += stringByteLength(readOwn(block, "text"));
    } else if (type === "image") {
      bytes += stringLength(readOwn(block, "data"));
    }
  }
  return bytes;
}

/**
 * approxTokens — convert a byte count to an approximate token count.
 * spec/04 §5 (TurnMetric.bloatHits[].approxTokens), spec/07 §1: "8 KB ≈ 2k tokens".
 *
 * Formula: Math.ceil(bytes / CHARS_PER_TOKEN). approxTokens(8192) = 2048 reproduces the spec equivalence EXACTLY.
 * Defensive: NaN / ±Infinity / negative → 0. NEVER throws.
 *
 * @param bytes a non-negative byte count (typically resultBytes(content))
 * @returns non-negative integer approximate token count
 */
export function approxTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

// ── module-private defensive helpers (never throw) ────────────────────────────

/** True for plain records (including Object.create(null)); false for null, primitives, arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an own property without throwing (Proxy get-trap may throw); undefined if absent/unreadable. */
function readOwn(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/** Length of a value when it is a string; 0 otherwise. */
function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** Length of JSON.stringify(value); 0 if not stringifiable (circular refs / BigInt → TypeError swallowed). */
function safeStringLength(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s.length : 0;
  } catch {
    return 0;
  }
}

/** UTF-8 BYTE length of a value when it is a string; 0 otherwise. Uses Node global Buffer (no import). */
function stringByteLength(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

/** Character length of one message's stringified content. Defensive — never throws. */
function messageCharLength(msg: MessageLike): number {
  const content = readOwn(msg, "content");
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      n += blockCharLength(block);
    }
    return n;
  }
  return 0;
}

/** Character length of a single content block. Defensive — never throws. */
function blockCharLength(block: unknown): number {
  if (!isRecord(block)) return 0;
  const type = readOwn(block, "type");
  switch (type) {
    case "text":
      return stringLength(readOwn(block, "text"));
    case "thinking":
      return stringLength(readOwn(block, "thinking"));
    case "toolCall": {
      const name = stringLength(readOwn(block, "name"));
      const args = safeStringLength(readOwn(block, "arguments"));
      return name + args;
    }
    case "image":
      return stringLength(readOwn(block, "data"));
    default:
      return 0;
  }
}
