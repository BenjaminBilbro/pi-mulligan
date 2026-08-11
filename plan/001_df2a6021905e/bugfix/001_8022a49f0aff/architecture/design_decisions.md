# Design Decisions — chosen fix approach per bug

> These are the architecture panel's chosen approaches, with rationale and the
> rejection of inferior alternatives. Downstream subtasks MUST follow these.

## BUG-001 + BUG-006 — wire configuration reading (treated as ONE wiring change)

### Approach
1. Add a **new pure-ish helper module** `src/settingsLoader.ts` exporting
   `loadMulliganSettings(opts: { cwd?: string; isTrusted?: boolean }): unknown`.
   - Reads global `~/.pi/agent/settings.json` (via `os.homedir()`), then project-local
     `<cwd>/.pi/settings.json` **only when `isTrusted === true`**.
   - Merge: shallow-merge the two JSON objects at the `mulligan` key (project-local
     `mulligan` object overrides the global `mulligan` object — top-level replace, NOT
     deep-merge; spec/09 §1 says "project-local wins"). Return the merged `mulligan`
     value (or `undefined`).
   - **Never throws:** missing/unreadable/non-JSON file → treat as absent (return
     `undefined` / skip). Malformed JSON → `console.warn` + skip (mirror config.ts's
     warnConfig discipline). No `pi` import (keeps it unit-testable with a tmp dir).
2. In `index.ts`:
   - **Factory time:** call `setConfig(loadMulliganSettings({}))` (global-only best-effort;
     no cwd yet). Wrap in try/catch (never break load).
   - **`session_start` handler:** call `setConfig(loadMulliganSettings({ cwd: ctx.cwd,
     isTrusted: ctx.isProjectTrusted() }))` for EVERY reason (startup|reload|new|resume|fork),
     THEN the existing `resetRuntime(...)`. This single change fixes BOTH BUG-001 (load) and
     BUG-006 (reload) — the handler already fires on `/reload`.
3. `getConfig()` already caches `validateConfig(raw)`; after `setConfig`, `getConfig()`
   returns the merged settings. No change to `config.ts`'s validateConfig (it is already
   correct — it was just never fed real input).

### Why this shape
- The factory has no `ctx`, so project-local (needs `cwd`) can only be read at `session_start`.
  Reading global at factory time means config is populated even before the first `session_start`
  fires (defense for any early `getConfig()` call).
- A separate `settingsLoader.ts` keeps the fs/merge logic unit-testable WITHOUT pi (write a
  tmp `settings.json`, point the loader at it, assert the merge). This respects the project's
  pure-tier convention.
- Re-reading on every `session_start` (not just reason==="reload") is cheapest-correct and
  sidesteps the "which reasons count" question; matches "re-read on /reload" because reload
  IS a session_start reason.

### Rejected alternatives
- **Deep-merge mulligan objects** — rejected: spec/09 §1 says "project-local overrides global"
  (top-level replace), and deep-merge introduces ambiguity (e.g. partial `rewind` block).
  validateConfig already fills defaults for missing keys, so top-level replace is safe.
- **Read settings inside `getConfig()` lazily** — rejected: `getConfig()` has no `ctx`, so it
  cannot discover `cwd`/trust. Lazy-on-first-use is preserved *behaviorally* (config is set
  at session_start, before the first context fire) without putting fs reads on the hot path.

### Test coverage (Mode A, rides with the work)
- Unit: `test/settingsLoader.test.ts` — tmp-dir fixtures for global-only, local-only, both
  (local wins), untrusted→global-only, missing files, malformed JSON (warn + skip).
- Integration: extend `test/index.test.ts` — invoke the session_start handler with a mock ctx
  whose `cwd` points at a tmp `.pi/settings.json` with `mulligan.enabled=false`; assert
  `getConfig().enabled === false` AND that a registered tool refuses. (This is the PRD's
  headline "enabled:false → all four tools refuse" proof, made deterministic.)

---

## BUG-002 — pin each last_tool_call_group rewind's target at creation time

### Root cause (re-confirmed)
`filterPipeline` re-resolves each rewind's target LIVE against the *current* (already-reduced)
message list on every inference (spec D7 "record a spec, not indices"). For `last_tool_call_group`,
`resolveLastToolCallGroup` returns "the last toolGroup unit EXCLUDING the rewind's own
`excludeToolCallId`". When a **second** rewind marker exists, the FIRST rewind's "last toolGroup"
re-resolves to whatever is now last (often the second rewind's own group, or a newer non-rewound
tool call) — NOT the span the agent originally shed. Net: originally-hidden content reappears.

### Approach (pinned targeting)
1. **Data model** (`markers.ts` + `transforms.ts:RewindMarkerLike`): add an OPTIONAL
   `hideEntryIds?: string[]` field (the codebase already anticipates this exact name in TODO
   comments). It carries the `SessionEntry.id`s of the messages the rewind resolved to hide AT
   CREATION TIME.
2. **Capture at creation** (`tools/rewind.ts:resolvePreview`): after resolving the `remove`
   index set, map those message indices back to their source `SessionEntry.id`s (the preview
   already iterates `buildContextEntries()` → `sessionEntryToContextMessages`; build an
   `index → entryId` map during that flat-map). Store the ids as `hideEntryIds` on the
   `RewindMarkerInput` payload. On any mapping failure → `hideEntryIds` omitted (fall back to
   live resolution — backward compatible, never blocks the rewind per E13/E8).
3. **Filter resolves against the pin** (`transforms.ts:filterPipeline`): if a rewind marker
   carries a non-empty `hideEntryIds`, resolve its removal set by mapping those entry ids to
   CURRENT message indices via the `branchEntries` walk (REUSE `resolveCheckpoint`'s
   `entryMessageYield` + ctxEntries-walk logic — extract a shared `mapEntryIdsToMessageIndices`
   helper). Remove exactly those indices (still gated by `protectedOk`). If a pinned entry is
   absent from the current branch (compaction removed it) → skip it (the rewind no-ops for that
   entry — correct, compaction already hid it). If `hideEntryIds` is ABSENT (old/unpinned
   marker) → fall back to the existing live resolution (backward compat within a session).
4. **Composition test** (`test/pipeline.test.ts`): add a test that builds the BUG-002 fixture
   (two stacked last_tool_call_group rewinds with interspersed content) and asserts the
   ORIGINALLY-HIDDEN span's **CONTENT string** is absent from `filterPipeline`'s output (not
   just role signatures). This is the regression guard the existing §11 test lacks.

### Why pin by ENTRY id (not toolCallId)
- Entry ids work for ALL granularities (last_tool_call_group hides specific entries; last_turn
  would pin the range; checkpoint already pins via the label's targetId). Choosing entry ids
  now keeps the mechanism uniform and future-proofs last_turn/checkpoint pinning.
- `resolveCheckpoint` ALREADY maps entries→messages via `entryMessageYield`; extracting that
  into a shared helper avoids duplication and is low-risk.
- toolCallId-only pinning would be simpler for last_tool_call_group but would NOT generalize,
  and the codebase's TODO comments already name `hideEntryIds`.

### Scope decision (IMPORTANT)
BUG-002's reproducible defect is `last_tool_call_group`. The pin is captured for the resolved
`remove` set regardless of granularity (the capture step is granularity-agnostic — it just maps
the resolved indices to entry ids). So last_turn/checkpoint rewinds ALSO get pinned as a side
effect, which is correct and closes the related last_turn "live resolution moved the target"
SOFT caveat (helps BUG-007). The filter's per-granularity dispatch is unchanged; only the
SOURCE of the removal set switches from live-resolve to pin-map when `hideEntryIds` is present.

### Rejected alternatives
- **"Exclude ALL rewind-owned toolCallIds" (the recommendation's "at minimum")** — rejected as
  insufficient: verified by hand-trace that it FAILS when non-rewound toolGroups are
  interspersed between two rewinds (rewind#1 then re-targets the wrong newer group; the
  originally-hidden group reappears). It only works for the spec §11 fixture where every
  group between the rewinds is itself rewound. Pinning is required for the general case.

---

## BUG-003 — enforce `latest:user` protection

### Approach
1. **`transforms.ts:protectedOk`**: add a `latest:user` branch. When `protectedRoles` includes
   `"latest:user"` (default), compute `iLatestUser` (index of the LAST `role:"user"` message)
   and REFUSE (return false) if the removal set contains `iLatestUser`. Mirror the existing
   `first:user` discipline (fail-safe: malformed config → enforce). This is the filter's
   defense-in-depth (spec/06 §8).
2. **`tools/rewind.ts` step-5b**: extend the pre-persist protected check beyond
   `last_turn && to_previous_prompt`. For `checkpoint` granularity, after `resolvePreview`
   yields `k`/`remove`, check whether the removal set would cross the latest user message; if
   so, refuse BEFORE persisting (return the protected refusal text, persist nothing — no stray
   marker/note). Concretely: reuse the same "would cross a protected message" refusal text shape.
   (This mirrors how the existing step-5b refuses nuclear last_turn across the first user msg.)
3. **Test** (`test/pipeline.test.ts` + `test/tools/rewind.test.ts`): the PRD's BUG-003
   synthetic fixture (checkpoint whose targetId precedes a later user message) must now (a)
   have `protectedOk(...) === false`, and (b) the rewind tool returns a refusal + persists
   zero markers.

### Why both layers
spec/06 §8 mandates defense-in-depth: "the tool refuses before persisting; the filter
double-checks and no-ops". BUG-003 currently has NEITHER layer covering `latest:user` for
checkpoint (the filter's protectedOk ignores latest:user; the tool's step-5b covers only
last_turn/nuclear). Both must be closed.

---

## BUG-004 — scope marker/label reads to the current branch

### Approach
Switch `getEntries()` → `getBranch()` in exactly four places:
- `filter.ts:readMarkers` (line ~106)
- `tools/rewind.ts:countRewindMarkers` (line ~207)
- `tools/rewind.ts:checkpointExists` (line ~244)
- `tools/audit.ts:listCheckpoints` call site (line ~563) — `listCheckpoints` itself takes an
  `entries[]` arg (pure), so only its CALLER changes.

`getBranch()` returns root→leaf; the four consumers are all order-insensitive (bucketing /
counting / latest-wins-via-getLabel candidate discovery), so no reordering is needed. Add a
test in `test/filter.test.ts` (and/or a focused unit test) that feeds a mock sessionManager
whose `getBranch()` returns only branch-B entries while `getEntries()` returns A+B, and
asserts branch-A markers are NOT applied/counted.

### Risk
Low. `getBranch()` is already used in `contextHandler` and `resolveCheckpoint`. The only
behavioral change: after `/tree` navigation, sibling-branch markers no longer leak. This is
strictly more correct. The spec §1 pseudocode used `getEntries()` (latent design issue), but
spec/02 C12's *intent* ("read fresh... current state") is satisfied by `getBranch()`.

---

## BUG-005 — null-check the marker persist result

### Approach
In `tools/rewind.ts:rewindExecute`, after `const markerId = appendRewindMarker(pi, ctx, payload);`,
add `if (markerId === null) return refusal("failed to persist the rewind marker (nothing will be hidden)", granularity);`
BEFORE `leaveNote(...)`. This skips the note (no stray note for a failed rewind) and returns the
shared `Mulligan: refused — …` text so the agent pattern-matches a refusal. `details.markerId`
stays absent (it's only on the success path).

### Test
`test/tools/rewind.test.ts`: inject a fake `pi` whose `appendEntry` throws (and/or a ctx whose
`getLeafId()` returns null); assert the tool returns a `refused` text and does NOT call
`sendMessage` (the note). Minimal, isolated.

---

## BUG-007 — deterministic coverage for the SOFT smoke scenarios

### Approach (ONLY after BUG-001 + BUG-002 land)
1. **bloatHit (F-shrink-preventive):** register a NON-`mulligan_*` test tool in `smoke.ts`
   (e.g. `smoke_read_big`) whose result exceeds the resolved per-tool threshold, then drive a
   model/tool_result through it so `bloatReminderHandler` fires → assert `bloatHit:true` in the
   turn-metric. (The current `mulligan_smoke_big` is skipped by the handler because it starts
   with `mulligan_` — src/nudges.ts line 190.)
2. **hasNudge (F-nudge-drift):** now that BUG-001 lands real config reading, lower
   `nudges.driftThresholdTokens` via `.pi/settings.json` (Mulligan's OWN config instance reads
   it) and drive a controlled two-turn drift harness so `shouldNudge` fires → assert
   `hasNudge:true` in context.fire AND zero `mulligan:nudge` entries on disk.
3. **seed-hiding (F-rewind-core + F-checkpoint):** now that BUG-002 pins targets, the
   last_turn/checkpoint hiding becomes deterministic — convert the SOFT `F-rewind-core.hiding` /
   `F-checkpoint.hiding` assertions from "pass/fail logged but not gating" to HARD gating
   assertions in `run-smoke.mjs`.
4. **F-retrycap / F-abortfraction:** these reference unimplemented config knobs
   (`rewind.maxRetriesPerPrompt`, `rewind.abortContextFraction` — NOT in v1 config.ts). Mark
   them OUT-OF-SCOPE in `scenarios.md` (v1 does not implement them) rather than leaving them as
   dangling documented scenarios.

### Why last
Every deterministic assertion above depends on a fix from BUG-001 or BUG-002. Building them
before those land would just reproduce the current SOFT caveats.

---

## BUG-008 — audit Suggestion line correctness

### Approach
In `tools/audit.ts:renderAuditReport`, make the Suggestion line role-aware:
- `toolResult` → `"...the \`${label}\` result is the largest contributor. Consider mulligan_shrink."` (unchanged).
- `assistant` → `"...the assistant turn \`${label}\` is the largest contributor. Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink."`
- `user` (or anything else) → `"...the largest contributor is the \`${label}\` message (role: \`${role}\`). No Mulligan operation applies to a non-tool message."` (or simply OMIT the suggestion — spec/05 §4 only shows it for a toolResult).
- Decision: **keep the line but make it honest per role**; OMIT only when filtered is empty (already handled). Tests in `test/tools/audit.test.ts` for each role as rows[0].

### Documentation
This is a per-file behavior change to an LLM-facing string → Mode A doc note is not required
(the string is the doc), but `README.md` §6 (if it quotes the Suggestion format) should be
checked for sync (Mode B, final sync task).
