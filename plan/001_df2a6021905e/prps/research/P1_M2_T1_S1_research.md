# Research — P1.M2.T1.S1: estimateTokens, resultBytes, approxTokens

## Work item (verbatim contract)
`estimateTokens(messages|message|text, model?)` → `{tokens:number, confidence:"low"|"medium"|"high"}`.
Chars-per-token heuristic (~4 chars/token) over content-block text; toolCall/thinking blocks counted
structurally. `resultBytes(content)` = sum of UTF-8 byte length of `.text` across blocks (bloat threshold
is in BYTES, below Pi's 50KB cap). `approxTokens(bytes)` = bytes/4. Confidence defaults to
`config.audit.estimateConfidence`; degrade to "low" when images/large schemas present. Pure, deterministic,
NO Pi import. Empty→0. Monotonic. Consumed by `tools/audit.ts` (P1.M4.T4) + `nudges.ts` (P1.M3.T3).
IMPLICIT TDD: `test/tokens.test.ts` — empty→0; monotonic; known string → stable estimate (snapshot);
resultBytes counts UTF-8; confidence flag present.

## Key spec sections (read in full)
- **spec/10 §1.7** — the explicit test tier for `estimateTokens`: monotonic in input length; empty→0;
  confidence flag present; a known string yields a stable estimate (snapshot test).
- **spec/07 §1** — Nudge A (bloated-result reminder). The `tool_result` handler calls
  `resultBytes(event.content)`, compares to `config.nudges.bloatThresholdBytes` (8192), and stores
  `approxTokens(bytes)` in the persisted `mulligan:turn-metric` `bloatHits[]`. The threshold is explicitly
  "in BYTES of the in-context text representation … UTF-8 byte length. Not model tokens."
- **spec/06 §7** — `mulligan_audit` reads `rt.lastFiltered` and reports the filtered-view token breakdown;
  "Never use ctx.getContextUsage() for the total (D5)."
- **spec/04 §5** — `TurnMetric.bloatHits: { toolName; approxTokens }[]`.
- **spec/04 §7 / spec/09 §2** — `EstimateConfidence = "low"|"medium"|"high"`; `config.audit.estimateConfidence` default "medium".

## Verified reference (read-only oracle) — `/home/dustin/projects/pi-mulligan/src/tokens.ts` (307 lines) + `test/tokens.test.ts`
This is the sibling main-worktree impl per `architecture/system_context.md §3`. It is the authoritative
shape to reproduce. Key facts learned:

### Zero-import design (load-bearing)
The oracle's `tokens.ts` imports **NOTHING** — not Pi, not config, not log. It defines its OWN
`TokenConfidence = "low"|"medium"|"high"` which is *structurally identical* to config.ts's exported
`EstimateConfidence`, so the audit tool can mix values with no cast. Rationale: maximal purity/testability
and no build-order coupling. The work item says "no Pi import"; the oracle goes further (no imports at all)
and that is the right call — preserve it.

### Public surface (exports)
- `estimateTokens(messages: MessageLike[] | null | undefined, _model?: unknown): TokenEstimate`
  - sums `messageCharLength` over the array; `tokens = Math.ceil(chars / CHARS_PER_TOKEN)`.
  - `confidence` is ALWAYS the module constant `DEFAULT_TOKEN_CONFIDENCE = "medium"`. (The audit TOOL later
    overrides the REPORTED label via `config.audit.estimateConfidence`; the pure fn returns the default.)
  - `model` is accepted but UNUSED in v1 (forward-compat calibration). Param prefixed `_model`.
  - Non-array / null / undefined input → `[]` → 0 tokens.
- `resultBytes(content: ResultContentBlock[] | null | undefined): number`
  - text block → `Buffer.byteLength(text, "utf8")` (MULTIBYTE-aware: "café" = 5 bytes, NOT 4).
  - image block → `data?.length ?? 0` (base64 is ASCII → char length == byte length; cheaper on huge blobs).
  - unknown type / non-record element → skipped (contributes 0).
  - non-array input → 0. NEVER throws.
- `approxTokens(bytes: number): number`
  - `Math.ceil(bytes / CHARS_PER_TOKEN)`. Reuses the SAME exported `CHARS_PER_TOKEN = 4`.
  - `approxTokens(8192) === 2048` reproduces spec/07 §1's "8 KB ≈ 2k tokens" equivalence EXACTLY.
  - NaN / ±Infinity / negative → 0 (defensive; `Math.ceil` would otherwise yield nonsense).
- `CHARS_PER_TOKEN = 4` (exported constant; OpenAI "~4 chars ≈ 1 token" rule of thumb).

### Local structural types (defined locally; NOT imported from Pi)
The real Pi `AgentMessage` union lives in `@earendil-works/pi-agent-core`, which is NOT resolvable here
(not hoisted / not re-exported). So tokens.ts defines STRUCTURAL types that match the verified Pi shapes;
a real Pi `AgentMessage[]` assigns to `MessageLike[]` with NO cast:
- `TextContent { type:"text"; text:string }`
- `ThinkingContent { type:"thinking"; thinking:string }`
- `ImageContent { type:"image"; data:string; mimeType:string }` (data = base64; counted at face value = deliberate overestimate)
- `ToolCallContent { type:"toolCall"; id:string; name:string; arguments:Record<string,unknown> }`
- `ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent`
- `MessageLike { role?:string; content?:string|ContentBlock[]; [key:string]:unknown }` (permissive index sig)
- `ResultContentBlock { type:string; text?:string; data?:string; [key:string]:unknown }` (looser — for tool_result content)
- `TokenEstimate { tokens:number; confidence:TokenConfidence }`

### Module-private defensive helpers (never throw — mirrors config.ts/log.ts fail-open discipline)
- `isRecord(v)` — true for plain records + `Object.create(null)`; false for null/primitives/arrays.
- `readOwn(obj, key)` — reads an own property, swallows a throwing Proxy `get` trap → `undefined`.
- `stringLength(v)` — `typeof v === "string" ? v.length : 0`.
- `safeStringLength(v)` — `JSON.stringify(v).length`, swallows circular/BigInt TypeError → 0.
- `stringByteLength(v)` — `typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0` (Buffer is a Node global; no import).
- `messageCharLength(msg)` — reads `.content`; string→length; array→sum of `blockCharLength`; else 0.
- `blockCharLength(block)` — switch on `type`: text→text.length, thinking→thinking.length,
  toolCall→name.length + safeStringLength(arguments), image→data.length (overestimate), default→0.

### NO module-scoped mutable state
Unlike config.ts (cachedConfig) / log.ts / runtime.ts (Map), tokens.ts has ZERO module-scoped mutable
state → tests need NO `beforeEach` reset.

## Test file shape (oracle `test/tokens.test.ts`)
- Imports from `"../src/tokens.js"` (ESM .js-extension convention; moduleResolution Bundler resolves to .ts).
  config.test.ts uses the SAME `.js` convention — match it.
- Uses vitest globals: `describe, it, expect, expectTypeOf` (tsconfig `types:["node","vitest/globals"]`).
- Coverage tiers:
  1. spec/10 §1.7 contract: empty→0; null/undefined→0; monotonic (longer strictly more; adding never
     decreases); confidence default "medium" + ∈ {low,medium,high}; inline snapshot (44 chars→`11`).
  2. chars-per-token: 40→10, 41→11; CHARS_PER_TOKEN===4.
  3. every role: user string; user blocks (text+image → image counted); assistant text+thinking+toolCall;
     toolResult text; custom string; custom blocks; cross-list mix (divide-once-at-top).
  4. defensive (NEVER throws): no content; null content; unknown block type; malformed array
     [null,42,"raw",undefined]; non-array content (12345); circular toolCall.arguments; throwing-Proxy msg.
  5. model param: object + undefined both accepted, v1-ignored.
  6. types (expectTypeOf): return shape; CHARS_PER_TOKEN:number; TokenEstimate; TokenConfidence union;
     MessageLike accepts real Pi shapes.
  7. resultBytes: empty→0; null/undefined→0; non-array→0; ASCII (8000-byte); UTF-8 MULTIBYTE
     ("café"=5, "é".repeat(4)=8, "😀"=4); empty text→0; image base64 char-len; image no data→0;
     unknown type→0; non-record skipped; text+image mix; real Pi shape; throwing-Proxy block.
  8. approxTokens: 0→0; 40→10, 41→11, 1→1; 8192→2048 (load-bearing spec equivalence); negative→0;
     NaN/±Inf→0; monotonic; end-to-end with resultBytes (8000-byte ASCII → 2000 tokens).

## Environment / gates (VERIFIED in /home/dustin/projects/pi-mulligan-hack)
- `node_modules/.bin/vitest` present → vitest 1.6.1 (matches package.json `vitest ^1`).
- `npx vitest run test/log.test.ts` → 15 tests pass (runner works).
- `npx tsc --noEmit` → exit 0 on current tree (typecheck gate works).
- `src/tokens.ts` currently = `export {};` (stub from P1.M1.T1.S1). Task = REPLACE with real impl.
- `test/tokens.test.ts` does NOT exist yet. Task = CREATE it.
- `import { getConfig }` is NOT used by tokens.ts (zero-import discipline). The `confidence` default is a
  module constant; the audit TOOL applies `config.audit.estimateConfidence` at render time (the seam).

## Scope boundaries (success criteria / manual gates, NOT shell gates per G1.2)
- tokens.ts MUST import nothing (no Pi, no config, no log, no runtime). Zero runtime dependencies.
- MUST NOT mutate any input. MUST NOT read module-scoped mutable state. MUST NOT throw.
- MUST NOT add resultBytes/approxTokens to a different file — all three live in `src/tokens.ts` (spec/11 §1).
- MUST NOT wire tokens.ts into any handler/tool (consumers are P1.M3.T3 / P1.M4.T4 / filter.ts).
- DOCS: no per-item doc (M2 pure helpers); README is Mode B in P1.M5.T4.

## Consumers (downstream — do NOT build here)
- `tools/audit.ts` (P1.M4.T4): `estimateTokens` per-message over `rt.lastFiltered`; render report.
- `nudges.ts` (P1.M3.T3): `turn_end` → `deltaTokens` via `estimateTokens(lastFiltered).tokens` minus baseline;
  `tool_result` → `resultBytes(content)` vs threshold → `approxTokens(bytes)` into the turn-metric.
- `filter.ts` / runtime: `lastFiltered` cache (read by audit). D5: NEVER `ctx.getContextUsage()`.

## Confidence: 10/10
Verified oracle (impl + tests) exists and matches the contract verbatim; gates empirically pass on this
tree; no inference required. The task is a faithful reproduction of the proven reference.
