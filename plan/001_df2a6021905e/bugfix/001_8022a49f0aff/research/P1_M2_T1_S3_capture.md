# P1.M2.T1.S3 — Capture `hideEntryIds` at rewind creation (research notes)

> Subtask of **P1.M2.T1** (Pin rewind targets at creation — BUG-002). S1 (data model, `hideEntryIds?: string[]`
> on `RewindMarker` + `RewindMarkerLike`) is **Complete**. S2 (`mapEntryIdsToMessageIndices` PURE helper in
> `transforms.ts`) is **Complete**. **This S3** is the CAPTURE side: in `tools/rewind.ts:resolvePreview`, map the
> resolved `remove` message-index set back to source `SessionEntry.id`s and store them as `hideEntryIds` on the
> persisted `RewindMarkerInput` payload. S4 (filterPipeline resolves the pin) is the CONSUMER (Planned).

## 1. What already exists (verified by reading source)

### 1a. The `hideEntryIds` field is already on the persisted payload (S1 — shipped)
`src/markers.ts`:
- `RewindMarker` (line ~58) has `hideEntryIds?: string[]` with doc: "Optional pinned target — the SessionEntry
  ids this rewind resolved to hide at creation time. Populated by the capture step (tools/rewind.ts), consumed by
  filterPipeline resolution. Absent → live resolution (backward compat). Marker DATA, not config."
- `RewindMarkerInput = Omit<RewindMarker, "schema"|"v"|"kind"|"id"|"seq"|"ts">` → `hideEntryIds` IS assignable
  on the input the tool builds. **NO markers.ts change needed.**
- `appendRewindMarker(pi, ctx, data)` spreads `...data` into the persisted entry → setting `hideEntryIds` on the
  input persists it verbatim. **NO wrapper change needed.**

`src/transforms.ts`:
- `RewindMarkerLike` (line ~696) has `hideEntryIds?: string[]` — the slice `filterPipeline` will READ in S4.
- `mapEntryIdsToMessageIndices(messages, branchEntries, entryIds)` (line 500, S2 — shipped) is the PURE helper
  S4 will use to resolve the pin. **S3 does NOT call it** (capture builds the inverse map: index→entryId), but the
  COHERENCE contract is that S3's index→entryId map must be the exact inverse of what S4's
  `mapEntryIdsToMessageIndices` resolves. See §3.

### 1b. The current `resolvePreview` (src/tools/rewind.ts, line ~232)
```ts
function resolvePreview(ctx, params, toolCallId): { ledger: FileLedger; k: number } {
  const entries = ctx.sessionManager.buildContextEntries();           // ← MUST change to getBranch()
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e)) as unknown as MessageLike[];
  let remove: number[];
  if (params.granularity === "last_tool_call_group") {
    const units = partitionIntoUnits(messages);
    remove = resolveLastToolCallGroup(units, messages, toolCallId) ?? [];
  } else if (params.granularity === "last_turn") {
    remove = resolveLastTurn(messages, { to_previous_prompt: params.to_previous_prompt }, toolCallId).remove;
  } else {
    const branchEntries = ctx.sessionManager.getBranch() as BranchEntry[];   // checkpoint ALREADY uses getBranch
    remove = resolveCheckpoint(messages, branchEntries, params.checkpoint ?? "", toolCallId)?.remove ?? [];
  }
  const ledger = extractFileLedger(messages, remove);
  return { ledger, k: remove.length };
}
```
- CALLER (rewindExecute step 5) wraps resolvePreview in try/catch → `{ ledger: emptyLedger(), k: 0 }` on throw.
- resolvePreview is MODULE-LOCAL (not exported). Return shape change is internal.
- The caller already destructures `({ ledger, k } = resolvePreview(...))`.

### 1c. The filter's branchEntries source (src/filter.ts:contextHandler, line ~194)
```ts
const branchEntries = ctx.sessionManager.getBranch().slice().reverse() as unknown as BranchEntry[];
const messages = filterPipeline(event.messages ..., markers, config, branchEntries);
```
**THIS IS THE COHERENCE ANCHOR.** The filter passes `getBranch().slice().reverse()` (ROOT→LEAF) to filterPipeline.
S4 will call `mapEntryIdsToMessageIndices(event.messages, branchEntries, hideEntryIds)` with that same
root→leaf list. For S3's pin to be resolvable, S3 must build its `messages` + `indexToEntryId` from the SAME
`getBranch().slice().reverse()` source — NOT `buildContextEntries()` (which is compaction-aware and a different
projection). This is the single most important change in this task.

## 2. Why `buildContextEntries()` ≠ `getBranch()` for coherence (the load-bearing detail)

- `buildContextEntries()` returns the ACTIVE, compaction-aware entry list: pre-compaction entries are REPLACED by
  the compaction summary + the retained tail. Its length and membership DIVERGE from the raw branch once any
  compaction has run.
- `getBranch()` returns the RAW leaf→root entry list (every entry on the path, including pre-compaction messages,
  compaction entries themselves, labels, etc.). `.slice().reverse()` → root→leaf.
- The filter uses `getBranch()` (NOT buildContextEntries). If S3 built the preview from `buildContextEntries()`,
  the `indexToEntryId[i]` positions would NOT match the msgCursor walk `mapEntryIdsToMessageIndices` performs on
  the raw branch → the pin would resolve to WRONG messages in S4. **Hence the task's hard requirement: switch the
  preview message-list source to `getBranch().slice().reverse()`.**

In the NO-COMPACTION case (the common case + every unit-test fixture), both projections yield the same context-
producing entries in the same order, so the indices align perfectly. In the WITH-COMPACTION case,
`mapEntryIdsToMessageIndices` itself STOPS (returns collected-so-far) at the first compaction entry
(`entryMessageYield(compaction) === -1`), so any entry id pinned at/after compaction simply fails to resolve in S4
→ S4 falls back to live resolution. That is the safe, designed behavior; S3 does not need to special-case it.

## 3. The inverse-map contract (S3 capture ↔ S4 resolve)

`mapEntryIdsToMessageIndices` (transforms.ts:500) walks `ctxEntries` (branchEntries filtered to context-producing
types: message / custom_message / branch_summary / compaction) with a `msgCursor`, and for each entry whose `id`
is in the idSet, pushes `[msgCursor .. msgCursor+yield-1]` (yield is 1 for the first three types). So entry `e`
at ctxEntries-position `p` maps to message index `p` (1:1 in the no-compaction case).

`sessionEntryToContextMessages(e)` (node_modules .../session-manager.js:166) yields EXACTLY:
- `message` → 1 message
- `custom_message` → 1 message
- `branch_summary` (with `.summary`) → 1 message
- `compaction` → 1 message (the summary)
- everything else (`label`, `custom`, `session`, ...) → 0 messages

So if S3 builds `messages` via `branch.flatMap(sessionEntryToContextMessages)` and pushes
`entry.id` once per yielded message, then `indexToEntryId[i]` === the id of the ctxEntry at position `i` ===
exactly what `mapEntryIdsToMessageIndices` resolves. **The inverse holds by construction** (same source, same
1:1 projection, same ordering). This is why the task says "build messages + indexToEntryId from getBranch() via
sessionEntryToContextMessages" — it guarantees the inverse-map coherence for free.

NOTE on `compaction`: `sessionEntryToContextMessages(compactionEntry)` yields 1 message, but
`mapEntryIdsToMessageIndices` treats compaction as `yield === -1` (STOP). So a compaction entry id CAN appear in
`indexToEntryId` (and thus in `hideEntryIds` if its message is in `remove`), but S4 will not resolve it (stops at
compaction). This is harmless: S4 falls back to live resolution for that rewind. S3 does not need to filter
compaction out — the `.filter((id): id is string => typeof id === "string" && id.length > 0)` guard in the task
is the only filter needed (it drops non-string ids from throwing-Proxy entries / entries without a string id).

## 4. The exact change to `resolvePreview`

```ts
function resolvePreview(ctx, params, toolCallId): { ledger: FileLedger; k: number; hideEntryIds: string[] } {
  // SOURCE CHANGE: getBranch().slice().reverse() (ROOT→LEAF) — SAME source the filter passes to filterPipeline,
  // so the index→entryId map is the exact inverse of mapEntryIdsToMessageIndices (coherence with S4).
  const branch = ctx.sessionManager.getBranch() as BranchEntry[];
  const branchRootToLeaf = Array.isArray(branch) ? branch.slice().reverse() : [];

  const messages: MessageLike[] = [];
  const indexToEntryId: string[] = [];
  for (const e of branchRootToLeaf) {
    const id = (e && typeof (e as BranchEntry).id === "string") ? (e as BranchEntry).id : "";
    const yielded = sessionEntryToContextMessages(e);   // 0 or 1 message per entry (see §3)
    for (const _msg of yielded) {
      messages.push(_msg as unknown as MessageLike);
      indexToEntryId.push(id);                           // same index as the message — the inverse map
    }
  }

  // granularity dispatch UNCHANGED (resolveLastToolCallGroup / resolveLastTurn / resolveCheckpoint)
  let remove: number[];
  if (params.granularity === "last_tool_call_group") { ... }
  else if (params.granularity === "last_turn") { ... }
  else {
    // checkpoint: resolveCheckpoint takes branchEntries DATA root→leaf — reuse branchRootToLeaf
    remove = resolveCheckpoint(messages, branchRootToLeaf, params.checkpoint ?? "", toolCallId)?.remove ?? [];
  }

  const ledger = extractFileLedger(messages, remove);
  const hideEntryIds = remove
    .map((i) => indexToEntryId[i])
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return { ledger, k: remove.length, hideEntryIds };
}
```

Key points:
- The checkpoint branch already calls `ctx.sessionManager.getBranch()` separately; unify onto `branchRootToLeaf`
  (one read, DRY). `resolveCheckpoint` expects root→leaf branchEntries — `branchRootToLeaf` is exactly that.
- `indexToEntryId[i]` aligns with `messages[i]` BY CONSTRUCTION (pushed in the same loop). This is the invariant.
- The `.filter(...)` guard drops: (a) non-string ids (entries whose `.id` isn't a string — e.g. a throwing Proxy),
  (b) empty-string ids. It does NOT drop compaction ids (harmless — S4 won't resolve them; see §3).

## 5. The caller change (rewindExecute step 7 — payload construction)

```ts
// step 5: resolvePreview now returns hideEntryIds too
let ledger: FileLedger; let k: number; let hideEntryIds: string[];
try {
  ({ ledger, k, hideEntryIds } = resolvePreview(ctx, params, toolCallId));
} catch {
  ledger = emptyLedger(); k = 0; hideEntryIds = [];   // capture failure → omit (E13/E8)
}

// step 7: payload — set hideEntryIds ONLY when non-empty (omit otherwise → live fallback / backward compat)
const payload: RewindMarkerInput = {
  granularity,
  options: { to_previous_prompt: params.to_previous_prompt, protect: config.rewind.protectedRoles },
  excludeToolCallId: toolCallId,
  note: params.note,
  ledger,
  checkpoint: params.checkpoint,
  ...(hideEntryIds.length > 0 ? { hideEntryIds } : {}),   // conditional spread → omitted when empty
};
```
- The conditional spread `...(arr.length > 0 ? { hideEntryIds } : {})` is the idiomatic way to OMIT an optional
  field (so it is `undefined`, not `[]`, on the persisted marker). S4 treats absent/empty identically (live
  fallback), but omitting keeps the persisted JSON clean and matches the task's "omit otherwise" requirement.
- The OUTER try/catch around resolvePreview is ALREADY present (step 5). Adding `hideEntryIds: []` to the catch
  fallback is the only change there. NEVER let capture failure block the rewind.
- Step 5b (the nuclear-last_turn protected-refusal check) reads `k` — UNCHANGED (k is still returned).

## 6. The "getBranch unavailable on a minimal mock" gotcha (test-fake compatibility)

The task: "If getBranch() is unavailable on a minimal mock (some unit-test fakes), omit hideEntryIds (keeps
existing tool tests green)." Two readings, BOTH must hold:
1. If `ctx.sessionManager.getBranch` is undefined / throws → resolvePreview throws → the caller's try/catch
   catches → `hideEntryIds = []` → omitted. The rewind STILL succeeds (E13/E8). **No code change needed beyond
   §5** (the existing try/catch already covers it).
2. EXISTING TEST FAKES: `test/tools/rewind.test.ts:makeCtx` has a `contextEntries` opt (drives
   `buildContextEntries()`) and a `branch` opt (drives `getBranch()`, default `[]`). The current tests set
   `contextEntries` for the K/ledger assertions. After the source switch (§4), resolvePreview reads `getBranch()`
   → those tests' `branch` defaults to `[]` → messages empty → K=0 → **existing K-assertions BREAK.**

   **RESOLUTION (test maintenance, part of this task):** migrate the existing `makeCtx({ contextEntries: [...] })`
   calls to `makeCtx({ branch: [...] })`. CRITICAL ORDERING: `getBranch()` returns LEAF→ROOT, so provide the
   fixture in LEAF→ROOT order (resolvePreview reverses it to ROOT→LEAF). The `msgEntry(...)` helper already
   produces `{ type:"message", id, message }` — a valid SessionEntry shape that `sessionEntryToContextMessages`
   projects to 1 message. Example migration:
   ```ts
   // BEFORE (root→leaf, via buildContextEntries):
   makeCtx({ contextEntries: [msgEntry(user("hi")), msgEntry(asst("tc-1")), msgEntry(result("tc-1"))] })
   // AFTER (leaf→root, via getBranch; resolvePreview reverses internally):
   makeCtx({ branch: [msgEntry(result("tc-1")), msgEntry(asst("tc-1")), msgEntry(user("hi"))] })
   ```
   The `throwOnBuildContext` opt + its test → rename to `throwOnGetBranch` (makeCtx already supports
   `throwOnGetBranch`? NO — rewind.test.ts's makeCtx does NOT have it; filter.test.ts's does. Add it, or rely on
   the `branch` getter throwing). Simplest: keep a `throwOnGetBranch` opt in rewind.test.ts's makeCtx that makes
   `getBranch()` throw, and assert the tool still succeeds with K=0 + omitted hideEntryIds (E13/E8).

   This migration is REQUIRED for the existing 29 tests to stay green. The `msgEntry` random-id helper still
   works for ledger/K tests; the NEW hideEntryIds test needs STABLE, known ids (use literal `id:` entries).

## 7. The new test (hideEntryIds capture — assert via pi.appendEntry spy)

Per task point 4: "a marker created against a fixture branch carries the expected entry ids on its persisted
payload (assert via a spy on pi.appendEntry)." The existing `makePi()` already captures `appended[]` (a
hand-rolled spy — no vi.fn()). New test:
```ts
it("last_tool_call_group rewind pins hideEntryIds = the resolved toolGroup's entry ids", async () => {
  const { appended, pi } = makePi();
  const callId = "tc-rewind";
  // LEAF→ROOT branch (resolvePreview reverses to root→leaf). Stable ids for the assertion.
  const branch = [
    { type: "message", id: "e-result", message: result("tc-1") },
    { type: "message", id: "e-asst",   message: asst("tc-1") },
    { type: "message", id: "e-user",   message: user("hi") },
  ];
  const { ctx } = makeCtx({ branch });
  const res = await run(pi, ctx, { note: VALID_NOTE, granularity: "last_tool_call_group" }, callId);
  expect(firstText(res)).toMatch(/^Mulligan: rewound/);
  const data = appended[0].data as Record<string, unknown>;
  expect(data.granularity).toBe("last_tool_call_group");
  // resolveLastToolCallGroup(exclude callId) → the tc-1 toolGroup (e-asst + e-result) → 2 messages
  expect(res.details.k).toBe(2);
  expect(Array.isArray(data.hideEntryIds)).toBe(true);
  expect(data.hideEntryIds).toEqual(expect.arrayContaining(["e-asst", "e-result"]));
  expect(data.hideEntryIds).not.toContain("e-user");
});
```
Plus negative tests: (a) empty remove (no toolGroup) → `hideEntryIds` is OMITTED (undefined, not []) on the
payload; (b) getBranch throws → tool still succeeds, hideEntryIds omitted (E13/E8).

## 8. Files touched (scope — surgical)

- `src/tools/rewind.ts` — MODIFY `resolvePreview` (source switch + indexToEntryId + hideEntryIds computation +
  return-shape widening) + MODIFY `rewindExecute` step 5/7 (destructure hideEntryIds; conditional-spread onto
  payload). NO other src changes (markers.ts, transforms.ts, filter.ts are S1/S2/S4 territory).
- `test/tools/rewind.test.ts` — MIGRATE `contextEntries`→`branch` fixtures (§6); ADD `throwOnGetBranch` opt to
  makeCtx; ADD the hideEntryIds-capture test (§7) + negative tests.

NOT in scope (S4 / later): filterPipeline consuming hideEntryIds; the BUG-002 composition regression test
(test/pipeline.test.ts — that is S5).

## 9. Validation commands (verified working in this checkout)

- `npx vitest run test/tools/rewind.test.ts` — the affected unit-test file (baseline: 29 tests GREEN).
- `npx vitest run` — full suite (baseline 635 GREEN; this task must keep it GREEN — the source switch must not
  break filter.ts/transforms.ts/pipeline tests, which it cannot since it only touches tools/rewind.ts).
- `npx tsc --noEmit` — strict typecheck (tsconfig has strict + noImplicitAny). Confirms the conditional-spread
  typechecks against `RewindMarkerInput` (hideEntryIds?: string[]).
