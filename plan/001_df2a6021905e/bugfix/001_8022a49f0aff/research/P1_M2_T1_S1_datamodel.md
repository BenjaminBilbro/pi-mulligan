# P1.M2.T1.S1 — Data model: add `hideEntryIds?: string[]` (research notes)

> Subtask of **P1.M2.T1** (Pin rewind targets at creation — BUG-002). This is the **types + docs only**
> foundation; S3 (capture in `tools/rewind.ts`) and S4 (resolve in `filterPipeline`) are separate subtasks.

## 1. Precise current state (verified by reading source — NOT by trusting the work-item prose)

The work-item's RESEARCH NOTE #1 and `system_context.md:49` claim *both* `markers.ts:RewindMarker` AND
`transforms.ts:RewindMarkerLike` "currently carry the comment 'NO hideEntryIds — that's a later fix task'".
**This is only half-true.** Verified state:

| Location | Has a "NO hideEntryIds" comment? | Action |
|---|---|---|
| `src/markers.ts` `RewindMarker` (lines 54–73) | **NO** — no `hideEntryIds` string anywhere in markers.ts | Just ADD the field + a fresh field-level doc-comment |
| `src/transforms.ts` `RewindMarkerLike` doc-comment (lines 643–645) | **YES** — line 644: `` * (spec/04 §3; spec/06 §1/§12). NO `hideEntryIds` — that's a later fix task. … `` | REPLACE this stale clause |
| `src/transforms.ts` `filterPipeline` doc-comment (line 749) | mentions `NO hideEntryIds/turnHasAdvanced/diag (later fix tasks — CONTRACT is granularity dispatch only)` | **LEAVE UNCHANGED** — see §4 |

grep evidence (`grep -rn hideEntryIds src/` before this task) returns matches ONLY in `src/transforms.ts`
(lines 644, 749). `src/markers.ts` has zero matches.

**Coder implication:** do NOT hunt for a "NO hideEntryIds" comment in `markers.ts` — there isn't one.
The field simply does not exist there yet; add it.

## 2. The two interfaces + the Omit relationship (the load-bearing fact)

`src/markers.ts:55-79`:
```ts
export interface RewindMarker extends MulliganEnvelope {
  kind: "rewind";
  id: string;
  granularity: Granularity;
  options: { to_previous_prompt?: boolean; protect?: string[]; };
  excludeToolCallId?: string;
  checkpoint?: string;          // ← line 68; place hideEntryIds AFTER this
  seq: number;                  // ← line 69 (stamped fields begin here)
  note: NoteInput;
  ledger: FileLedger;
  ts: number;
}
export type RewindMarkerInput = Omit<RewindMarker, "schema" | "v" | "kind" | "id" | "seq" | "ts">;  // line 79
```

**Key:** `hideEntryIds` is NOT in the Omit key set, so adding it to `RewindMarker` makes
`RewindMarkerInput` **automatically** gain `hideEntryIds?: string[]`. Nothing else changes. This is the
"verify TS agrees" check — `npx tsc --noEmit` is the gate (verified clean on baseline).

`src/transforms.ts:647-653`:
```ts
export interface RewindMarkerLike {
  seq: number;
  granularity: "last_tool_call_group" | "last_turn" | "checkpoint";
  options?: { to_previous_prompt?: boolean };
  excludeToolCallId?: string;
  checkpoint?: string;          // ← line 652; place hideEntryIds AFTER this
}
```

## 3. Why this is backward-compatible & non-breaking (verified)

- **`tools/rewind.ts` payload** (`rewindExecute` step 7) builds `const payload: RewindMarkerInput = {…}`
  WITHOUT `hideEntryIds`. Optional field omitted → TS still accepts the literal. (S3 will populate it.)
- **`filter.ts:readMarkers` → `filterPipeline` assignability:** `readMarkers` produces `rewinds: RewindMarker[]`
  (markers.ts) and passes to `filterPipeline(messages, markers, …)` whose `MarkerBundle.rewinds` is typed
  `RewindMarkerLike[]`. Adding the SAME optional `hideEntryIds?: string[]` to BOTH preserves structural
  assignability (`RewindMarker` has every `RewindMarkerLike` field + extras). `tsc --noEmit` confirms.
- **Test fixtures:** `test/pipeline.test.ts:mkRewind(seq, granularity, extra?: Partial<RewindMarkerLike>)`
  spreads `Partial<RewindMarkerLike>` → unaffected by a new optional field. `test/markers.test.ts` type-level
  `RewindMarkerInput` literal omits `hideEntryIds` → still valid (optional).
- **`validateConfig` / `DEFAULT_CONFIG` (`src/config.ts`):** `hideEntryIds` is MARKER DATA, not config.
  These are **untouched** (verified — config.ts has no marker-type knowledge).

## 4. The `filterPipeline` line-749 comment — LEAVE IT

`src/transforms.ts:749`: ``NO hideEntryIds/turnHasAdvanced/diag (later fix tasks — CONTRACT is granularity
dispatch only)`` describes **filterPipeline's RUNTIME behavior** — it genuinely does not *consume*
`hideEntryIds` until **S4** (resolve). After S1 the FIELD exists on the interfaces, but filterPipeline's
contract is unchanged. The comment is still accurate. S4 will rewrite it. **Do not touch it in S1**
(scope = types + docs for the two interfaces only; touching filterPipeline's contract comment risks
mis-stating it). This keeps the change surgical and reviewable.

## 5. Field placement convention (consistency with existing code)

Both interfaces group "targeting/pinning" optional fields together before the stamped/required block:
`excludeToolCallId?` → `checkpoint?` → (NEW) `hideEntryIds?`. Place `hideEntryIds?: string[]` immediately
after `checkpoint?: string;` in BOTH files (markers.ts after line 68; transforms.ts after line 652).
A field-level JSDoc comment is the codebase norm (every RewindMarker field has one).

## 6. Doc-comment text

- **RewindMarkerLike (transforms.ts)** — replace the stale "NO hideEntryIds — that's a later fix task"
  clause with the work-item-prescribed field description (verbatim):
  > "Optional pinned target — the SessionEntry ids this rewind resolved to hide at creation time. When
  > present and non-empty, filterPipeline resolves the removal set from these ids (stable) instead of the
  > live granularity resolver. Absent on legacy/unpinned markers → live resolution (backward compat)."
  This becomes the field-level JSDoc on `hideEntryIds?: string[]`.
- **RewindMarker (markers.ts)** — add a field-level JSDoc consistent with the above (the field carries the
  pinned SessionEntry ids; populated by S3 capture; consumed by S4 resolve; omitted → live resolution).

## 7. Tests (implicit TDD — code is not done without tests)

The repo's type-level pattern is `expectTypeOf` (vitest) — see `test/markers.test.ts:600-679`
("type-level assertions (compile-time)") and `test/pipeline.test.ts`. Add:

- `test/markers.test.ts`: `expectTypeOf<RewindMarker["hideEntryIds"]>().toEqualTypeOf<string[] | undefined>();`
  and that `RewindMarkerInput` (Omit) ALSO has it: build a literal WITH `hideEntryIds: ["e1"]` and assert
  it satisfies `RewindMarkerInput` (proves the Omit auto-gain). Keep the existing omit-fields literal too.
- `test/pipeline.test.ts`: `expectTypeOf<RewindMarkerLike>().toHaveProperty("hideEntryIds").toEqualTypeOf<string[] | undefined>();`
  plus a runtime assertion that `mkRewind(1,"last_tool_call_group",{ hideEntryIds: ["a","b"] })` round-trips
  the value through `filterPipeline` unchanged (proves the new field does not alter granularity dispatch —
  it is carried, not consumed, in S1).

These type-level assertions are enforced by `npx tsc --noEmit` (vitest uses esbuild and does NOT
type-check at run time — the `expectTypeOf` runtime is a no-op proxy; the real check is tsc).

## 8. Verified validation gates

| Gate | Command | Verified |
|---|---|---|
| L1 type-check (whole project incl. Omit auto-gain + assignability) | `npx tsc --noEmit` | ✅ exits 0 on baseline |
| L2 full suite (baseline 653 pass + new type/runtime assertions) | `npx vitest run` | ✅ baseline 653 passed / 2 skipped |

(No lint/format script in package.json; `npm test` === `vitest run`.)
