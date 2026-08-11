# P1.M2.T1.S2 — Extract `mapEntryIdsToMessageIndices` helper (research notes)

> Subtask of **P1.M2.T1** (Pin rewind targets at creation — BUG-002). S1 (data model, `hideEntryIds?: string[]`)
> is **Complete**. **This S2** extracts the PURE entry-id→message-index mapping helper from `resolveCheckpoint`'s
> existing walk and refactors `resolveCheckpoint` to call it (behavior-preserving). S3 (capture in `tools/rewind.ts`)
> and S4 (filterPipeline resolves the pin) consume it later.

## 1. What already exists (verified by reading source — the walk is already there)

`src/transforms.ts:resolveCheckpoint` (line 390) ALREADY contains the exact walk this helper extracts. Its step 4
(lines 423–436) + two module-private helpers:

```ts
// step 3: ctxEntries = branchEntries (root→leaf) filtered to context-producing types
const ctxEntries = branchEntries.filter((e) =>
  isContextProducingType(isRecord(e) ? readOwn(e, "type") : undefined),
);

// step 4: walk ctxEntries with a msgCursor; stop at the target entry → iTarget = its LAST message index
let msgCursor = 0;
let iTarget = -1;
let found = false;
for (const e of ctxEntries) {
  const y = entryMessageYield(e);              // 1 for message/custom_message/branch_summary; -1 for compaction/unknown
  if (y < 0) return null;                       // compaction/unknown on the walked range → indeterminate → REFUSE
  if (msgCursor + y > messages.length) return null;  // alignment lost → REFUSE
  if (isRecord(e) && readOwn(e, "id") === targetId) {
    iTarget = msgCursor + y - 1;                // the entry's LAST message index — KEPT
    found = true;
    break;
  }
  msgCursor += y;
}
if (!found) return null;
```

Module-private helpers (lines 474–483):
```ts
function entryMessageYield(entry: unknown): number {
  const type = isRecord(entry) ? readOwn(entry, "type") : undefined;
  if (type === "message" || type === "custom_message" || type === "branch_summary") return 1;
  return -1; // compaction (indeterminate) OR unknown/non-context-producing → caller refuses
}
function isContextProducingType(type: unknown): boolean {
  return type === "message" || type === "custom_message" || type === "branch_summary" || type === "compaction";
}
```

**Implication:** the helper is a STRAIGHTFORWARD GENERALIZATION of this walk — same `ctxEntries` filter, same
`msgCursor`, same `entryMessageYield`, same two guard checks. The ONLY difference is the *collection policy*:

| | `resolveCheckpoint` (single target) | `mapEntryIdsToMessageIndices` (a SET of ids) |
|---|---|---|
| Match | `entry.id === targetId` (first match wins, `break`) | `idSet.has(entry.id)` (collect EVERY match) |
| On `yield<0` / alignment-lost | `return null` (REFUSE the whole lookup) | **STOP** and return indices collected **so far** (skip the indeterminate entry — never guess, never throw) |
| Return | `{remove:number[]} \| null` | `number[]` (ascending unique) |

This difference is WHY the helper is a NEW function (not resolveCheckpoint with a flag): S4 wants "map as many
pinned ids as you can; skip the ones compaction ate" — the *partial* semantic. resolveCheckpoint keeps its
*refuse-on-indeterminate* semantic (a checkpoint whose mapping is indeterminate must NOT guess). The refactor
below proves resolveCheckpoint can STILL get its refuse-semantic by calling the helper with `[targetId]` and
treating an empty result as "refuse".

## 2. The refactor is PROVABLY behavior-preserving (hand-traced against all 18 existing resolveCheckpoint tests)

Call site replacement (resolveCheckpoint step 4):
```ts
// 4) Map the checkpoint targetId → its message index via the shared helper (P1.M2.T1.S2).
const mapped = mapEntryIdsToMessageIndices(messages, branchEntries, [targetId]);
if (mapped.length === 0) return null;        // target not found OR indeterminate (compaction/alignment) → refuse
const iTarget = mapped[mapped.length - 1];   // the target's LAST message index — KEPT (yield>1 generalization)
```

For `yield=1` (every mappable type today), `mapped = [msgCursor]`, so `mapped[mapped.length-1] === msgCursor ===
msgCursor + yield - 1 ===` the original `iTarget`. Hand-trace of every existing resolveCheckpoint test
(`test/transforms.test.ts:739-886`):

| Test | Before (iTarget / return) | After (helper) | Same? |
|---|---|---|---|
| basic mapping (target=e2) | iTarget=1 | mapped=[1], iTarget=1 | ✅ |
| keeps checkpoint point (target=e_asst, msgs len 3) | iTarget=1 | mapped=[1], iTarget=1 | ✅ |
| UNIT-SNAP multi-parallel (target=ea) | iTarget=1 | mapped=[1], iTarget=1 | ✅ |
| tail-exclusion own unit (target=e_user) | iTarget=0 | mapped=[0], iTarget=0 | ✅ |
| tail-exclusion note/nudge (target=e_user; custom_message entries) | iTarget=0 | mapped=[0] (custom_message yields 1, walked past target) | ✅ |
| **compaction BEFORE target → null** | return null (yield<0 at e_comp) | walk breaks at e_comp → mapped=[] → return null | ✅ |
| **compaction AFTER target → succeeds** | iTarget=1 (target found, break, never reaches compaction) | mapped=[1] (target collected, THEN walk continues, breaks at compaction) → iTarget=1 | ✅ |
| checkpoint not found | return null (step 2: targetId undefined) | helper not called (return null at step 2) | ✅ |
| targetId labels non-context-producing entry | !found → null | ctxEntries excludes it → walk ends, mapped=[] → null | ✅ |
| nothing after iTarget | iTarget=1, remove=[] | mapped=[1], iTarget=1, remove=[] | ✅ |
| defensive non-array messages/branchEntries/empty name | return null (step 1) | helper not called | ✅ |
| excludeToolCallId absent/empty | only affects remove-set (step 5), not the walk | unchanged | ✅ |
| throwing-Proxy | step-2 label scan: readOwn swallows → targetId undefined → return null | helper not called | ✅ |
| alignment-lost (msgs shorter than ctxEntries, target past end) | return null (msgCursor+y>len) | walk breaks → mapped=[] → null | ✅ |

**Key subtlety (compaction AFTER target):** the helper does NOT `break` on match — it continues walking. So when a
compaction appears AFTER the target, the target is already collected before the walk hits the compaction and
breaks. `mapped=[targetIdx]`. resolveCheckpoint then takes `mapped[mapped.length-1]` = targetIdx = the original
iTarget. **Identical behavior.** (And when the compaction is BEFORE the target, the walk breaks before reaching
the target → mapped=[] → null, matching resolveCheckpoint's refuse.) This is the crux of behavior preservation.

## 3. Placement + export (conventions)

- The helper is PURE + Pi-FREE (0 imports — same invariant as the rest of transforms.ts). It reuses the
  module-private `isContextProducingType`, `entryMessageYield`, `isRecord`, `readOwn` (all already in scope).
- **Export it** (`export function mapEntryIdsToMessageIndices`) — S4 (filterPipeline) and the tests consume it.
- **Placement:** immediately AFTER the `isContextProducingType` helper (src/transforms.ts:481), before the
  APPLY-OPS divider (`// ════... APPLY-OPS ...`). This keeps it in the "entry→message mapping" family beside
  resolveCheckpoint + its two helpers. Function declarations hoist, so resolveCheckpoint (line 390) calling it
  is fine regardless of source order, but placing it after the helpers it reuses reads cleanest.
- Update resolveCheckpoint's step-4 doc-comment (lines 376–385) to say it delegates to
  `mapEntryIdsToMessageIndices` for the target-id→index lookup (the algorithm description stays; add one line
  noting the delegation). Do NOT touch steps 1–3, 4b (UNIT-SNAP), 5 (remove set), or the signature.

## 4. Signature + normalization (entryIds: Set<string> | string[])

```ts
export function mapEntryIdsToMessageIndices(
  messages: MessageLike[],
  branchEntries: BranchEntry[],
  entryIds: Set<string> | string[],
): number[]
```

Normalize `entryIds` defensively:
- `Set` → use as-is (but skip non-string / empty-string members when testing membership — defensive).
- `string[]` (or any array) → build a `Set<string>` from its string members.
- anything else (null/undefined/non-array-non-Set) → empty Set → return `[]`.
- (Throwing-Proxy `entryIds` is not a realistic input — it's caller-built from `marker.hideEntryIds: string[]` —
  but `isRecord`/`readOwn` discipline is still followed where practicable; the membership Set is built via a
  plain `for..of` that does `typeof === "string"` guards.)

Loop body (mirrors resolveCheckpoint step 4 exactly, minus the single-target `break`):
```ts
const idSet = normalizeIdSet(entryIds);            // Set<string>; empty → early return []
if (idSet.size === 0) return [];
const ctxEntries = branchEntries.filter((e) =>
  isContextProducingType(isRecord(e) ? readOwn(e, "type") : undefined),
);
const collected: number[] = [];
let msgCursor = 0;
for (const e of ctxEntries) {
  const y = entryMessageYield(e);
  if (y < 0) break;                                // indeterminate (compaction/unknown) → STOP, keep collected so far
  if (msgCursor + y > messages.length) break;      // alignment lost → STOP
  const id = isRecord(e) ? readOwn(e, "id") : undefined;
  if (typeof id === "string" && idSet.has(id)) {
    for (let k = msgCursor; k < msgCursor + y; k++) collected.push(k);  // range [msgCursor .. msgCursor+y-1]
  }
  msgCursor += y;
}
// ascending + unique (defensive dedupe; collected is already ascending since msgCursor only increases)
return [...new Set(collected)].sort((a, b) => a - b);
```

The range loop `for k in [msgCursor, msgCursor+y)` generalizes to `yield>1` (not possible today — every mappable
type yields 1 — but the contract specifies a *range*, so implement it generally). For `yield=1` it pushes exactly
`msgCursor`.

## 5. Tests (test/transforms.test.ts — implicit TDD)

Add `mapEntryIdsToMessageIndices` to the existing import block (line 4–16, from `"../src/transforms.js"`).
Add a NEW `describe("mapEntryIdsToMessageIndices — spec/06 §6 entry-id→message-index mapping (P1.M2.T1.S2)")`
block. Use the file's existing fixture builders (`entry`, `user`, `asst`, `result`, `labelEntry`). Required cases
(the contract names these four explicitly):

1. **known entry id → its message index:**
   `msgs=[user,asst(c1),result(c1),asstText]`, `branchEntries=[e1(msg),e2(msg),e3(msg),e4(msg)]`,
   `entryIds=["e2"]` → expect `[1]`. Also: `entryIds=["e1","e3"]` → `[0,2]` (multiple ids, ascending);
   `entryIds=new Set(["e2","e3"])` → `[1,2]` (Set input accepted).
2. **compaction present → that id skipped:**
   `msgs=[user,asst(c),result(c)]`, `branchEntries=[e_comp(compaction),e_user(msg),e_asst(msg)]`.
   - `entryIds=["e_comp"]` → `[]` (the compaction's own id is indeterminate → skipped).
   - `entryIds=["e_asst"]` → `[]` (a mappable id AFTER a compaction is skipped — the walk stopped).
   - `entryIds=["e_comp","e_asst"]` → `[]`.
3. **unknown id → not in result:** `entryIds=["no-such-id"]` over a clean branch → `[]`.
4. **empty entryIds → []:** `entryIds=[]` → `[]`; `entryIds=new Set()` → `[]`.

Plus (robustness, mirrors resolveCheckpoint's defensive tests):
- **alignment-lost:** `msgs=[user]` (1 msg) but `branchEntries=[e1(msg),e2(msg),e3(msg)]`; `entryIds=["e2"]`
  → walk: e1(cursor0→1), e2(msgCursor1+1=2>1 → break) → `[]`. And `entryIds=["e1"]` → `[0]` (e1 is mappable
  before alignment breaks).
- **branch_summary / custom_message yield 1:** `branchEntries=[e_bs(branch_summary),e_cm(custom_message)]`,
  `msgs=[user,asstText]`; `entryIds=["e_bs"]` → `[0]`; `entryIds=["e_cm"]` → `[1]`.
- **dedupe / ascending unique:** pass a `Set` built from a duplicate list; result has no duplicates and is ascending.
- **defensive (NEVER throws):** non-array messages → `[]`; non-array branchEntries → `[]`; `entryIds=null/undefined/{}`
  → `[]`; throwing-Proxy branchEntries/messages → does not throw (readOwn swallows; matches resolveCheckpoint E13 test).
- **refactor seam (documents the resolveCheckpoint↔helper relationship for S4):** on a clean fixture, calling
  `mapEntryIdsToMessageIndices(msgs, branch, [targetId])` yields the SAME index resolveCheckpoint uses as iTarget
  (i.e. the helper's `[last]` === resolveCheckpoint's kept point). One focused assertion.
- **type:** `expectTypeOf(mapEntryIdsToMessageIndices([], [], [])).toEqualTypeOf<number[]>()`.

**The regression net for the refactor itself** is the EXISTING 18-test `resolveCheckpoint` describe block
(test/transforms.test.ts:739–886): if the refactor changed observable behavior, those flip red. No new
resolveCheckpoint test is required (the existing ones are the contract); the helper-level tests above cover the
new function's own contract.

## 6. Scope boundaries (what S2 does NOT do)

- **NO filterPipeline change.** `hideEntryIds` is still CARRIED by `RewindMarkerLike` but NOT consumed — that is
  **S4**. The filterPipeline line-756 comment (`NO hideEntryIds/turnHasAdvanced/diag (later fix tasks — CONTRACT
  is granularity dispatch only)`) is STILL ACCURATE in S2; **leave it** (S4 rewrites it). [S1 already established
  this discipline.]
- **NO tools/rewind.ts change** (capturing `hideEntryIds` at creation is **S3**).
- **NO markers.ts / config.ts change** (S1 landed the field; nothing more needed here).
- **NO resolveCheckpoint signature change** — same `(messages, branchEntries, checkpointName, excludeToolCallId?) → {remove:number[]} | null`.
- **NO change to resolveCheckpoint steps 1–3, 4b (UNIT-SNAP), or 5 (remove-set build).** Only step 4 (the walk) is
  replaced by a call to the helper.

## 7. Verified validation gates

| Gate | Command | Verified |
|---|---|---|
| L1 type-check (new export + refactor + all consumers compile) | `npx tsc --noEmit` | ✅ exits 0 on baseline |
| L2 unit (directly affected file: new helper + refactored resolveCheckpoint) | `npx vitest run test/transforms.test.ts` | ✅ baseline file green |
| L3 full suite (regression: pipeline/filter/markers that transitively call resolveCheckpoint) | `npx vitest run` | ✅ baseline 657 passed / 2 skipped |

(No lint/format script in package.json; `npm test` === `vitest run`.) After S2: baseline 657 + the new
helper tests, 0 regressions (the 18 resolveCheckpoint tests stay green = the behavior-preservation proof).

## 8. DOCS impact

S2 touches INLINE code documentation only (the new helper's JSDoc + resolveCheckpoint's updated step-4
doc-comment). No README/spec file is modified. The changeset-level BUG-002 doc
(`design_decisions.md §BUG-002 'Approach (pinned targeting)' step 3 already names `mapEntryIdsToMessageIndices``)
is satisfied by the helper existing. spec/06 §6 (resolveCheckpoint's walk) keeps its semantics verbatim — the
refactor is behavior-preserving, so no spec edit is needed in S2.
