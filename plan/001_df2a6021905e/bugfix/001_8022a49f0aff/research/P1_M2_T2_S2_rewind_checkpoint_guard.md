# Research notes — P1.M2.T2.S2 (rewind tool checkpoint pre-persist guard, BUG-003 tool layer)

## What S1 (the dependency) already shipped
`src/transforms.ts:protectedOk` (lines ~754–806) ALREADY has the `latest:user` branch:
- computes `protectLatestUser = !hasRoles || roles.some(r => r === "latest:user")` (fail-safe default = enforce);
- computes `iLatestUser` (LAST `role:"user"`, no break);
- `if (iLatestUser !== -1 && remove.some(r => r === iLatestUser)) return false;`.
- `filterPipeline` (line ~893) calls `if (!protectedOk(m, remove, config)) continue;` — the FILTER backstop is LIVE.

So S2 is purely the TOOL-layer pre-persist guard (refuse before persisting → no stray marker/note). The filter backstops any tool that forgets; S2 closes the "no stray marker/note" half of spec/06 §8 defense-in-depth.

## Current rewind.ts step-5b (the shape to mirror)
- Lives AFTER the `resolvePreview` try/catch (step 5) and BEFORE `renderNote` (step 6).
- `if (granularity === "last_turn" && params.to_previous_prompt === true && k === 0) return refusal("would cross a protected message (to_previous_prompt would rewind across the first/only user message — the original task)", "last_turn");`
- `refusal(reason, granularity)` → `{ content:[{type:"text", text:`Mulligan: refused — ${reason}.`}], details:{granularity} }`.

## resolvePreview (module-local, src/tools/rewind.ts) — current return
`function resolvePreview(ctx, params, toolCallId): { ledger: FileLedger; k: number; hideEntryIds: string[] }`
- Builds `branchRootToLeaf = ctx.sessionManager.getBranch().slice().reverse()` (ROOT→LEAF — same source/order filter.ts uses).
- Projects each entry via `sessionEntryToContextMessages(e)` into `messages: MessageLike[]` + parallel `indexToEntryId: string[]`.
- Dispatches on granularity → `remove: number[]` (resolveLastToolCallGroup / resolveLastTurn / resolveCheckpoint).
- Returns `{ ledger: extractFileLedger(messages, remove), k: remove.length, hideEntryIds: remove.map(i=>indexToEntryId[i]).filter(...) }`.
- **`remove` and `messages` are LOCAL — NOT currently surfaced.** Must widen the return to expose them for the checkpoint guard.

## resolveCheckpoint behavior (verified by hand-trace + transforms.test.ts fixtures)
- Finds the most-recent `label` entry (scans branchEntries leaf→root) with `label === mulligan:checkpoint:<name>`; targetId = its targetId.
- `mapEntryIdsToMessageIndices` maps targetId → msg index `iTarget` (the entry's LAST msg index — KEPT).
- **UNIT-SNAP (step 4b):** if iTarget is inside a toolGroup unit, `iTarget = Math.max(...unit.indices)` so the whole assistant+results unit is KEPT and remove begins strictly AFTER it.
- `remove` = indices `j > iTarget`, excluding the rewind's own unit (excludeToolCallId) + `mulligan:*` custom messages.
- Returns `{ remove }` or `null` (not found / indeterminate / compaction).

## Empirically verified: sessionEntryToContextMessages(labelEntry) yields []
Run from project dir against the installed `@earendil-works/pi-coding-agent`:
- `{type:"label",...}` → `[]`  (label entries do NOT produce messages → don't shift indices)
- `{type:"message", message:{role:"user",...}}` → `[{role:"user",...}]`
- assistant with toolCall / toolResult → yielded as expected.
⇒ Including a label entry in the test `branch` is safe: it satisfies resolveCheckpoint's label scan WITHOUT advancing the message cursor.

## Test fixture trace (the BUG-003 repro at the tool layer)
Branch passed to makeCtx is LEAF→ROOT (getBranch order); resolvePreview reverses to ROOT→LEAF.
```ts
const branch = [
  { type: "label", id: "lbl-cp", targetId: "e-a1", label: "mulligan:checkpoint:cp" },
  { type: "message", id: "e-u1", message: user("u1 LATEST ask — should be protected") },
  { type: "message", id: "e-r1", message: result("a1") },
  { type: "message", id: "e-a1", message: asst("a1") },     // checkpoint target entry
  { type: "message", id: "e-u0", message: user("u0 original") },
];
```
After reverse (root→leaf): [e-u0, e-a1, e-r1, e-u1, lbl-cp] → messages =
`[user u0(0), asst a1(1), result a1(2), user u1(3)]`. **iLatestUser = 3.**
- checkpointExists: entries has the label + labels Map `getLabel("e-a1")==="mulligan:checkpoint:cp"` → true.
- resolveCheckpoint: targetId "e-a1" → iTarget=1; unit-snap toolGroup[1,2] → iTarget=2; remove = j>2 → [3] (user u1; not rewind's own, not mulligan:*).
- **remove=[3], iLatestUser=3 → remove.includes(3) → REFUSE.** ✓
- Assert: firstText matches `/^Mulligan: refused — would cross a protected message/` + contains "checkpoint rewind would remove the latest user message"; `appended.length===0`; `sent.length===0`; `res.details === { granularity:"checkpoint" }`.

## Positive control (no over-refusal): checkpoint that does NOT cross latest:user
```ts
const branch = [
  { type: "label", id: "lbl-cp", targetId: "e-a1", label: "mulligan:checkpoint:cp" },
  { type: "message", id: "e-r2", message: result("a2") },
  { type: "message", id: "e-a2", message: asst("a2") },
  { type: "message", id: "e-r1", message: result("a1") },
  { type: "message", id: "e-a1", message: asst("a1") },
  { type: "message", id: "e-u0", message: user("only user") },
];
```
messages = [user(0), asst a1(1), result a1(2), asst a2(3), result a2(4)]. iLatestUser=0.
resolveCheckpoint: targetId e-a1 → iTarget=1 → unit-snap toolGroup[1,2] → iTarget=2; remove = j>2 = [3,4] (asst a2, result a2). iLatestUser=0 NOT in [3,4] → guard does NOT fire → SUCCESS, k=2. Assert `firstText` matches `/^Mulligan: rewound checkpoint/` and `appended.length===1`. Proves the guard is narrowly scoped.

## Config-gate control: protectedRoles omits "latest:user"
`setConfig({ rewind: { protectedRoles: ["first:user"] } })` + the BUG-003 repro branch → guard's `config.rewind.protectedRoles.includes("latest:user")` is false → does NOT fire → tool proceeds (the filter layer S1 will then no-op it, but that's not this task's concern). Assert NOT refused (`firstText` matches `/^Mulligan: rewound checkpoint/`). Proves the guard respects the config gate (not hardcoded).

## config.rewind.protectedRoles typing
`getConfig()` returns a validated `MulliganConfig`; `config.rewind.protectedRoles` is always `string[]` (default `["first:user","latest:user"]`, coerced by `coerceProtectedRoles`). So `config.rewind.protectedRoles.includes("latest:user")` is safe (no Array.isArray guard needed; matches step-5b's style which also reads config directly).

## MessageLike role access (no isRecord/readOwn export needed)
`MessageLike` (transforms.ts:53) has `role?: string` + index signature. `isRecord`/`readOwn` are module-private in transforms.ts (NOT exported). `audit.ts` defines its own local `readStr`. For the tool's iLatestUser loop, a defensive inline read suffices (messages come from sessionEntryToContextMessages → well-formed records, but guard against null/non-object for E13):
```ts
const m = messages[i];
if (m && typeof m === "object" && (m as MessageLike).role === "user") iLatestUser = i; // LAST match, no break
```

## Scope boundaries (DO NOT touch)
- src/transforms.ts (protectedOk) — S1, shipped.
- resolveCheckpoint / filterPipeline dispatch — unchanged.
- step-5b (last_turn nuclear) — unchanged; do NOT add a redundant last_turn guard (construction-safe).
- ProtectedConfig / config.ts — unchanged.
- No new files; edits ONLY to src/tools/rewind.ts + test/tools/rewind.test.ts.

## Baseline
`npx vitest run` → **684 passed, 2 skipped** (22 files). GREEN after S1. S2 adds 3 tests → expected 687.

## Validation commands (verified present in package.json)
- `npx tsc --noEmit` (typecheck; tsconfig exists)
- `npx vitest run test/tools/rewind.test.ts` (the affected file)
- `npx vitest run` (full suite — regression proof)
