# Research — P1.M4.T1.S1 — Register non-mulligan big-result test tool + bloatHit assertion (BUG-007)

## What this task is
Make F-shrink-preventive's `bloatHit:true` a DETERMINISTIC HARD assertion (today it is SOFT / "unprovable
in this harness"). `bloatReminderHandler` (src/nudges.ts) skips every tool whose name starts with `mulligan_`,
so the existing `mulligan_smoke_big` can NEVER fire the bloat reminder. Fix = register a NEW non-`mulligan_*`
test tool whose result exceeds the resolved threshold, drive a real `tool_result` through it, and assert
`bloatHit:true` in the turn-metric. Keep `mulligan_smoke_big` unchanged (shrink-target canary).

## Files touched (verified)
- `test/integration/smoke.ts` — register `smoke_read_big` (NEW) in the factory; update the `F-shrink-preventive`
  case in `driveScenario` (currently calls `bigResult()` locally, which is USELESS for bloat — a local fn call
  does NOT fire the `tool_result` event).
- `test/integration/run-smoke.mjs` — drive a model prompt that calls `smoke_read_big`; upgrade
  `assertShrinkPreventive` to assert `turn-metric.data.bloatHit === true` HARD (drop the `soft` field).
- `test/integration/scenarios.md` — Mode A doc: rewrite the F-shrink-preventive note from "unprovable in this
  harness" to the new deterministic (model-called-tool) path.

## CRITICAL verified facts

### 1. The real default threshold (config.ts) — NOT what smoke.ts comments claim
`src/config.ts` `DEFAULT_CONFIG.nudges.bloatThresholdBytes = 8192` (single global; NO per-tool thresholds in v1).
The smoke.ts comments that say "global 16384; per-tool read 24576, bash = global 16384" are INACCURATE — those
"new defaults" are not in config.ts. The work item's note ("verify against config.ts; if absent, the single
global 8192 threshold applies") is correct: **8192 is the threshold**. So `smoke_read_big` must return > 8192
BYTES. `resultBytes` (src/tokens.ts) measures UTF-8 byte length of each `text` content block. A 10000-ASCII-char
string = 10000 bytes > 8192. ✓ (Pad to ~10KB as the work item suggests.)

### 2. The bloatReminderHandler skip line (verified)
`src/nudges.ts` `bloatReminderHandler`:
```ts
const tn = event.toolName;
if (typeof tn === "string" && tn.startsWith("mulligan_")) return;  // ← skips mulligan_* tools
const bytes = resultBytes(event.content as unknown as ResultContentBlock[]);
if (bytes < config.nudges.bloatThresholdBytes) return;  // ← under threshold → no-op
// else: append [mulligan] reminder block + rt.pendingBloatHits.push({toolName, approxTokens})
```
So the tool name MUST NOT start with `mulligan_`. `smoke_read_big` satisfies this. `event.toolName` is the
registered tool's `name` field.

### 3. SPIKE PROOF (run 2026-08-11 against this repo + glm-5.2)
A throwaway extension registering `smoke_read_big` (returns "SMOKE-BLOAT-CANARY " + "x".repeat(10000)) was
loaded as `-e ./src/index.ts -e /tmp/spike.ts` and driven with `-p "Call the smoke_read_big tool, then reply
with exactly: DONE"`. Results from the session JSONL:
- `smoke_read_big` toolResult present (count=1) → **the model called the non-mulligan tool**.
- turn-metric #1: `"bloatHit":true`, `"bloatHits":[{"toolName":"smoke_read_big","approxTokens":2505}]`.
- `[mulligan]` reminder appended to the tool_result (count=1) → bloatReminderHandler FIRED on the real event.
- turn-metric #2 (next turn): `bloatHit:false` (no bloat) — confirms the metric is per-turn.

**Conclusion:** registering `smoke_read_big` + driving a model prompt that calls it DETERMINISTICALLY yields
`turn-metric.data.bloatHit === true` with `bloatHits` naming `smoke_read_big`. This is the HARD assertion target.

### 4. Why the tool_result event REQUIRES the model (no fully model-free path)
`bloatReminderHandler` fires on Pi's `tool_result` EVENT, which Pi dispatches ONLY when the agent loop executes
a registered tool (i.e. the MODEL emitted a toolCall). There is NO extension-facing API to synthesize a
`tool_result` event or to invoke a registered tool through the executor from a `/cmd` handler (verified:
ExtensionAPI has `registerTool`/`on`/`appendEntry`/`sendMessage`/`setLabel`/`sendUserMessage` only — no
`executeTool`/`invokeTool`). And calling `bloatReminderHandler` directly from the smoke helper would mutate the
SMOKE helper's config/runtime instances (jiti gives each `-e` extension a SEPARATE module cache — verified in
smoke.ts comments), NOT Mulligan's, so no real bloatHit would land in Mulligan's turn-metric. **Therefore the
sanctioned path is the model-prompt approach** (explicitly allowed by the work item: "via a model prompt or by
invoking the tool through pi"). The model prompt "Call the smoke_read_big tool, then reply with exactly: OK"
reliably triggers the call with glm-5.2 (spike-proven).

### 5. This task is INDEPENDENT of M1/M2 (verified)
- `dependencies: []` in tasks.json. The default `bloatThresholdBytes=8192` applies with NO config customization
  (the repo's `.pi/settings.json` has no `mulligan` key → defaults). M1 (config wiring) HAS landed in
  `src/index.ts` (it calls `loadMulliganSettings`), but this task does not rely on it — the default threshold
  suffices.
- Does NOT touch `transforms.ts`/`markers.ts`/`filter.ts` (M2 pinning territory) or `rewind.ts`/`audit.ts`.
- Sibling M4.T2 (hasNudge) depends on M1 (low drift threshold via project-local settings); M4.T3 (hard
  seed-hiding) depends on M2 (pinned targets). This task touches NONE of those regions.

## The smoke harness shape (relevant slice, verified)
- `smoke.ts` loads SECOND (`-e ./src/index.ts -e ./test/integration/smoke.ts`); its `context` handler is an
  OBSERVER (returns void; logs `context.fire`). Mulligan's filter runs FIRST.
- `run-smoke.mjs` `runPi(scenario, { prompts })` spawns `pi -ne -e ./src/index.ts -e ./test/integration/smoke.ts
  --session-id smoke-<scenario>-<RUN_ID> ... -p <p1> -p <p2>`. Custom `prompts` already used for F-rewind-core
  (3-prompt SEED) and F-checkpoint (5-prompt SET/SEED/REWIND). F-shrink-preventive currently uses the default
  2-prompt flow (`/mulligan_smoke F-shrink-preventive` + `Reply with exactly: OK`).
- `assertShrinkPreventive({ smoke, piRes })` reads `readSessionEntries(smoke.sessionFile)`; currently asserts
  `tool.smoke_big logged` + `turn-metric exists` (HARD) and returns `soft: "bloatHit:true requires the model
  to call mulligan_smoke_big..."`. The turn-metric entry shape on disk:
  `{"type":"custom","customType":"mulligan:turn-metric","data":{"schema":"pi-mulligan","v":1,"kind":"turn-metric",
  "seq":N,"ts":...,"deltaTokens":...,"bloatHit":true,"bloatHits":[{"toolName":"smoke_read_big","approxTokens":2505}],
  "grewOverThreshold":...,"turnIndex":...}}`.

## Implementation plan (dependency-ordered)
1. **smoke.ts factory** — add `pi.registerTool({ name:"smoke_read_big", ... parameters: Type.Object({}),
   async execute() { return { content:[{type:"text",text: BLOAT_CANARY + " " + "x".repeat(10000)}] } } })`.
   Name MUST NOT start with `mulligan_`. Keep `mulligan_smoke_big` UNCHANGED.
2. **smoke.ts driveScenario `F-shrink-preventive`** — replace the useless `bigResult()` local call with an info
   log that `smoke_read_big` is registered and will be called by the model prompt (the orchestrator drives it).
   Optionally keep a `tool.smoke_big` info log for the mulligan_smoke_big canary.
3. **run-smoke.mjs runScenario `F-shrink-preventive`** — use a custom `prompts` array:
   `["/mulligan_smoke F-shrink-preventive", "Call the smoke_read_big tool, then reply with exactly: OK"]`.
4. **run-smoke.mjs assertShrinkPreventive** — add a HARD assertion: read turn-metric entries, assert SOME has
   `data.bloatHit === true` (and optionally `data.bloatHits` includes `toolName:"smoke_read_big"`). Drop the
   `soft` field from the return.
5. **scenarios.md F-shrink-preventive** — rewrite the "unprovable in this harness" note to the new deterministic
   path (non-mulligan `smoke_read_big`, model-called, bloatHit:true asserted HARD from the turn-metric).

## Validation gates (verified working in this env)
- `npx tsc --noEmit -p tsconfig.json` → 0 (smoke.ts IS typechecked — tsconfig includes "test").
- `npm test` → 697 passed | 2 skipped (must stay green; smoke.ts/run-smoke.mjs are NOT vitest tests, so the
  suite is unaffected as long as tsc passes).
- `npm run smoke` → must be 9/9 with F-shrink-preventive now asserting bloatHit:true HARD (no SOFT line).
  Requires `pi` on PATH + a working model (glm-5.2 default; spike-proven).

## Gotchas
- smoke.ts imports use `.js` extensions (ESM Bundler). The new tool registration uses the same `Type.Object({})`
  + `async execute()` shape as `mulligan_smoke_big` (copy it, change name + remove the mulligan_ prefix).
- The turn-metric is appended at `turn_end` by MULLIGAN's `turnEndMetricHandler` (src/nudges.ts), which snapshots
  `rt.pendingBloatHits` (populated by `bloatReminderHandler` on the tool_result event). Both must be enabled
  (default `config.nudges.bloatReminder=true`, `perTurnDrift=true`). Defaults apply — no config change needed.
- Do NOT delete `mulligan_smoke_big` or change its name — it is the shrink-target canary for F-shrink-persist
  (RESULT_CANARY observable). The new `smoke_read_big` is ADDITIONAL.
- The model prompt must explicitly name `smoke_read_big` ("Call the smoke_read_big tool..."). A vague prompt
  ("read a big file") would call Pi's built-in `read` instead, which is a DIFFERENT tool.
