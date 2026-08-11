# Research — P1.M1.T2.S1 (Wire factory + session_start handler to call setConfig)

## 0. Dependency status (CONFIRMED SHIPPED)
- `src/settingsLoader.ts` EXISTS and exports `loadMulliganSettings(opts?: { cwd?: string; isTrusted?: boolean }): unknown`
  and the type `LoadMulliganSettingsOptions`. (Read in full — it is the exact contract P1.M1.T1.S1 specified.)
- `test/settingsLoader.test.ts` EXISTS. Baseline `npm test` = **652 passed | 2 skipped** (was 635 pre-S1; S1 added its
  tests). GREEN. `npx tsc --noEmit -p tsconfig.json` = EXIT 0. GREEN.
- `src/config.ts` exports `setConfig(raw: unknown): void` (sets `cachedConfig = validateConfig(raw)`; never throws — on
  any error resets to `validateConfig(undefined)`), `getConfig(): MulliganConfig` (returns a fresh structuredClone every
  call), and `validateConfig`/`DEFAULT_CONFIG`. **config.ts is ALREADY CORRECT — it was just never fed real input.**

## 1. Current src/index.ts (the ONLY file this task modifies)
Current imports (lines 18–28):
```ts
import { getConfig } from "./config.js";
import { setLogFile } from "./log.js";
import { resetRuntime, clearAll } from "./runtime.js";
import { contextHandler } from "./filter.js";
... (tools)
```
Current factory body order:
1. `setLogFile(getConfig().log.file);`
2–5. register 4 tools
6. `pi.on("context", contextHandler);`
7. `registerBloatReminder(pi);`
8. `registerTurnEndMetric(pi);`
9. `pi.on("session_start", (event, ctx) => { resetRuntime(ctx.sessionManager.getSessionId()); });`
10. `pi.on("session_shutdown", () => { clearAll(); });`

Factory signature: `export default function (pi: ExtensionAPI): void` — SYNCHRONOUS, no ctx param (the factory
receives ONLY `pi: ExtensionAPI`; cwd/isProjectTrusted live on ExtensionContext, available only inside handlers).

## 2. The exact wiring this task adds
### (a) Imports
- Change `import { getConfig } from "./config.js";` → `import { getConfig, setConfig } from "./config.js";`
- Add `import { loadMulliganSettings } from "./settingsLoader.js";`

### (b) Factory body — setConfig at TOP, BEFORE setLogFile
```ts
export default function (pi: ExtensionAPI): void {
  // 0. Global-only best-effort config read (no cwd yet — factory has no ctx). NEVER breaks load.
  try { setConfig(loadMulliganSettings({})); } catch { /* never break load */ }

  // 1. Configure structured JSONL logger from the just-read config
  setLogFile(getConfig().log.file);
  ... (rest unchanged)
```

### (c) session_start handler — setConfig BEFORE resetRuntime + re-call setLogFile AFTER
```ts
pi.on("session_start", (event, ctx) => {
  // Full read (cwd + trust) on EVERY reason (startup|reload|new|resume|fork). NEVER breaks session start.
  try { setConfig(loadMulliganSettings({ cwd: ctx.cwd, isTrusted: ctx.isProjectTrusted() })); } catch { /* never break session start */ }
  resetRuntime(ctx.sessionManager.getSessionId());
  // re-read log.file so a /reload that changed it takes effect (it was read once at factory time)
  setLogFile(getConfig().log.file);
});
```

## 3. CRITICAL — the existing test/index.test.ts test that BREAKS (must be updated in THIS task)
Baseline `npx vitest run test/index.test.ts` = 6/6 GREEN today. After wiring, ONE test breaks:

**"should pass-through context when enabled=false"** (test/index.test.ts). Current body:
```ts
setConfig({ enabled: false });        // (1) cachedConfig = {enabled:false,...}
const mod = await import("../src/index.js");
const factory = mod.default;
factory(pi);                           // (2) factory now calls setConfig(loadMulliganSettings({}))
                                       //     → reads REAL ~/.pi/agent/settings.json (NO mulligan key, confirmed §4)
                                       //     → undefined → setConfig(undefined) → cachedConfig = DEFAULT_CONFIG (enabled:TRUE)
const contextHandler = handlers.get("context")!;
const result = contextHandler({ messages: [...] }, ctx);
expect(result).toBeUndefined();        // (3) FAILS: enabled is now true → contextHandler returns {messages}, not undefined
```
**Root cause:** `vi.resetModules()` (beforeEach) resets all modules; the test imports config.js (fresh, cachedConfig=null),
sets enabled:false, then invokes the factory — which now OVERWRITES cachedConfig by reading the real global file
(confirmed: no mulligan key → DEFAULT_CONFIG → enabled:true).

**Fix (minimal, hermetic):** reorder — invoke `factory(pi)` FIRST (so the factory-time read settles to DEFAULT_CONFIG
from the real global file — deterministic on this machine since the global file has no mulligan key), THEN call
`setConfig({ enabled: false })` AFTER the factory, so the disabled config is the LAST thing set before the
contextHandler assertion. This preserves the test's intent (enabled:false → pass-through) without mocking node:os/fs.

The "should refuse all 4 tools when enabled=false" test does NOT break — it imports the individual tool modules
(`../src/tools/rewind.js` etc.), NOT `../src/index.js`, so the factory is never invoked and `setConfig({enabled:false})`
stands. Confirmed by reading that test body.

The "should work with zero-config load (default config)" test does NOT break — the factory-time read of the real
global file (no mulligan key) → DEFAULT_CONFIG, which satisfies `config.enabled === true` etc.

The "registers exactly 5 event handlers" / "4 tools" / "factory does not throw" tests do NOT break — they assert
structure, not config-dependent behavior.

## 4. Confirmed: real global settings.json has NO mulligan key
`/home/dustin/.pi/agent/settings.json` exists; keys include `lastChangelogVersion, packages, defaultProvider,
defaultModel, defaultThinkingLevel, externalEditor, theme, hideThinkingBlock, retry, piVim`. **NO `mulligan` key.**
Therefore `loadMulliganSettings({})` → `readMulliganKey(~/.pi/agent/settings.json)` → file parses, no mulligan
own-key → returns `undefined` → `setConfig(undefined)` → `validateConfig(undefined)` → `isRecord(undefined)===false`
→ returns `structuredClone(DEFAULT_CONFIG)`. So the factory-time read deterministically yields DEFAULT_CONFIG on this
machine. (This is exactly why the "pass-through enabled=false" test must set disabled config AFTER the factory.)

## 5. session_start handler — `event` and `ctx` shapes (do NOT read event.reason)
- `SessionStartEvent.reason` = `"startup"|"reload"|"new"|"resume"|"fork"` (external_deps.md §4, types.d.ts:418).
  Contract: re-read on ALL reasons (cheapest correct; reload is a subset). So do NOT branch on `event.reason`; just
  always call setConfig. `event` is therefore unused in the handler body (it was already unused before this task).
- `ctx.cwd: string` (types.d.ts:217), `ctx.isProjectTrusted(): boolean` (types.d.ts:234) — both on ExtensionContext,
  the 2nd handler arg. Pass them straight through to loadMulliganSettings.

## 6. Synchronous invariant (D8) — do NOT add async/await
The factory is `export default function (pi: ExtensionAPI): void` (NOT async). setConfig, loadMulliganSettings,
setLogFile, getConfig are ALL synchronous. Adding async/await would change the factory's return type to
`Promise<void>` and violate D8 (the spec mandates a synchronous factory). Verified: none of the called functions
return a Promise.

## 7. Never-break-load / never-break-session-start (try/catch discipline)
Both new setConfig calls are wrapped in `try { ... } catch { /* swallow */ }`. setConfig itself never throws (it has
its own internal try/catch → validateConfig(undefined)), and loadMulliganSettings never throws (its own try/catch per
readMulliganKey), so the outer try/catch is belt-and-suspenders defense-in-depth (matches config.ts/log.ts/settingsLoader.ts
fail-open discipline). A failure here MUST NOT prevent tool registration (factory) or runtime reset (session_start).

## 8. Why re-call setLogFile after setConfig in session_start
`log.file` is read once at factory time (`setLogFile(getConfig().log.file)`). On `/reload`, the user may have edited
`.pi/settings.json` to change `mulligan.log.file`. The session_start handler re-reads config (via setConfig), so it
MUST also re-call `setLogFile(getConfig().log.file)` for the new path to take effect. Without this, a reload would
update the config cache but NOT the logger destination. (design_decisions.md BUG-001+BUG-006 does not spell this out,
but the task contract §3b explicitly requires it; log.ts:setLogFile is idempotent and cheap.)

## 9. Scope boundaries (what NOT to touch)
- `src/config.ts` — UNCHANGED (validateConfig/setConfig/getConfig already correct).
- `src/settingsLoader.ts` — UNCHANGED (shipped by P1.M1.T1.S1; consumed as-is).
- `src/log.ts`, `src/runtime.ts`, `src/filter.ts`, `src/nudges.ts`, `src/tools/*` — UNCHANGED.
- README §3 edit — Mode B (changeset-level doc sync, deferred to the final task). This task only VERIFIES behavior.

## 10. DOCS impact
README §3's claims ("loaded lazily... re-read on /reload" and "Disabling") BECOME TRUE once this wiring lands. The
README text edit is Mode B (P1.M5.T1); here we only verify the behavior is now correct. Surfaced so docs are not
silently dropped.

## 11. Downstream consumer
P1.M1.T2.S2 writes the deterministic integration test (tmp `.pi/settings.json` with `mulligan.enabled=false` → assert
all four tools refuse). That test depends on THIS task's wiring being in place. S1 does not write that integration
test (scope boundary — would collide with S2).
