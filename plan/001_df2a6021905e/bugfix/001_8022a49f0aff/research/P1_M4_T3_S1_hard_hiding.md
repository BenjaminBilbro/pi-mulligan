# P1.M4.T3.S1 — Convert F-rewind-core/F-checkpoint hiding to HARD + mark F-retrycap/F-abortfraction OOS (research notes)

> Subtask of **P1.M4.T3** (Hard seed-hiding assertions + mark out-of-scope scenarios). Depends on
> **P1.M2.T1.S4** (Complete: filter resolves against pinned `hideEntryIds`). Part of **P1.M4** (Integration smoke
> determinism — BUG-007). Sibling of P1.M4.T1.S1 (bloatHit HARD — Complete) and P1.M4.T2.S1 (hasNudge HARD — Complete).

## 1. What this task does (contract summary)

Two independent deliverables, both harness/doc-side (NO `src/` edit):

**(a) run-smoke.mjs** — make the `F-rewind-core.hiding` and `F-checkpoint.hiding` smoke-log lines **GATING**
(a `fail` status → scenario FAIL / exit 1; a `pass` status → passes). Today they are computed but only
`console.log`-warned (SOFT). Keep the **two-signal guard**: signal 1 = `tool.rewind` K-text (K≥1 / K>0 proves
the seed existed + was pinned); signal 2 = the hiding log line `status==="pass"` (seed-absent on the
post-filter observing fire proves it is hidden).

**(b) scenarios.md** — add an explicit **OUT-OF-SCOPE banner** to the `F-retrycap` and `F-abortfraction`
sections: "v1 does not implement `rewind.maxRetriesPerPrompt` / `rewind.abortContextFraction` (not in
`config.ts`); this scenario is documented for future versions and is not run by `npm run smoke`." Do NOT
delete the scenario text (preserve the design rationale).

## 2. Why hiding is NOW deterministic (the dependency P1.M2.T1.S4)

The smoke helper's `context` handler (`test/integration/smoke.ts`) ALREADY emits both hiding log lines on
every post-rewind `context.fire` (gated on `hasRewindMarker` + `currentScenario`):

```ts
// smoke.ts context handler (loads SECOND → observes POST-filter messages):
const seedHiddenInAssistant = msgs.some((m) => m?.role === "assistant" && JSON.stringify(m).includes(SEED_HIDDEN));
if (currentScenario === "F-rewind-core" && hasRewindMarker) {
  smokeLog("F-rewind-core.hiding", seedHiddenInAssistant ? "fail" : "pass", { seedHiddenInAssistant, ... });
}
if (currentScenario === "F-checkpoint" && hasRewindMarker) {
  const cpPass = !seedHiddenInAssistant && seedAnchorInAssistant;
  smokeLog("F-checkpoint.hiding", cpPass ? "pass" : "fail", { seedHiddenInAssistant, seedAnchorInAssistant, ... });
}
```

`smoke.ts` is NOT edited by this task (the logging already exists). The ONLY change is that `run-smoke.mjs`
converts these lines from informational (SOFT `console.log`) to GATING (`assert(...)`).

**The pin (hideEntryIds):** before M2, a `last_turn`/`checkpoint` rewind resolved its target at FILTER time
against the *current* last user message — which had moved (each new `-p` prompt is a new user message) — so
the seed reply could "leak back" or be missed non-deterministically. P1.M2.T1.S4 (Complete) added the
**hideEntryIds pin arm** to `src/transforms.ts:filterPipeline` (lines ~860-880): when a rewind marker carries
a non-empty `hideEntryIds` (captured at rewind-creation time by `src/tools/rewind.ts:resolvePreview`, lines
~301-329), the filter resolves from the **pinned entry ids** against the ORIGINAL messages (translated to
current `m`-indices via `origIdxOfM`) — a STABLE target that does not move with later prompts. So the seed
reply (committed by the seed `-p` BEFORE the rewind command) is stably hidden on the observing inference.
**This is what makes signal 2 deterministic** — the pass/fail from smoke.ts is now a real regression signal
(BUG-001/002/003 leak-back would flip it to `fail`).

The seed flows that make this work are ALREADY in `run-smoke.mjs` `runScenario` (no edit needed here):
- **F-rewind-core** (3-prompt): `Reply with exactly: ${SEED_HIDDEN}` → `/mulligan_smoke F-rewind-core`
  (last_turn rewind pins the seed) → `Reply with exactly: OK` (observing fire; seed HIDDEN).
- **F-checkpoint** (5-prompt): `Reply with exactly: ${SEED_ANCHOR}` → `/mulligan_smoke F-checkpoint-set`
  (labels the anchor) → `Reply with exactly: ${SEED_HIDDEN}` (post-checkpoint content) →
  `/mulligan_smoke F-checkpoint-rewind` (rewind to 'alpha' hides the post-checkpoint seed) →
  `Reply with exactly: OK` (observing fire; seed HIDDEN + anchor PRESENT).

## 3. The two-signal guard (contract: "keep the two-signal guard")

| Signal | What it proves | F-rewind-core location | F-checkpoint location |
|---|---|---|---|
| **1 — tool.rewind K-text** | The seed existed + was PINNED at rewind time (K≥1 / K>0; not "0 messages will be hidden"; not refused). | `assert(results, "tool.rewind hid content (K≥1; not '0 messages will be hidden')", ...)` — **already HARD** | `rwK0` SOFT-conditional branch — **convert to HARD** |
| **2 — hiding log line** | The seed is ABSENT on the post-filter observing fire (status="pass"). | SOFT `console.log` — **convert to HARD** | SOFT `console.log` — **convert to HARD** |

Both must hold: signal 1 proves the seed existed+was pinned (so it WOULD have leaked back if the filter
broke); signal 2 proves it is actually absent. If only signal 2 held, the seed might be absent for an
unrelated reason (e.g. model never produced it). If only signal 1 held, the seed leaked back (regression).
The existing K≥1 assertion (rewind-core) and the converted K>0 assertion (checkpoint) are signal 1; the
added hiding `assert(...)` is signal 2.

## 4. CRITICAL GOTCHA — the `consumed` check MUST stay SOFT (auto-expiry is NOT implemented)

`assertCheckpoint` has a THIRD adjacent check — the **checkpoint auto-expiry / consumed** regression
(validation issue #1b/#5, spec/05 §3 step 5):

```js
const consumed = !labelActive(entries, "mulligan:checkpoint:alpha");
if (!consumed) { console.log(`  ⚠ SOFT: checkpoint not consumed (...)`); }
else { assert(results, "checkpoint 'alpha' CONSUMED by rewind (auto-expiry; spec/05 §3 step 5)", true, ""); }
```

**Verified by source grep (2026-08-11):** there is NO checkpoint-clearing code anywhere in `src/`. The ONLY
`pi.setLabel` call is `src/markers.ts:339` (`pi.setLabel(leafId, "mulligan:checkpoint:" + name)` — SETTING a
checkpoint). There is NO `setLabel(id, undefined)` CLEAR call in `src/filter.ts`, `src/transforms.ts`, or
`src/tools/*.ts`. `src/tools/rewind.ts:231-240` is a comment for `isCheckpointActive` (latest-wins label
resolution used by the rewind TOOL to refuse rewinding to an already-consumed checkpoint) — not a clearing
mechanism.

**Consequence:** the checkpoint label 'alpha' is NEVER cleared after a rewind → `labelActive(entries,
"mulligan:checkpoint:alpha")` is ALWAYS true → `consumed` is ALWAYS false → the current code ALWAYS hits the
SOFT `console.log` branch and NEVER asserts. **If this check were made HARD, F-checkpoint would PERMANENTLY
FAIL** (a `test ! -f`-style permanent-unwinnable, but for content). This auto-expiry is a SPEC'D behavior
(spec/05 §3 step 5) that is simply not yet implemented; it is **orthogonal to hideEntryIds** (the M2 pin makes
HIDING deterministic but does not clear labels).

**Decision:** LEAVE the `consumed` check SOFT. ONLY fix its stale comment (which wrongly blames
"hideEntryIds not yet implemented") to state the true reason: auto-expiry is spec'd but not implemented;
unrelated to hideEntryIds. Do NOT make it HARD.

## 5. config.ts OOS verification (for the scenarios.md banners)

`src/config.ts` `MulliganConfig.rewind` interface + `DEFAULT_CONFIG.rewind` contain EXACTLY: `enabled`,
`protectedRoles`, `maxDepth`, `requireMutationWarning`. `validateConfig` coerces EXACTLY those four (lines
~"rewind.*" block). There is **no** `maxRetriesPerPrompt` and **no** `abortContextFraction` key — not in the
interface, not in DEFAULT_CONFIG, not in validateConfig. Unknown keys are ignored (forward-compat), so even if
a user wrote them in settings.json, they would be silently dropped. **Confirmed: F-retrycap and
F-abortfraction reference unimplemented v1 config knobs** → legitimately OUT-OF-SCOPE.

The `SCENARIOS` array in `run-smoke.mjs` already EXCLUDES both (it lists the 9 run scenarios:
F-rewind-core, F-shrink-persist, F-shrink-preventive, F-nudge-drift, F-protected, F-maxdepth, F-checkpoint,
F-failopen, F-reload). So they are already not run; the banner just makes it explicit + discoverable in the doc.

## 6. Exact current SOFT code to change (run-smoke.mjs)

**assertRewindCore** (lines ~243-259) — the hiding block + the `soft:` return:
```js
  // NEW: the seed reply hiding check — SOFT because live last_turn resolution at filter time targets the
  // current last user message (which has moved since rewind time). The oracle's hideEntryIds pinning
  // (later task) makes this deterministic. Without it, the seed may not be hidden.
  const hidingLines = smoke.lines.filter((l) => l.test === "F-rewind-core.hiding");
  const lastHiding = hidingLines[hidingLines.length - 1];
  const hidingPass = lastHiding && lastHiding.status === "pass";
  if (!hidingPass) {
    console.log(`  ⚠ SOFT: seed hiding not verified (hideEntryIds not yet implemented — live last_turn resolution moved the target)`);
  }
  // ... (JSONL block unchanged) ...
  return { results, entries, soft: "seed hiding requires hideEntryIds pinning (later task); ..." };
```

**assertCheckpoint** (lines ~392-420) — signal 1 (rwK0) + signal 2 (hiding) + the consumed check:
```js
  const rwK0 = rwLine && /0 messages will be hidden/i.test(rwText);
  if (rwK0) {
    console.log(`  ⚠ SOFT: checkpoint rewind K=0 at filter time (hideEntryIds not yet implemented — ...)`);
  } else {
    assert(results, "checkpoint rewind K>0 (rewind-time preview)", rwLine && !/refused/i.test(rwText), rwText.slice(0, 80));
  }
  // ... hiding SOFT block (same shape as rewind-core) ...
  // ... consumed SOFT check (MUST STAY SOFT — see §4) ...
```

## 7. Validation gates

- **Level 1 (type):** `npx tsc --noEmit -p tsconfig.json` — no `.ts` file is edited (only `.mjs` + `.md`),
  so this is a regression no-op (expected exit 0). `run-smoke.mjs` is `.mjs` (not typechecked).
- **Level 2 (unit):** `npm test` (vitest) — no `test/*.ts` edited; expected green (the smoke harness files
  are not vitest tests). Regression gate.
- **Level 3 (integration — AUTHORITATIVE):** `npm run smoke` — must report **9/9** with F-rewind-core and
  F-checkpoint PASSING on the HARD hiding assertions; the SOFT lines
  "⚠ SOFT: seed hiding not verified" and "⚠ SOFT: checkpoint seed hiding not verified" must be GONE. The
  `consumed` SOFT line MAY remain (auto-expiry not implemented — see §4). Requires `pi` on PATH + a working
  model (glm-5.2; baseline 9/9 as of the M2 pin landing).

## 8. Scope boundaries (do NOT cross)

- NO `src/` file is modified (the hideEntryIds pin + hiding log emission are already correct + landed).
- NO `smoke.ts` edit (the hiding log lines are already emitted; only `run-smoke.mjs` treats them as gating).
- NO M2 region (`transforms.ts`/`markers.ts`/`filter.ts`/`rewind.ts`) touched.
- NO sibling territory: F-shrink-preventive/bloatHit (M4.T1 — Complete), F-nudge-drift/hasNudge (M4.T2 —
  Complete). Only assertRewindCore + assertCheckpoint + the F-retrycap/F-abortfraction sections of scenarios.md.
- Do NOT make the `consumed` check HARD (§4 — would permanently fail F-checkpoint).
- Do NOT delete F-retrycap/F-abortfraction scenario text (preserve the design rationale); only PREPEND the banner.
- NO `spec/` file edited (spec/10 §2.1 + spec/05 §3 are read-only reference).

## 9. Confidence

9/10. The hiding signal is deterministic because the M2 pin (P1.M2.T1.S4, Complete) resolves pinned entry ids
stably; the seed flows that produce the seed replies are already in `run-smoke.mjs` and pass 9/9 today (the
hiding lines currently emit `pass` but are SOFT). Converting them to HARD mirrors the completed sibling
pattern (M4.T1 bloatHit, M4.T2 hasNudge). The single residual risk is model flakiness (glm-5.2 not producing
the exact seed reply on one run) — same model-dependence F-rewind-core ALREADY accepts (signal 1 K≥1 is
already HARD and depends on the seed reply existing). The `consumed` check is explicitly excluded (§4).
