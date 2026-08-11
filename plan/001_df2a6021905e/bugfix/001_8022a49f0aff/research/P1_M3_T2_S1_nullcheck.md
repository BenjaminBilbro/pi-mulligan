# Research — P1.M3.T2.S1: Null-check refusal before leaveNote (BUG-005)

## Work item
- **Task**: P1.M3.T2.S1 (milestone P1.M3 "Branch scoping, persist integrity & audit polish").
- **Bug**: BUG-005 (minor) — `mulligan_rewind` reports success even when the marker failed to persist.
- **Scope**: ONE code insert (3 lines) in `src/tools/rewind.ts` + NEW test cases in `test/tools/rewind.test.ts` + UPDATE one existing test that the fix breaks.

## Root cause (verified by reading the source)

`src/tools/rewind.ts` `rewindExecute` step 7 (lines 463–465):
```ts
const markerId = appendRewindMarker(pi, ctx, payload);
leaveNote(pi, { content: rendered, rewindId: markerId ?? toolCallId });
```

`appendRewindMarker` (`src/markers.ts`) returns `string | null`:
- returns `null` when `pi.appendEntry(...)` THROWS (caught internally → `logError` → `return null`);
- returns `null` when `ctx.sessionManager.getLeafId()` returns `null` (the bare `return ctx.sessionManager.getLeafId()` is the last try-block statement).

The tool NEVER checks `markerId`. So when persist fails:
1. `leaveNote` is called → a STRAY `mulligan:note` CustomMessage is injected into the LLM context for a rewind that did NOT happen (`rewindId = null ?? toolCallId = toolCallId`).
2. The success text `Mulligan: rewound <granularity>. <K> messages will be hidden... Note left.` is returned.

The agent is told the rewind succeeded and K messages will be hidden, but NO marker exists → the `context` filter will hide nothing. This is a silent correctness failure: the agent believes it shed context it is still carrying (BUG-005). `details.markerId` would be `null` but the human-facing text is success.

## The fix (exact, from the task CONTRACT)

Between the two lines above, insert:
```ts
if (markerId === null) {
  return refusal("failed to persist the rewind marker (nothing will be hidden); no changes were made", granularity);
}
```

This MUST come BEFORE `leaveNote` so no stray note is sent. The shared `refusal()` helper (rewind.ts ~line 122) wraps it as:
```
Mulligan: refused — failed to persist the rewind marker (nothing will be hidden); no changes were made.
```
and returns `details: { granularity }` only (no `markerId` — it stays absent on refusal paths by construction).

### Contract refinements (authoritative source = tasks.json context_scope)
- The CONTRACT message text is `failed to persist the rewind marker (nothing will be hidden); no changes were made` (with the `; no changes were made` suffix). design_decisions.md BUG-005 shows a SHORTER variant (`...nothing will be hidden"`) — use the CONTRACT text (more specific).
- Keep the success path (`leaveNote + successText + details with markerId`) UNCHANGED for the non-null case. The `markerId ?? toolCallId` in the `leaveNote` call becomes dead-but-harmless on the success path; do NOT remove it.

## The single test that BREAKS (CRITICAL — must update)

`test/tools/rewind.test.ts` → `describe("mulligan_rewind — leafId null fallback")` → `it("getLeafId returns null → rewindId falls back to toolCallId")` (line ~647):
```ts
const { ctx } = makeCtx({ leafId: null });
const res = await run(pi, ctx, { note: VALID_NOTE, granularity: "last_tool_call_group" }, "my-call-id");
const text = firstText(res);
expect(text).toMatch(/^Mulligan: rewound/);   // ← FAILS after fix (now a refusal)
```
After the fix, `getLeafId() === null` → `appendRewindMarker` returns `null` → the new guard returns a refusal → `text` is `/^Mulligan: refused —/`. This test encodes the OLD (buggy) contract (null → fallback note). It MUST be replaced/updated to assert the NEW contract (null → refusal, no note). This is the single most important gotcha — without updating it, `npm test` will fail after the implementation.

## The existing test that SURVIVES (loose — no edit required, but new test supersedes its intent)

`test/tools/rewind.test.ts` → `describe("mulligan_rewind — never-throws (E13)")` → `it("appendRewindMarker THROWS (pi.appendEntry boom) → returns a text result, NO throw escapes")` (line ~555):
```ts
const { pi } = makePi({ throwOnAppend: true });
// only asserts res.content has length 1 + type "text" + firstText is a string
```
These loose assertions pass under BOTH the old (success) and new (refusal) behavior, so it does not break. The NEW test adds the precise assertions the contract requires (starts with "Mulligan: refused —", `sent` empty, `appended` length exactly 1).

## The NEW test (from CONTRACT)

Add a `describe` block (e.g. `mulligan_rewind — BUG-005: null persist result refusal`) with TWO cases, reusing the existing `makePi`/`makeCtx`/`run`/`firstText`/`VALID_NOTE` fixtures (NO new fakes needed):

**Case A — `appendEntry` throws** (`makePi({ throwOnAppend: true })`):
```ts
const { appended, sent, pi } = makePi({ throwOnAppend: true });
const { ctx } = makeCtx();
const res = await run(pi, ctx, { note: VALID_NOTE, granularity: "last_tool_call_group" });
expect(firstText(res)).toMatch(/^Mulligan: refused — failed to persist the rewind marker/);
expect(sent).toHaveLength(0);                 // pi.sendMessage (the note) NOT called
expect(appended).toHaveLength(1);             // pi.appendEntry attempted EXACTLY once
expect(appended[0].customType).toBe("mulligan:rewind");
expect(res.details).toEqual({ granularity: "last_tool_call_group" }); // markerId absent
```

**Case B — `getLeafId()` returns null** (`makeCtx({ leafId: null })`):
```ts
const { appended, sent, pi } = makePi();
const { ctx } = makeCtx({ leafId: null });
const res = await run(pi, ctx, { note: VALID_NOTE, granularity: "last_tool_call_group" });
expect(firstText(res)).toMatch(/^Mulligan: refused — failed to persist the rewind marker/);
expect(sent).toHaveLength(0);
expect(appended).toHaveLength(1);             // appendEntry WAS attempted (it succeeded, but getLeafId null)
expect(res.details).toEqual({ granularity: "last_tool_call_group" });
```

### Why `appended.toHaveLength(1)` is correct in BOTH cases
- Case A: `makePi({throwOnAppend:true})` pushes BEFORE throwing? NO — the fake pushes AFTER the throw check: `if (opts.throwOnAppend) throw ...; appended.push(...)`. So `appended` would be length **0** in Case A, NOT 1!

  **WAIT — re-verify.** Reading `makePi` (rewind.test.ts lines ~69-76):
  ```ts
  appendEntry(customType: string, data?: unknown) {
    if (opts.throwOnAppend) throw new Error("appendEntry boom");
    appended.push({ customType, data });
  },
  ```
  The throw happens BEFORE the push. So `appended.length === 0` when `throwOnAppend` is true. The CONTRACT says "pi.appendEntry was attempted exactly once" — "attempted" = the CALL was made once (yes: `appendRewindMarker` calls `pi.appendEntry(...)` exactly once before its try/catch swallows the throw). The CALL count is 1 even though the push never happened. So the assertion must distinguish:
  - "appendEntry was CALLED once" → needs a CALL counter, not the `appended` array.
  - The existing `makePi` does NOT expose a call counter — it only exposes the `appended` results array.

  **Resolution:** To assert "attempted exactly once" for Case A (throwOnAppend), either (a) add a lightweight `appendEntryCalls` counter to `makePi`, OR (b) for Case A assert `appended.toHaveLength(0)` (nothing pushed because it threw) PLUS a call counter. The cleanest approach that matches the existing idiom (hand-rolled, no vi.fn()): add an `appendEntryCalls: number` counter to the `makePi` return and increment it at the TOP of `appendEntry` (before the throw). Then assert `pi-fake.appendEntryCalls === 1` in both cases, and:
    - Case A: `appended.toHaveLength(0)` (threw before push) + `appendEntryCalls === 1`.
    - Case B: `appended.toHaveLength(1)` (push succeeded; getLeafId returned null AFTER) + `appendEntryCalls === 1`.

  This precisely matches the contract ("attempted exactly once") and is robust to the throw-before-push ordering. **Recommendation: add `appendEntryCalls` to `makePi`** (one-line counter at the top of `appendEntry`).

## Scope boundaries (sibling tasks — DO NOT collide)

Milestone P1.M3 has 3 siblings. My task touches `rewindExecute` step 7 (~line 464-465) ONLY.

- **P1.M3.T1.S1 (BUG-004) — COMPLETE**: switches `getEntries()`→`getBranch()` in `countRewindMarkers` (~line 210) and `checkpointExists` (~line 247). These are module-local helpers, a DIFFERENT region from step 7. No overlap. (Its test-fake default change `branch ?? entries` is already landed; the new test reuses `makeCtx` which already defaults `branch ?? entries`.)
- **P1.M3.T3.S1 (BUG-008)**: edits `src/tools/audit.ts` `renderAuditReport` Suggestion line. Different file. No overlap.

My edits are confined to: (1) the 3-line insert in `rewindExecute` step 7; (2) `test/tools/rewind.test.ts` (update 1 existing test + add 1 new describe block, possibly extend `makePi` with `appendEntryCalls`). Nothing else.

## Validation (verified working)
- `npx tsc --noEmit -p tsconfig.json` — exits 0 today (strict mode). The insert reuses the existing `refusal(reason, granularity)` helper + `Granularity` type, so NO type change.
- `npx vitest run test/tools/rewind.test.ts` — 35 tests pass today (baseline).
- `npm test` — 691 passed, 2 skipped (1 skipped file) today (baseline).

## DOCS Impact
No Mode A per-item doc. The rewind tool's step-7 inline comment (~line 461 "// (7) persist (step 7)...") should be updated to note the null-check ("refuse on null persist → no stray note"), so the comment does not contradict the new guard. Changeset-level README sync is Mode B (P1.M5.T1, the final doc pass that depends on this task).

## Confidence: 9/10
The change is 3 lines + 1 test update + 1 new describe block (2 cases). The only subtlety is the `appended`-array-vs-call-count distinction in Case A (throw happens before push), resolved by adding an `appendEntryCalls` counter. No type changes, no new files, no API change, no filter/transform logic touched.
