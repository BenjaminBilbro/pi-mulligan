# Research notes — P1.M5.T1.S1 (Wire index.ts factory)

## Task
Wire all P1.M1–M4 modules into `src/index.ts` (the extension default-export factory) + create
`test/index.test.ts`. The factory registers 4 tools, attaches 4 handlers (session_start, context,
tool_result, turn_end) + session_shutdown, and wires config/runtime. Output: a loadable extension
that works zero-config (`pi -e ./src/index.ts` with NO `mulligan` settings).

## Codebase state (verified 2026-08-10)
- `src/index.ts` is currently a 3-line NO-OP stub: `export default function (pi: ExtensionAPI) {}`.
- ALL dependency modules are shipped + unit-tested (594 tests green, 18 files):
  - config.ts → `getConfig()`, `setConfig(raw)`, `DEFAULT_CONFIG`
  - log.ts → `setLogFile(path|null)`, `log/logInfo/...`
  - runtime.ts → `runtime(arg)`, `resetRuntime(id)`, `clearAll()`, `nextSeq(rt)`
  - filter.ts → `contextHandler(event, ctx): ContextEventResult|void`  ← exports handler DIRECTLY (NO registerFilterHelper seam)
  - nudges.ts → `registerBloatReminder(pi)` (pi.on tool_result), `registerTurnEndMetric(pi)` (pi.on turn_end)
  - tools/rewind.ts → `makeRewindTool(pi): ToolDefinition`
  - tools/shrink.ts → `makeShrinkTool(pi): ToolDefinition`
  - tools/checkpoint.ts → `makeCheckpointTool(pi): ToolDefinition`
  - tools/audit.ts → `auditTool` (PLAIN CONST — needs NO pi; read-only)
- `test/index.test.ts` does NOT exist (must be created). `test/integration/load.test.ts` is a placeholder.

## CRITICAL scope decision — NO settings.ts in our v1
- The sibling oracle (`/home/dustin/projects/pi-mulligan/src/index.ts`) imports `loadMulliganConfig`
  from `./settings.js` and calls `setConfig(loadMulliganConfig(cwd))` at factory time + in session_start.
- BUT our task graph has NO settings.ts task (M1 = scaffold/config/log/runtime only). The config PRP
  (P1.M1.T2.S1) explicitly resolved: "there is NO Pi settings accessor on ExtensionAPI/ExtensionContext
  in Pi 0.84.x ... v1 ships zero-config: `setConfig(undefined)` → defaults." settings.ts was a LATER
  oracle evolution (BUG-001 repair, P1.M1.T1.S2) — NOT our scope.
- THEREFORE our index.ts must NOT invent/import a settings loader. Config flows via lazy `getConfig()`
  (cached DEFAULT_CONFIG). The factory calls `setLogFile(getConfig().log.file)` to point the logger
  (null default → off). Re-read-on-/reload is a no-op in v1 (defaults); document as known v1 limitation.

## Wiring contract (spec/11 §8 Step 8; spec/01 §1; spec/03 §2; spec/05 §5)
```ts
export default function (pi: ExtensionAPI): void {
  setLogFile(getConfig().log.file);                 // point logger (after cache populated by getConfig)
  pi.registerTool(makeRewindTool(pi));              // factory captures pi via closure
  pi.registerTool(makeShrinkTool(pi));
  pi.registerTool(makeCheckpointTool(pi));
  pi.registerTool(auditTool);                        // plain const, NO pi
  pi.on("context", contextHandler);                  // inline (filter.ts exports the handler, not a seam)
  registerBloatReminder(pi);                         // pi.on("tool_result", …)  — Nudge A
  registerTurnEndMetric(pi);                         // pi.on("turn_end", …)     — Nudge B Phase 1
  pi.on("session_start", (_e, ctx) => {              // init fresh runtime (tokenBaseline=null via freshRuntime)
    resetRuntime(ctx.sessionManager.getSessionId()); // C12: read sessionId fresh, never cache handle
  });
  pi.on("session_shutdown", () => { clearAll(); });  // full process teardown
}
```

## FORBIDDEN in index.ts (D8, C2 — spec/02)
- NO `pi.sendUserMessage` (extension msgs bypass command dispatch)
- NO `pi.registerCommand` (no human commands)
- NO `pi.registerShortcut` / `registerFlag` (out of scope)
- A grep over src/index.ts for these three must return nothing.

## Type compatibility (verified)
- `ExtensionHandler<E,R> = (event:E, ctx:ExtensionContext) => Promise<R|void>|R|void`
- `contextHandler(event:ContextEvent, ctx:ExtensionContext): ContextEventResult|void` ↔ `pi.on("context", …)` ✓
- Event names confirmed in pi 0.84.1 .d.ts: session_start, session_shutdown, context, tool_result, turn_end ✓
- `defineTool` + `ToolDefinition` exported from `@earendil-works/pi-coding-agent` root ✓
- Factory is SYNC (spec/01 §1: async allowed but unnecessary; Mulligan has no long-lived resources).
- No try/catch around wiring → fail-FAST on bootstrap errors (handlers self-protect fail-open).

## Disabled-config behavior (E14) — for test assertions
All 4 tools check `if (!config.enabled) return refusal("Mulligan is disabled", …)` → text prefix
`"Mulligan: refused — Mulligan is disabled."`. contextHandler returns `undefined` (pass-through, no
cache write) when `config.enabled===false`. setConfig({enabled:false}) in test toggles it.

## Test mock pattern (hand-rolled, mirrors test/tools/rewind.test.ts makePi)
Fake `pi` capturing: `registeredTools: ToolDefinition[]` (from registerTool) + `handlers:
Map<string, Function>` (from on). Assert: 4 tools named [mulligan_rewind, mulligan_shrink,
mulligan_checkpoint, mulligan_audit]; handlers keys include context/tool_result/turn_end/session_start/
session_shutdown; factory does not throw; zero-config loads (no setConfig before factory).
Disabled: setConfig({enabled:false}) → captured context handler returns undefined; each tool's
execute returns "Mulligan: refused — Mulligan is disabled.".

## Validation commands (verified working)
- `npx tsc --noEmit` → currently EXIT 0 (will re-verify after wiring).
- `npx vitest run` → 594 tests green currently.
- `pi -e ./src/index.ts -p "hi"` → EXIT 0 with current stub (zero-config load proven; pi 0.84.1 on PATH).

## DOCS impact
None per-file (this is wiring). README is P1.M5.T4 (Mode B changeset-level doc). This PRP surfaces
that explicitly so it is not silently dropped.
