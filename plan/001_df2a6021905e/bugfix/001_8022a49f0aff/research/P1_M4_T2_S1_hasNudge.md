# Research — P1.M4.T2.S1 — Config-driven low drift threshold + two-turn drift harness + hasNudge assertion (BUG-007)

## What this task is
Make F-nudge-drift's `hasNudge:true` a DETERMINISTIC HARD assertion (today it is SOFT / "model-driven —
requires a >3000-token turn"). The drift nudge fires when `metric.deltaTokens > config.nudges.driftThresholdTokens`
AND a baseline exists from a prior turn (`shouldNudge`/`injectNudge`/`suppressCheck` in `src/nudges.ts`,
wired into `src/filter.ts:contextHandler` after `filterPipeline`). Today lowering the threshold via
`setConfig` from the smoke helper does NOT work — Pi's jiti loader gives the smoke helper a SEPARATE
`config.ts` module instance from Mulligan's (documented in smoke.ts lines 31–37). After M1 (P1.M1.T2.S1),
Mulligan reads `<cwd>/.pi/settings.json` at its OWN `session_start` (`src/index.ts`), so a project-local
settings file with a tiny `driftThresholdTokens` IS honored by Mulligan's config instance. Fix = run the
F-nudge-drift scenario in a **scoped tmp cwd** whose `.pi/settings.json` sets `driftThresholdTokens=1`
(trivially crossed), drive a **two-turn harness** (turn 1 baseline → turn 2 growth → turn 3 observing
context.fire with `hasNudge:true`), and assert `hasNudge:true` HARD + still ZERO `mulligan:nudge` entries
on disk (the §2.3 invariant — the nudge is EPHEMERAL, constructed in the filter copy only, never
`pi.sendMessage`'d).

## Files touched (verified)
- `test/integration/smoke.ts` — update the `F-nudge-drift` case in `driveScenario` (currently logs a
  `config.driftLow` info line referencing the OLD model-driven path; repurpose to a `drift.harness` log
  describing the deterministic two-turn path). The command itself stays a no-op driver (it is NOT a model
  turn — verified: it produces no `context.fire` and no `turn_end`).
- `test/integration/run-smoke.mjs` — (a) extend `runPi` to accept a `cwd` option (resolve `-e` paths to
  absolute + add `-a` to trust the tmp project + pass `cwd` to `spawnSync`); (b) add a custom
  `runScenario` branch for F-nudge-drift that creates the scoped tmp cwd + `.pi/settings.json`, drives the
  4-prompt two-turn flow, and cleans up the tmp dir in a `finally`; (c) upgrade `assertNudgeDrift` to
  HARD-assert `hasNudge:true` on the last `context.fire` + `grewOverThreshold:true` on a turn-metric + drop
  the `soft` field.
- `test/integration/scenarios.md` — Mode A doc: rewrite the F-nudge-drift section from "model-driven — SOFT"
  to the deterministic tmp-cwd + threshold=1 + two-turn path.

NO `src/` file is modified. The nudge mechanism (`shouldNudge`/`injectNudge`/`suppressCheck` +
`turnEndMetricHandler`) is already correct + unit-tested; this task closes the INTEGRATION gap.

## CRITICAL verified facts

### 1. The nudge pipeline (src/nudges.ts + src/filter.ts — READ-ONLY, already correct)
- `turnEndMetricHandler` (nudges.ts) fires at every `turn_end`: computes `delta = now − rt.tokenBaseline`
  (null on turn 1 / post-reload when baseline is null), sets `grewOverThreshold = delta != null && delta >
  config.nudges.driftThresholdTokens`, persists a `mulligan:turn-metric`, then rolls `rt.tokenBaseline = now`.
- `contextHandler` (filter.ts) runs `filterPipeline`, THEN: `if (config.nudges.perTurnDrift && metric &&
shouldNudge(metric, config) && !suppressCheck(metric, markers)) finalMessages = injectNudge(messages, metric);`
  where `metric` = the latest turn-metric by highest `seq`.
- `shouldNudge` = `grewOverThreshold || bloatHit`. `injectNudge` APPENDS an ephemeral `mulligan:nudge`
  CustomMessage to a NEW copy (NEVER `pi.sendMessage` → never persisted). `suppressCheck` suppresses iff a
  rewind/shrink marker was created during the metric's turn (none in F-nudge-drift → not suppressed).
- Timing: the metric is read FRESH each `context.fire`. Turn N's metric is appended at turn N's `turn_end`,
  so it is visible to turn N+1's `context.fire`. This is why a TWO-turn harness is required: turn 1 sets the
  baseline (metric#1 delta=null → no nudge); turn 2 grows past threshold (metric#2 grewOverThreshold=true);
  turn 3's `context.fire` reads metric#2 → `hasNudge:true`.

### 2. The M1 config wiring (src/index.ts + src/settingsLoader.ts — READ-ONLY, the dependency)
- `src/index.ts` `session_start` handler: `setConfig(loadMulliganSettings({ cwd: ctx.cwd, isTrusted:
  ctx.isProjectTrusted() }))`. So Mulligan reads `<cwd>/.pi/settings.json` at its OWN session_start —
  Mulligan's config instance, NOT the smoke helper's (jiti isolation defeated by reading from disk).
- `settingsLoader.loadMulliganSettings`: reads global `~/.pi/agent/settings.json` unconditionally + local
  `<cwd>/.pi/settings.json` ONLY when `isTrusted === true` (TOP-LEVEL REPLACE: a local `mulligan` key
  REPLACES the global one; then `validateConfig` merges over DEFAULT_CONFIG). The global settings.json has
  NO `mulligan` key → defaults. A local `{mulligan:{nudges:{driftThresholdTokens:1}}}` → defaults with
  driftThresholdTokens=1.
- `config.ts` `coerceNumber(..., mustBePositive:true)` → `1 > 0` is VALID (line 279–280). So
  `driftThresholdTokens:1` is a legal, honored value.
- DEFAULT `driftThresholdTokens = 3000` (config.ts line 93). With 3000, trivial "Reply with exactly:" turns
  never cross it → no nudge → SOFT. With 1, ANY growth crosses it → deterministic.

### 3. Trust: the project root is trusted; tmp cwd needs `-a` (VERIFIED)
- `~/.pi/agent/trust.json` has `"/home/dustin/projects": true` — the closest saved decision applies to
  children, so the project root (`/home/dustin/projects/pi-mulligan-hack`) IS trusted. (The existing 9/9
  smoke suite relies on this.)
- A **tmp cwd** (e.g. `/tmp/mulligan-smoke/drift-cwd-<RUN_ID>`) is NOT trusted by default (`/tmp` is not a
  trusted parent; only `/tmp/saf-e2e` is saved). In non-interactive `-p` mode with no saved decision,
  `defaultProjectTrust:"ask"` IGNORES project resources (security.md). So the local `.pi/settings.json`
  would NOT be read.
- **Fix: `pi --approve` / `-a`** ("Trust project-local files for this run" — `pi --help`). `-a` forces
  `isProjectTrusted() === true` for that one run → the local `.pi/settings.json` IS read. SPIKE-PROVEN
  (see §5): with `-a` + tmp cwd + threshold=1, metric#2 had `grewOverThreshold:true` → nudge fired.
- Note: a bare `.pi` dir does NOT require trust (security.md), but `.pi/settings.json` DOES (it is a
  project resource). So `-a` is required for the tmp cwd.

### 4. The `/mulligan_smoke` command is NOT a model turn (VERIFIED)
The command dispatches synchronously (driveScenario → logs → returns); it produces NO `context.fire` and
NO `turn_end` (no model inference). So prepending `/mulligan_smoke F-nudge-drift` as prompt 1 does NOT
disrupt the two-turn baseline sequence. The 4-prompt flow (command + 3 model turns) yields exactly 3
context.fires — same as the 3-prompt flow. (SPIKE-PROVEN — see §5 run3.)

### 5. SPIKE PROOF (run 2026-08-11 against this repo + glm-5.2)
Two spikes, both in a tmp cwd `/tmp/mulligan-drift-spike/.pi/settings.json` =
`{"mulligan":{"nudges":{"driftThresholdTokens":1}}}`, run via `cd /tmp/mulligan-drift-spike && pi -ne -a
-e <abs>/src/index.ts -e <abs>/test/integration/smoke.ts ...` (cwd = tmp dir; `-a` trusts it; ABSOLUTE `-e`
paths so they resolve regardless of cwd).

**run2 — 3-prompt flow (no command):** `-p "Reply with exactly: ALPHA" -p "Reply with exactly: BETA BETA
BETA BETA BETA" -p "Reply with exactly: OK"`.
- session JSONL path: `.../sessions/--tmp-mulligan-drift-spike--/...jsonl` (cwd honored ✓).
- context.fire: `count=2 hasNudge=False` (turn 1) → `count=4 hasNudge=False` (turn 2) → `count=7
  hasNudge=True` (turn 3 — observing) ✓.
- session JSONL: 3 turn-metrics, ZERO `mulligan:nudge` entries.
  - metric#1: deltaTokens=null, grewOverThreshold=false (turn 1, baseline null).
  - metric#2: deltaTokens=66, grewOverThreshold=true (turn 2 grew 66 tokens > 1).
  - metric#3: deltaTokens=102, grewOverThreshold=true (turn 3).

**run3 — 4-prompt flow (command prepended):** `-p "/mulligan_smoke F-nudge-drift" -p "Reply with exactly:
ALPHA" -p "Reply with exactly: BETA BETA BETA BETA BETA" -p "Reply with exactly: OK"`.
- context.fire: exactly 3 (command produced NONE) → last fire `hasNudge=True` ✓.
- session JSONL: 3 turn-metrics (metric#2 delta=80 grew=true), ZERO nudges.
- smoke log included `config.driftLow`, `scenario.start`, `scenario.done` (command ran, observable).

**Conclusion:** the 4-prompt flow (command + 3 model turns) in a `-a`-trusted tmp cwd with
`driftThresholdTokens=1` DETERMINISTICALLY yields `hasNudge:true` on the last `context.fire` + ZERO
`mulligan:nudge` entries on disk + a turn-metric with `grewOverThreshold:true`. This is the HARD target.

### 6. Unit-level coverage already exists (READ-ONLY citations — NOT modified)
- `test/drift_nudge.test.ts` line 123: `grewOverThreshold:true → nudge appended`; line 266–269 describe/
  it: `zero-persist: mulligan:nudge is ephemeral (never persisted)`; line 303–304: `F-nudge-drift:
  >3000-delta metric → next context.fire ends with mulligan:nudge` (end-to-end unit proof).
- `test/turn_metric.test.ts` line 282: `deltaTokens is null when tokenBaseline is null (first turn)`;
  line 336: `grewOverThreshold is true when delta > driftThresholdTokens`; line 256+: `turnEndMetricHandler`
  delta/baseline/roll coverage.
- So the nudge mechanism is UNIT-proven. This task is the INTEGRATION gap (no new unit test needed).

## The orchestrator mechanics (run-smoke.mjs — verified shape)
- `runPi(scenario, { prompts, extraArgs = [] })` (line ~62): spawns `pi -ne -e ./src/index.ts -e
  ./test/integration/smoke.ts --session-id smoke-<scenario>-<RUN_ID> ... -p <p1> -p <p2>` via
  `spawnSync("pi", argv, { encoding, env: {MULLIGAN_SMOKE_LOG:logPath}, timeout })`. NO `cwd` option → pi
  inherits `process.cwd()` (project root). RELATIVE `-e` paths work because cwd = project root.
- To run in a tmp cwd: (a) add a `cwd` option to `runPi`; (b) when `cwd` is set, resolve `-e` to ABSOLUTE
  paths via a captured `PROJECT_ROOT = process.cwd()` (npm runs the orchestrator in the package dir →
  project root) AND add `-a` to argv AND pass `cwd` to `spawnSync`.
- Imports (line 26): `import { readFileSync, existsSync, mkdirSync } from "node:fs";` → ADD `writeFileSync,
  rmSync`.
- `runScenario(scenario)` has custom-prompts branches for F-rewind-core (3-prompt), F-shrink-preventive
  (2-prompt), F-checkpoint (5-prompt), F-reload (2-spawn). Add a F-nudge-drift branch (4-prompt + tmp cwd).
- `assertNudgeDrift({smoke,piRes})` currently: asserts `config.driftLow` logged + turn-metric exists + ZERO
  nudges + returns `soft:"hasNudge:true requires a >3000-token turn (model-driven); see scenarios.md"`.
  Upgrade: assert `drift.harness` logged + LAST context.fire `hasNudge===true` (HARD) + ≥2 turn-metrics +
  SOME turn-metric `grewOverThreshold===true` (HARD) + SOME turn-metric `deltaTokens` is a number + ZERO
  nudges; DROP the `soft` field.

## Implementation plan (dependency-ordered)
1. **run-smoke.mjs top + runPi** — add `const PROJECT_ROOT = process.cwd();` near RUN_ID; extend the
   `node:fs` import with `writeFileSync, rmSync`; add `cwd` to `runPi`'s destructure; when `cwd` is set,
   use absolute `-e` paths + prepend `-a` + pass `cwd` to `spawnSync`.
2. **run-smoke.mjs runScenario F-nudge-drift branch** — create `<SMOKE_TMP_DIR>/drift-cwd-<RUN_ID>/.pi/`,
   write `settings.json` = `{"mulligan":{"nudges":{"driftThresholdTokens":1}}}`, call `runPi(scenario,
   { cwd: driftCwd, prompts: ["/mulligan_smoke F-nudge-drift","Reply with exactly: ALPHA","Reply with
   exactly: BETA BETA BETA BETA BETA","Reply with exactly: OK"] })`, `return { piRes, smoke }` in a
   `try { ... } finally { rmSync(driftCwd, {recursive:true, force:true}); }` (hermetic cleanup).
3. **run-smoke.mjs assertNudgeDrift** — replace `config.driftLow` check with `drift.harness`; add HARD
   `last context.fire hasNudge===true` + `≥2 turn-metrics` + `grewOverThreshold===true` + `deltaTokens is
   a number` + keep ZERO-nudge + assertGlobalInvariants; DROP the `soft` field (return `{results, entries}`).
4. **smoke.ts driveScenario F-nudge-drift case** — replace the `config.driftLow` log with a `drift.harness`
   info log describing the deterministic path (the command is a no-op driver; the orchestrator prompts +
   tmp settings do the work).
5. **scenarios.md F-nudge-drift section** — rewrite Run (deterministic) / Run (model-driven) / Expect /
   Pass to describe the tmp-cwd + threshold=1 + two-turn path; drop the "model-driven — SOFT" parenthetical.

## Validation gates (verified working in this env)
- `npx tsc --noEmit -p tsconfig.json` → 0 (smoke.ts IS typechecked — tsconfig includes "test"; the
  driveScenario edit is trivial. run-smoke.mjs is .mjs, NOT typechecked).
- `npm test` → 697 passed | 2 skipped (must stay green; smoke.ts/run-smoke.mjs are NOT vitest tests).
- `npm run smoke` → must be 9/9 with F-nudge-drift HARD-asserting `hasNudge:true` (no SOFT line).
  Requires `pi` on PATH + glm-5.2 (spike-proven). If the model times out, F-nudge-drift FAILS on the HARD
  assertion (intended — it is now a real gate, like F-rewind-core canary-drop).

## Gotchas
- The tmp cwd MUST be trusted via `-a` or the local `.pi/settings.json` is ignored (the project root is
  trusted via `/home/dustin/projects` in trust.json, but a tmp dir is not). SPIKE-PROVEN.
- The `-e` paths MUST be absolute when `cwd != project root` (relative `./src/index.ts` breaks in a tmp
  cwd). Capture `PROJECT_ROOT = process.cwd()` once at orchestrator load.
- The two-turn harness needs turn 1 to ESTABLISH the baseline (metric#1 delta=null) and turn 2 to GROW
  past threshold (metric#2 grewOverThreshold=true). The observing hasNudge:true appears on turn 3's
  context.fire. Do NOT collapse to fewer prompts or the baseline/growth sequence breaks.
- Do NOT lower the threshold via `setConfig` in the smoke helper (jiti isolation — separate config.ts
  instance; documented). The `.pi/settings.json` disk path is the ONLY way (M1 wiring).
- The nudge is EPHEMERAL — `injectNudge` appends to the returned copy only, NEVER `pi.sendMessage`. So
  ZERO `mulligan:nudge` entries on disk is the §2.3 headline invariant (assert it HARD).
- `driftThresholdTokens:1` is valid (`coerceNumber` requires `>0`; 1 > 0). Do NOT use 0 (invalid → default
  3000). 1 is trivially crossed by any non-empty turn (spike: delta=66/80/102).
- Cleanup the tmp cwd in a `finally` so a failed run does not leave a stray `.pi/settings.json` that could
  affect a later re-run in the same tmp space (SMOKE_TMP_DIR is shared across scenarios).
- Do NOT touch src/ (the nudge mechanism is correct + unit-tested), M2 regions (transforms/markers/filter/
  rewind), or M4.T1/M4.T3 territory (bloatHit / seed-hiding).
- Do NOT delete or move any pipeline-state file (PRD.md, PRP.md, tasks.json, plan/*).
