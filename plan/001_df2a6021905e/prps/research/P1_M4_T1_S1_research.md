# Research — P1.M4.T1.S1 — `mulligan_rewind` execute() tool (src/tools/rewind.ts)

## What this task is
Implement `src/tools/rewind.ts` (currently `export {};`) + `test/tools/rewind.test.ts` (NEW). The thin
`execute()` adapter for the flagship tool. Contract = spec/05 §1 behavior steps 1–8 + the work item.

## Deliverable shape (verified)
- `src/tools/rewind.ts`: `RewindParams` (typebox, VERBATIM spec/05 §1), `REWIND_DESC` (VERBATIM spec/05 §5),
  `MUTATION_WARNING` (VERBATIM spec/08 E5), `RewindDetails`, `refusal()`, `successText()`, read-only preview
  helpers (`countRewindMarkers`, `checkpointExists`, `resolvePreview`, `emptyLedger`), `rewindExecute`, and the
  `makeRewindTool(pi)` factory. `pi` captured via closure (NOT an execute arg).
- `test/tools/rewind.test.ts`: vitest, hand-rolled makePi/makeCtx fakes (mirror markers.test.ts), refusal paths
  (disabled/empty-note/checkpoint-missing/maxDepth) + success path + best-effort + never-throws + types.

## Verified Pi surface (the execute contract)
- `execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>` — toolCallId is the
  FIRST arg (becomes `excludeToolCallId` on the marker). `pi` (ExtensionAPI) is NOT an arg → factory closure.
  Source: `dist/core/extensions/types.d.ts:371`.
- `defineTool<TParams,TDetails,TState>(tool)` → `ToolDefinition & AnyToolDefinition` (types.d.ts:385).
- `ToolDefinition<TParams,TDetails,TState>` (types.d.ts:343).
- `AgentToolResult<T>` = `{ content: (TextContent|ImageContent)[]; details: T; usage?; addedToolNames? }` —
  `details` is REQUIRED (no `?`). pi-agent-core `dist/types.d.ts:316-324`. **GOTCHA #4: every return path
  includes `details`.**
- `SessionEntry` union + `sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[]` (session-manager.d.ts:105,151).
- `ReadonlySessionManager` Pick includes `getEntries/getBranch/buildContextEntries/getLeafId/getSessionId/getLabel`.

## v1 behavior steps (work-item contract + spec/05 §1) — the 7(8) steps
1. config gate: master `enabled` FIRST (E14), then `rewind.enabled` → refuse "Mulligan is disabled" / "rewind is disabled".
2. validateNote (notes.ts): all 4 non-empty or refuse NOTE_INVALID_REASON (E9).
3. granularity/target: last_tool_call_group + last_turn always valid; checkpoint MUST exist on branch (E10) —
   scan getEntries() for label `mulligan:checkpoint:<name>`; confirm via getLabel latest-wins (cleared → refuse).
4. DEPTH GUARD (E4): count active `mulligan:rewind` custom entries; `>= config.rewind.maxDepth` (default 5) → refuse
   naming count + suggest mulligan_shrink/continue.
5. COMPOSE LEDGER+NOTE (the ONE read exception, spec/03 §2.1): read-only `resolvePreview` over a SNAPSHOT from
   `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)` → resolvers → extractFileLedger
   + K = remove.length. Best-effort: throw → emptyLedger + K=0 + STILL succeed (E13/E8).
6. PERSIST: `appendRewindMarker(pi, ctx, payload)` → leafId; then `leaveNote(pi, { content: rendered, rewindId: leafId ?? toolCallId })`.
   **seq is bumped INSIDE appendRewindMarker (nextSeq(rt)) — the tool does NOT separately bump.**
7. mutation warning (E5): if `config.rewind.requireMutationWarning && (ledger.modifiedFiles.length>0 || ledger.bashSideEffects.length>0)`
   append MUTATION_WARNING (VERBATIM) to success text.
8. return success text with K (K=0 → "(nothing matched to hide)" honesty).

## CRITICAL divergences from the sibling oracle (/home/dustin/projects/pi-mulligan, EVOLVED P4)
The oracle is the proven STRUCTURAL reference but contains P4 features OUT OF SCOPE for v1. Copy structure, OMIT:
1. **OMIT all P4 features**: `maxRetriesPerPrompt` / `abortContextFraction` guards (4b/4c); `rewindRefusedTurnIndex`
   latch; `hideEntryIds` + `captureHideEntryIds`; checkpoint auto-consumption (step 7b); `computeFilteredTotal`
   import from `./audit.js`; `readMarkers` import from `../filter.js`; `getRuntime` import from `../runtime.js`.
   This v1 task imports NEITHER runtime.js NOR filter.js NOR audit.js.
2. **leaveNote is OBJECT-arg in THIS repo**: `leaveNote(pi, { content, rewindId })` (LeaveNoteInput).
   The oracle calls positional `leaveNote(pi, rendered, markerId ?? toolCallId)` — DO NOT copy that; this repo's
   markers.ts (P1.M3.T1.S1, shipped) takes the object form. Same divergence class as noted in P1.M3.T1.S1 PRP.
3. **NO cast needed for `checkpoint`**: THIS repo's `RewindMarker`/`RewindMarkerInput` (markers.ts) ALREADY has
   `checkpoint?: string` (spec/05/§06 widening). The oracle needed `as RewindMarkerInput` because its frozen type
   omitted it (oracle GOTCHA #1) — HERE the type already includes it, so the payload is assignable WITHOUT a cast.
4. **appendRewindMarker returns the LEAF ENTRY id (string|null)**, not the marker uuid. `rewindId` for the note =
   that leaf id (P1.M3.T1.S1 integration contract: `leaveNote(pi,{content,rewindId:leafId})`); fallback `toolCallId`
   if null. The marker's own uuid (`id`) is generated internally by the wrapper and not exposed.

## Resolver signatures (THIS repo, transforms.ts — VERIFIED)
- `partitionIntoUnits(messages: MessageLike[] | null | undefined): Unit[]` (line 109)
- `resolveLastToolCallGroup(units: Unit[], messages: MessageLike[], excludeToolCallId?: string): number[] | null` (204)
- `resolveLastTurn(messages, opts: {to_previous_prompt?} | undefined, excludeToolCallId?: string): { remove: number[] }` (284)
- `resolveCheckpoint(messages, branchEntries: BranchEntry[], checkpointName: string, excludeToolCallId?: string): { remove: number[] } | null` (390)
  — branchEntries is DATA from `ctx.sessionManager.getBranch()` (root→leaf), NOT ctx.
- `Unit { indices: number[]; kind: "plain" | "toolGroup" }`; `MessageLike { role?, content?, [key]: unknown }`.
- `MessageLike`↔Pi `AgentMessage` boundary needs `as unknown as MessageLike[]` cast (the established filter.ts idiom;
  oracle resolvePreview does the same — runtime-identical, TS-narrower-index-signature quirk).

## Imports for v1 src/tools/rewind.ts
- typebox: `{ Type }`, `type { Static }`
- @earendil-works/pi-coding-agent: `{ defineTool, sessionEntryToContextMessages }`, `type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition, SessionEntry }`
- ../markers.js: `{ appendRewindMarker, leaveNote }`, `type { RewindMarkerInput }`
- ../notes.js: `{ validateNote, renderNote, NOTE_INVALID_REASON }`, `type { NoteInput }`
- ../ledger.js: `{ extractFileLedger }`, `type { FileLedger }`
- ../config.js: `{ getConfig }`, `type { Granularity }`
- ../transforms.js: `{ partitionIntoUnits, resolveLastToolCallGroup, resolveLastTurn, resolveCheckpoint }`, `type { BranchEntry, MessageLike }`
- ALL src→src imports use `.js` extension (GOTCHA #13).

## Baseline today (VERIFIED green)
- `npx tsc --noEmit` exit 0.
- `npx vitest run` = 480 tests / 14 files all green.
- `pi -e ./src/index.ts -p hi` loads (index.ts is the no-op factory; wiring is P1.M7.T1.S1).
- `test/tools/` directory does NOT exist yet → CREATE it for test/tools/rewind.test.ts.

## Test structure (adapt oracle test/tools/rewind.test.ts, MINUS P4)
- Imports from `../../src/tools/rewind.js`: makeRewindTool, RewindParams, REWIND_DESC, type RewindArgs, RewindDetails.
- makePi({throwOnAppend/throwOnSendMessage/throwOnSetLabel}) → {appended, sent, labels, pi}.
- makeCtx({sessionId?, leafId?, entries?, branch?}) → {ctx} scripting getEntries/getBranch/buildContextEntries/getLeafId.
  buildContextEntries must return SessionEntry[]; getBranch must return BranchEntry[] (root→leaf).
- beforeEach/afterEach: clearAll() (runtime map) + setConfig(undefined) (reset config cache to defaults).
- Cases: (a) registration metadata (name/label/description/parameters); (b) 4 refusal paths (disabled master,
  rewind.enabled false, empty note, checkpoint-missing, maxDepth); (c) success payload exactness (granularity,
  options{to_previous_prompt,protect}, excludeToolCallId===toolCallId, note, ledger, checkpoint); (d) K=0 honesty,
  mutation warning VERBATIM, best-effort ledger (snapshot throw → empty+K=0+success); (e) never-throws (throwing
  appendEntry/sendMessage → text result, no throw); (f) result shape (details on every path); (g) types.
