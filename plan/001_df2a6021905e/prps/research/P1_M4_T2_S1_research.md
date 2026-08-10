# Research — P1.M4.T2.S1 — `mulligan_shrink` execute() tool (src/tools/shrink.ts)

## What this task is
Implement `src/tools/shrink.ts` (currently `export {};`) + `test/tools/shrink.test.ts` (NEW). The thin
`execute()` adapter for the second Mulligan tool — retroactive content substitution. Contract = spec/05 §2
behavior steps 1–5 + the work-item CONTRACT DEFINITION.

## Deliverable shape (verified)
- `src/tools/shrink.ts`: `ShrinkParams` (typebox, VERBATIM spec/05 §2), `SHRINK_DESC` (VERBATIM spec/05 §5),
  `ShrinkDetails`, `refusal()`, `feedbackText()` (spec/05 §2 VERBATIM success text), module-private
  `isNonEmpty()` + `targetIsStructurallyValid()` + `bestEffortMatch()` (the read-only match-now), `shrinkExecute`,
  and the `makeShrinkTool(pi)` factory. `pi` captured via closure (NOT an execute arg).
- `test/tools/shrink.test.ts`: vitest, hand-rolled makePi/makeCtx fakes (mirror test/tools/rewind.test.ts +
  test/markers.test.ts), refusal paths (disabled/empty-replacement/structurally-impossible-target) + success path
  + match-now feedback (yes + no) + best-effort (snapshot throw → matched:false + still persists) + never-throws
  + result-shape (details on EVERY path) + types.

## Verified Pi surface (the execute contract)
- `execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>` — toolCallId is the
  FIRST arg. For shrink it is UNUSED (the target is explicit; named `_toolCallId`). `pi` (ExtensionAPI) is NOT
  an arg → factory closure. Source: `dist/core/extensions/types.d.ts:371`.
- `defineTool<TParams,TDetails,TState>(tool)` → `ToolDefinition & AnyToolDefinition` (types.d.ts:385).
- `ToolDefinition<TParams,TDetails,TState>` (types.d.ts:343).
- `AgentToolResult<T>` = `{ content:(TextContent|ImageContent)[]; details:T; usage?; addedToolNames? }` —
  `details` is REQUIRED (no `?`). pi-agent-core `dist/types.d.ts:316`. **GOTCHA #4: every return path includes `details`.**
- `SessionEntry` union + `sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[]` (session-manager.d.ts:105,151).
- `ReadonlySessionManager` Pick includes `getEntries/getBranch/buildContextEntries/getLeafId/getSessionId/getLabel`.

## Dependencies (all VERIFIED shipped + green in THIS repo)
- **P1.M3.T1.S1 ✅ markers.ts** — `appendShrinkMarker(pi, ctx, data: ShrinkMarkerInput): string|null` (stamps
  {schema:"pi-mulligan",v:1,kind:"shrink",id:randomUUID(),seq:nextSeq(rt),ts}; appendEntry("mulligan:shrink",…);
  returns getLeafId() IMMEDIATELY — C7; try/catch+logError→null). `ShrinkMarkerInput = Omit<ShrinkMarker,
  "schema"|"v"|"kind"|"id"|"seq"|"ts">` = **EXACTLY `{ target, replacement, reason? }`** — NO `pinnedEntryId`
  field (P1.M3.T1 research §3 explicitly OMITs it). NO `leaveNote` for shrink (shrink leaves NO note).
  Tested: test/markers.test.ts:229 (appendShrinkMarker describe block).
- **P1.M2.T6.S1 ✅ transforms.ts** — `resolveShrinkTarget(messages: MessageLike[], target: ShrinkTarget): number|null`
  (PURE; 3 matchers; by_tool_call_id→first toolResult w/ that toolCallId; by_tool_name+occurrence(last|first);
  by_content_includes→first message ANY role whose stringified content includes substring; non-record/no
  discriminator→null; NEVER throws). `applyShrink(messages, marker:{target,replacement})` = 2-param LIVE-only
  (NO pinnedEntryId/branchEntries — CONTRACT). Exports: `ShrinkTarget`, `MessageLike`.
  **NOTE**: `isRecord`/`readOwn` are MODULE-PRIVATE in transforms.ts — the tool reads `params.target` itself.
- **P1.M1.T2.S1 ✅ config.ts** — `getConfig(): MulliganConfig` (defensive structuredClone each call). `config.shrink`
  = **`{ enabled: boolean }` ONLY** (default true) — NO `notifyMaxChars`, NO `autoOnBloat`. Master `config.enabled`
  default true. `setConfig(undefined)` resets cache to defaults (for test afterEach).

## v1 behavior steps (work-item contract + spec/05 §2) — the 5 steps
1. **config gate** (step 1; E14): `getConfig()` ONCE. Master `enabled` FIRST (E14 master-disable → "Mulligan is
   disabled"), then `shrink.enabled` (→ "shrink is disabled").
2. **replacement non-empty** (step 2): empty/whitespace-only after trim → refuse "replacement must be non-empty".
3. **structural target validity** (step 3 — the "structurally impossible" refusal; the ONE design judgment):
   the present discriminator (by_tool_call_id / by_tool_name / by_content_includes — whichever key is present)
   must be non-empty after trim, else refuse "target discriminator must be non-empty". Verified reasoning against
   resolveShrinkTarget internals: by_tool_call_id:""/by_tool_name:"" → skipped (length>0 guard) → null forever;
   by_content_includes:"" → NO length guard → degenerate match on FIRST message (every string includes "") → noise.
   Both refuse. A NON-EMPTY-but-currently-unmatched target is NOT refused (compaction-robust — E8).
4. **best-effort match-now** (step 3 — the yes/no feedback; ADVISORY, never blocks): build SNAPSHOT via
   `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)` (NOT event.messages — tool
   is write-only), call `resolveShrinkTarget(messages, target)`, `matched = (i !== null)`. try/catch → matched=false
   + STILL persists (E13/E8 — never let an advisory computation block a legitimate shrink).
5. **persist** (step 4): `appendShrinkMarker(pi, ctx, { target: params.target, replacement: params.replacement,
   reason: params.reason })` → markerId (leaf ENTRY id, or null). NO cast (ShrinkMarkerInput matches EXACTLY),
   NO pinnedEntryId, NO leaveNote.
6. **return** (step 5): spec/05 §2 VERBATIM success text `Mulligan: shrink recorded. Matched message will show
   the replacement from the next turn on. (Matched now: yes|no)` (substitute the actual matched value) +
   `details: { matched, markerId }`.

Whole `execute` body = ONE try/catch → refusal text on ANY exception (E13 — never throws).

## CRITICAL divergences from the sibling oracle (/home/dustin/projects/pi-mulligan/src/tools/shrink.ts — EVOLVED)
The oracle is the proven STRUCTURAL reference (ShrinkParams/SHRINK_DESC VERBATIM; refusal()/makeShrinkTool(pi)
factory; best-effort snapshot→resolveShrinkTarget; never-throws; details-on-every-path) but contains features
OUT OF SCOPE for v1. Copy STRUCTURE, OMIT:
1. **OMIT `pinnedEntryId` + `entryIdAtMessageIndex` + `resolveTargetEntryId`** (entry-id pinning — FINDING 3
   moving-target fix). v1 match-now returns a BOOLEAN (`matched = i !== null`), NOT a captured entry id. This
   repo's `ShrinkMarker`/`ShrinkMarkerInput` (markers.ts) has NO `pinnedEntryId` field, and `applyShrink`
   (transforms.ts) is the 2-param LIVE-only version (no pinning). Do NOT pass `pinnedEntryId` to appendShrinkMarker.
2. **OMIT the `ctx.ui.notify` operator echo (oracle step 5b) + `cap()` + `describeTarget()` + `config.shrink.notifyMaxChars`**.
   This repo's `config.shrink` = `{ enabled }` ONLY (no notifyMaxChars). The success text is the ONLY feedback.
3. **Success text = spec/05 §2 VERBATIM** (`Mulligan: shrink recorded. Matched message will show the replacement
   from the next turn on. (Matched now: yes|no)`), NOT the oracle's terse `Mulligan: shrink recorded. Matched:
   yes|no.` (the oracle cites a later sprint "P1.M2.T1.S2" for the terse form — that task does NOT exist in THIS
   repo's plan; spec/05 §2 is the contract). DO NOT copy the oracle's `feedbackText`.

## Resolver + marker API (THIS repo, VERIFIED)
- `resolveShrinkTarget(messages: MessageLike[], target: ShrinkTarget): number | null` (transforms.ts).
- `ShrinkTarget = |{by_tool_call_id:string} |{by_tool_name:string, occurrence:"last"|"first"} |{by_content_includes:string}`
  (transforms.ts; structurally identical to markers.ts ShrinkTarget — type-only import is acyclic).
- `MessageLike { role?, content?: string|ContentBlock[], [key]:unknown }` (transforms.ts).
- `appendShrinkMarker(pi, ctx, data: ShrinkMarkerInput): string | null` (markers.ts).
- `ShrinkMarkerInput = { target: ShrinkTarget; replacement: string; reason?: string }` (markers.ts).
- `MessageLike`↔Pi `AgentMessage` boundary: `entries.flatMap(sessionEntryToContextMessages) as unknown as MessageLike[]`
  cast (the established filter.ts/rewind.ts idiom — runtime-identical, TS-narrower-index-signature quirk).

## Imports for v1 src/tools/shrink.ts
- typebox: `{ Type }`, `type { Static }`.
- @earendil-works/pi-coding-agent: `{ defineTool, sessionEntryToContextMessages }`,
  `type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition, SessionEntry }`.
- ../markers.js: `{ appendShrinkMarker }`, `type { ShrinkMarkerInput }`.
- ../transforms.js: `{ resolveShrinkTarget }`, `type { ShrinkTarget, MessageLike }`.
- ../config.js: `{ getConfig }`.
- ALL src→src imports use `.js` extension (ESM/Bundler resolution — GOTCHA #9).
- This v1 task imports NEITHER runtime.js NOR filter.js NOR notes.js NOR ledger.js NOR audit.js.

## Baseline today (VERIFIED green)
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 509 tests / 15 files all green.
- `pi -e ./src/index.ts -p hi` loads (index.ts is the no-op factory; wiring is P1.M7.T1.S1).
- `src/tools/shrink.ts` is currently `export {};` (stub) — REPLACE it.
- `test/tools/shrink.test.ts` does NOT exist → CREATE it (test/tools/ dir EXISTS — rewind.test.ts is there).
- filter.ts (src/filter.ts) ALREADY reads `mulligan:shrink` markers (readMarkers buckets shrinks[]; filterPipeline
  applies them after rewinds) — so the end-to-end F-shrink-persist path works once the tool is WIRED (P1.M7.T1.S1).
  index.ts does NOT register shrink yet (wiring is a later task).

## Test structure (adapt oracle test/tools/shrink.test.ts + mirror test/tools/rewind.test.ts, MINUS evolved features)
- vitest imports: `{describe,it,expect,expectTypeOf,beforeEach,afterEach}` from "vitest".
- Subject imports from "../../src/tools/shrink.js": `makeShrinkTool, ShrinkParams, SHRINK_DESC,
  type ShrinkArgs, ShrinkDetails`.
- `{clearAll}` from "../../src/runtime.js"; `{setConfig}` from "../../src/config.js".
- type {AgentToolResult,ExtensionAPI,ExtensionContext,ToolDefinition} from "@earendil-works/pi-coding-agent".
- beforeEach/afterEach: `clearAll()` (runtime seq map) + `setConfig(undefined)` (config cache → defaults).
- makePi({throwOnAppend?}) → {appended:[{customType,data}], pi} hand-rolled (NO vi.fn). (No sendMessage for shrink.)
- makeCtx({sessionId?, leafId?, contextEntries?, throwOnBuildContext?}) → {ctx} scripting getSessionId/getLeafId/
  buildContextEntries. buildContextEntries returns SessionEntry[] (use msgEntry/result builders so
  sessionEntryToContextMessages flattens them into toolResult messages with toolCallId/toolName).
- run(pi,ctx,params) helper; firstText(res) helper; entry builders msgEntry/asst/result.
- Cases: (a) registration metadata (name==="mulligan_shrink", label, description===SHRINK_DESC, parameters===ShrinkParams);
  (b) refusal paths — master disabled, shrink.enabled false, empty replacement, whitespace-only replacement,
  structurally-impossible target (by_tool_call_id:"", by_tool_name:"", by_content_includes:"" all refuse);
  (c) success — non-empty target that matches → matched:true + marker persisted with exact {target,replacement,reason}
  + NO pinnedEntryId field + customType "mulligan:shrink" + schema/v/kind/id/seq/ts stamped;
  (d) match-now feedback — matched target → text "(Matched now: yes)"; non-matching-but-valid target → matched:false
  + text "(Matched now: no)" + STILL persists (advisory, E8); spec/05 §2 VERBATIM text (NOT oracle terse);
  (e) best-effort — buildContextEntries throws → matched:false + still persists + success text (E13);
  (f) never-throws — throwing appendEntry → refusal text, no throw;
  (g) result shape — details on EVERY path (GOTCHA #4); refusal details = {} (empty but present);
  (h) types — expectTypeOf(makeShrinkTool(fakePi)).toExtend(ToolDefinition<…>) / returns
  ToolDefinition<typeof ShrinkParams, ShrinkDetails>; execute returns Promise<AgentToolResult<ShrinkDetails>>.
- Structural-validity test MUST assert: by_tool_call_id:"" / "   " refuse; by_tool_name:"" refuses; by_content_includes:"" refuses;
  a valid non-empty target that does NOT match currently → does NOT refuse (persists with matched:false).

## DOCS impact (Mode A)
Tool description = spec/05 §5 SHRINK_DESC VERBATIM (the clear shrink-vs-rewind guidance — "Use when the call was
fine but its output is too big to keep carrying. Unlike rewind, the call stays in context."). This is load-bearing
LLM-facing docs (Mode A); copy verbatim, do not rephrase.
