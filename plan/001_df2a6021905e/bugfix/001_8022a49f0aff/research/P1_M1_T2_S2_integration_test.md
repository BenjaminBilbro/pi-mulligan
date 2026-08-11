# Research — P1.M1.T2.S2 (Integration test: enabled=false disables all four tools — BUG-001 headline proof)

## 0. Dependency status (CONFIRMED SHIPPED)
- **P1.M1.T2.S1 (wiring) is DONE.** `src/index.ts` factory body now opens with
  `try { setConfig(loadMulliganSettings({})); } catch { /* never break load */ }` and its
  `session_start` handler now calls `try { setConfig(loadMulliganSettings({ cwd: ctx.cwd, isTrusted: ctx.isProjectTrusted() })); } catch {...}`
  BEFORE `resetRuntime(...)`, then re-calls `setLogFile(getConfig().log.file)`. (Read in full.)
- **P1.M1.T1.S1 (settingsLoader) is DONE.** `src/settingsLoader.ts` exports
  `loadMulliganSettings(opts?: { cwd?: string; isTrusted?: boolean }): unknown`.
- Baseline `npm test` = **652 passed | 2 skipped** (GREEN). `npx vitest run test/index.test.ts` = 6/6 GREEN.
- The existing `test/index.test.ts` "should refuse all 4 tools when enabled=false" test exercises the tools
  DIRECTLY via `setConfig({enabled:false})` — it does NOT prove the disk→setConfig wiring. This S2 task is the
  END-TO-END proof: `.pi/settings.json` on disk → factory + session_start → getConfig().enabled===false → tools refuse.

## 1. The exact contract under test (verbatim from work item + design_decisions.md)
A deterministic test that:
(a) creates a tmp dir with `.pi/settings.json` containing `{"mulligan":{"enabled":false}}`;
(b) builds a mock ctx whose `cwd` is the tmp dir and `isProjectTrusted()` returns `true`;
(c) imports the factory (`await import("../src/index.js")`), invokes it with a mock pi;
(d) fires the `session_start` handler captured in the mock with the mock ctx;
(e) asserts `getConfig().enabled === false`;
(f) invokes one registered tool's `execute` (captured from the mock pi's registerTool calls) and asserts the
    result text starts with `"Mulligan: refused — Mulligan is disabled"`;
(g) (second assertion) the `context` handler captured in the mock returns `undefined` (pass-through) when enabled=false.

Isolation: `vi.resetModules()` in beforeEach (REQUIRED — config.ts caches cachedConfig at module scope) +
`vi.mock("node:os", ...)` to redirect homedir at an empty tmp home (hermetic global read) + tmp-dir fixtures;
restore (delete the tmp settings) in afterEach.

## 2. The exact refusal string (VERIFIED in source)
All four tools call `refusal("Mulligan is disabled")` which builds:
```
`Mulligan: refused — ${reason}.`
```
→ the full text is `Mulligan: refused — Mulligan is disabled.` (with trailing period).
- The dash is an **EM-DASH, U+2014** (hex `e2 80 94`), NOT a hyphen-minus. Verified via `xxd` on src/tools/rewind.ts.
- The assertion prefix to match: `Mulligan: refused — Mulligan is disabled` (use `.startsWith(...)`; the trailing
  `.` is added by `refusal()`). The test string MUST use the same U+2014 em-dash or the assertion fails.
- Verified across all four tool files: rewind.ts:342, shrink.ts:184, checkpoint.ts:108, audit.ts:500 all do
  `if (!config.enabled) return refusal("Mulligan is disabled"[, ...])`. So ANY of the four tools can be the
  "one registered tool" in step (f); `mulligan_rewind` is the canonical choice (the headline operation).

## 3. contextHandler disabled path (VERIFIED in src/filter.ts)
```ts
export function contextHandler(event, ctx): ContextEventResult | void {
  let sessionId = "unknown";
  try {
    sessionId = ctx.sessionManager.getSessionId();   // ← called FIRST, even on the disabled path
    const config = getConfig();
    if (!config.enabled) return;                      // ← disabled → returns undefined (pass-through, no cache)
    ...
  } catch (e) { ...; return; }
}
```
- KEY: `getSessionId()` is called BEFORE the `config.enabled` check. So the mock ctx passed to the context handler
  MUST have a working `sessionManager.getSessionId()` even for the pass-through assertion. (The index.test.ts mock
  sessionManager already provides `getSessionId: vi.fn(() => "test-session-id")` — copy that.)
- When disabled, `contextHandler` returns `undefined` (the `return;` with no value). Assert with `expect(result).toBeUndefined()`.

## 4. The mock pi must capture FULL tool objects (NOT just names)
`test/index.test.ts:createMockPi()` captures only `{ name: tool.name }` in `registerTool`. That is insufficient
for step (f) — we need the registered tool's `execute` method. The integration test's mock pi MUST push the
FULL tool object passed to `registerTool`:
```ts
const registeredTools: any[] = [];
const pi = {
  registerTool: vi.fn((tool: any) => { registeredTools.push(tool); }),
  on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
  appendEntry: vi.fn(), sendMessage: vi.fn(), setLabel: vi.fn(),
} as unknown as ExtensionAPI;
```
Then find the rewind tool: `const rewind = registeredTools.find(t => t.name === "mulligan_rewind")!;`
And invoke: `const res = await rewind.execute("tc-1", validRewindParams, undefined, undefined, ctx);`
The config gate (`if (!config.enabled) return refusal(...)`) is the FIRST step in every tool's execute, so it
short-circuits before touching ctx markers — but pass a valid-shaped `ctx` regardless (defensive).

## 5. The mock ctx shape (must satisfy BOTH session_start handler AND tool execute AND contextHandler)
The session_start handler reads: `ctx.cwd`, `ctx.isProjectTrusted()`, `ctx.sessionManager.getSessionId()`.
contextHandler reads (on disabled path): `ctx.sessionManager.getSessionId()`.
The rewind tool execute reads (on disabled path): nothing beyond getConfig() — returns immediately.
So the mock ctx needs:
```ts
const ctx = {
  cwd: tmpCwd,                                   // ← the tmp dir holding .pi/settings.json
  isProjectTrusted: () => true,                  // ← so the LOCAL file is read (replaces global)
  sessionManager: { getSessionId: () => "s2-test-session" },
} as unknown as ExtensionContext;
```
Note: `isProjectTrusted` must be a FUNCTION returning `true` (settingsLoader checks `opts.isTrusted === true`,
and index.ts passes `ctx.isProjectTrusted()` — the call result). `cwd` must be the exact tmp dir string.

## 6. Hermetic global read: vi.mock("node:os", ...) — follow settingsLoader.test.ts VERBATIM
settingsLoader.ts computes the global path via `os.homedir()`. The factory's `loadMulliganSettings({})` reads the
REAL global file on this machine (confirmed: no mulligan key → DEFAULT_CONFIG). On a different machine / CI the
global file might have a mulligan key. To make the test HERMETIC and machine-independent, mock `node:os.homedir`
to an EMPTY tmp home (so the global read → undefined → DEFAULT_CONFIG), and rely on the LOCAL `.pi/settings.json`
in ctx.cwd (enabled:false) which REPLACES global per the top-level-replace merge rule.

The settingsLoader.test.ts pattern (copy it):
```ts
import { tmpdir, homedir } from "node:os";
const originalHomedir = homedir;  // (unused but mirrors the file)
let mockHome = "/nonexistent-initial";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});
function setHome(dir: string) { mockHome = dir; }
```
- `vi.mock` is hoisted by vitest to the top of the file (applies to ALL tests in the file). This is why a
  DEDICATED integration test file is cleaner than mixing into index.test.ts — the mock is scoped to this file only.
- `importOriginal` preserves `tmpdir` (we still need it for mkdtemp).
- `mockHome` is a module-level `let`; `setHome(tmpHomeDir)` is called in beforeEach AFTER mkdtemp.
- The mocked `node:os` is picked up by settingsLoader.ts (which does `import { homedir } from "node:os"`)
  THROUGH the index.ts factory import chain. Confirmed working in settingsLoader.test.ts.

NOTE: even WITHOUT mocking node:os, the test passes on this machine (global has no mulligan key → DEFAULT_CONFIG,
and local enabled:false replaces it). But mocking makes it deterministic on any machine — RECOMMENDED.

## 7. vi.resetModules() is REQUIRED (config.ts module-scope cache)
`config.ts` holds `let cachedConfig: MulliganConfig | null = null;` at module scope. Without `vi.resetModules()`
in beforeEach, a previous test's `setConfig(...)` leaks into this one (and the factory's setConfig would be a
no-op if cachedConfig is already set from a prior test in the same file). The existing `test/index.test.ts` does
`vi.resetModules()` in beforeEach — copy that. After resetModules, `await import("../src/index.js")` and
`await import("../src/config.js")` yield FRESH module instances with `cachedConfig === null`, and — critically —
index.js and config.js share the SAME fresh config module instance (config is a dependency of index), so the
factory's `setConfig` and the test's `getConfig` read/write the SAME `cachedConfig`. (Confirmed by analysis;
this is the same invariant the S1 PRP relied on.)

## 8. File placement decision: NEW dedicated file test/integration/disabled-config.test.ts
Rationale:
- It is an INTEGRATION test (fires session_start end-to-end) → `test/integration/` is the established home
  (load.test.ts, edge-cases.integration.test.ts, smoke.ts all live there).
- It needs `vi.mock("node:os")` + tmp-dir fixtures that are invasive to mix into the unit-test file
  `test/index.test.ts` (vi.mock is file-scoped/hoisted → would apply to all 6 unit tests there).
- It is "the canonical regression guard for config wiring" → a dedicated, clearly-named file is discoverable.
- It does NOT risk perturbing the 6 GREEN unit tests in index.test.ts.
- design_decisions.md suggested "extend test/index.test.ts" — that is satisfied in spirit (this is still an
  index.ts-wiring test) and S1 already touched index.test.ts. The work-item CONTRACT does not mandate the file.
Acceptable alternative: `test/index.disabled.test.ts` (alongside index.test.ts). The test body is identical;
only the path differs. The PRP specifies `test/integration/disabled-config.test.ts` as the primary path.

## 9. Test body (the deterministic sequence — validated against the real module graph)
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// hermetic global read (§6)
let mockHome = "/nonexistent-initial";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});

let home: string; let cwd: string;
beforeEach(() => {
  vi.resetModules();                                  // §7 — REQUIRED (config.ts module-scope cache)
  home = mkdtempSync(join(tmpdir(), "mulligan-s2-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mulligan-s2-cwd-"));
  mockHome = home;                                    // redirect os.homedir at the empty tmp home
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ mulligan: { enabled: false } }), "utf8");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("BUG-001 headline proof: enabled=false disables all four tools (disk→setConfig wiring)", () => {
  it("session_start reads .pi/settings.json and disables config + tools + context pass-through", async () => {
    // (c) import the factory + invoke with a mock pi that captures FULL tool objects + handlers
    const registeredTools: any[] = [];
    const handlers = new Map<string, Function>();
    const pi = {
      registerTool: vi.fn((t: any) => { registeredTools.push(t); }),
      on: vi.fn((e: string, h: Function) => { handlers.set(e, h); }),
      appendEntry: vi.fn(), sendMessage: vi.fn(), setLabel: vi.fn(),
    } as any;
    const mod = await import("../../src/index.js");    // path from test/integration/ → ../../src/index.js (2 levels up)
    mod.default(pi);                                   // (c) factory: registers tools + handlers + global read

    // (b)+(d) build mock ctx, fire session_start (triggers the full cwd+trust disk read)
    const ctx = {
      cwd,                                             // (a) tmp dir holding .pi/settings.json
      isProjectTrusted: () => true,                    // (b) so the LOCAL file is read
      sessionManager: { getSessionId: () => "s2-session" },
    } as any;
    const sessionStart = handlers.get("session_start")!;
    sessionStart({ reason: "startup" }, ctx);          // (d) fire → setConfig(loadMulliganSettings({cwd,isTrusted}))

    // (e) getConfig().enabled === false
    const { getConfig } = await import("../../src/config.js");
    expect(getConfig().enabled).toBe(false);

    // (f) one registered tool's execute returns the disabled-refusal prefix (em-dash U+2014!)
    const rewind = registeredTools.find((t) => t.name === "mulligan_rewind")!;
    const res = await rewind.execute(
      "tc-1",
      { note: { what_happened: "x", avoid: "x", true_current_state: "x", next: "x" },
        granularity: "last_tool_call_group" },
      undefined, undefined, ctx,
    );
    expect(res.content[0].text).toContain("Mulligan: refused — Mulligan is disabled");

    // (g) context handler returns undefined (pass-through) when enabled=false
    const contextHandler = handlers.get("context")!;
    const r = contextHandler({ messages: [{ role: "user", content: "hi" }] }, ctx);
    expect(r).toBeUndefined();
  });
});
```

## 10. Scope boundaries (what NOT to touch)
- `src/index.ts`, `src/config.ts`, `src/settingsLoader.ts`, `src/filter.ts`, `src/tools/*` — all UNCHANGED
  (this task writes ONLY a test file). The wiring (S1) and the disk reader (T1.S1) are already shipped.
- `test/index.test.ts` — UNCHANGED (S1 already updated it; this task adds a SEPARATE file).
- README §3 edit — Mode B (changeset-level doc sync, deferred to the final task). This task only PROVES the behavior.

## 11. DOCS impact
README §3 "Disabling" (`enabled:false` → "all four tools refuse cleanly with `Mulligan: refused — Mulligan is disabled.`")
becomes PROVEN-true by this test. The README text edit is Mode B (final changeset-level sync task) — here we only
add the regression guard. Surfaced so docs are not silently dropped.

## 12. Validation gates (verified commands)
- `npx vitest run test/integration/disabled-config.test.ts` — the new test passes (Level 2).
- `npm test` — full suite GREEN: 652 + 1 new = 653 passed | 2 skipped, zero regressions (Level 2).
- `npx tsc --noEmit -p tsconfig.json` — EXIT 0 (the new test file typechecks; Level 1).
- No Level 3/4 mechanical gates (this is a test-only task; the integration IS the gate).

## 13. Gotchas summary (information-dense)
- EM-DASH U+2014 in the refusal string — not a hyphen. Copy-paste from src/tools/rewind.ts to be safe.
- `vi.resetModules()` in beforeEach is MANDATORY (config.ts module-scope cachedConfig).
- `vi.mock("node:os")` is hoisted → use a module-level `let mockHome` + setHome in beforeEach (after mkdtemp).
- Mock pi must capture FULL tool objects (not just `{name}`) to call `.execute(...)`.
- contextHandler calls `getSessionId()` BEFORE the `config.enabled` check → mock ctx.sessionManager must provide it.
- `isProjectTrusted` must be a `() => true` function (settingsLoader compares `opts.isTrusted === true`, index.ts
  passes `ctx.isProjectTrusted()`).
- Import paths from test/integration/ are `../../src/index.js` and `../../src/config.js` (TWO levels up — test/integration/ → test/ → root → src/; confirmed by test/integration/smoke.ts using `../../src/tools/rewind.js`). ESM .js specifiers.
- The `.pi/settings.json` MUST be written BEFORE firing session_start (the handler reads it synchronously).
- The jiti double-module gotcha does NOT apply here (single module instance in vitest — confirmed external_deps.md §9).
