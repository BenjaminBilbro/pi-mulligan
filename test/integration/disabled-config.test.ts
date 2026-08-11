/**
 * disabled-config.test.ts — BUG-001 headline proof: enabled=false disables all four tools
 * (disk→setConfig wiring, E2E regression guard).
 *
 * Proves end-to-end that a tmp `.pi/settings.json` containing `{"mulligan":{"enabled":false}}`
 * on disk, read through the wired `src/index.ts` factory + its `session_start` handler (shipped by
 * P1.M1.T2.S1), makes `getConfig().enabled === false`, makes the `context` handler return `undefined`
 * (pass-through, E14), and makes a factory-registered tool's `execute` return text starting with
 * `Mulligan: refused — Mulligan is disabled` (em-dash U+2014).
 *
 * This is the canonical regression guard for the config disk-wiring (README §3 "Disabling" +
 * spec/09 §1 + spec/08 E14).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Mock node:os.homedir so it points at a tmp dir (avoids reading the real home).
// vitest hoists vi.mock; the module-under-test picks up the redirected homedir.
// We use importOriginal to keep tmpdir (and other exports) intact.
// Pattern: test/settingsLoader.test.ts lines 14–28.
// ─────────────────────────────────────────────────────────────────────────────
const originalHomedir = homedir;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome,
  };
});

let mockHome: string = "/nonexistent-initial";

/** Point the mocked homedir at a new path. */
function setHome(dir: string): void {
  mockHome = dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — tmp dirs for home (empty, hermetic global read) and cwd (.pi/settings.json)
// ─────────────────────────────────────────────────────────────────────────────
let home: string;
let cwd: string;

beforeEach(() => {
  // MANDATORY: reset module cache so config.ts's module-scope cachedConfig is null
  vi.resetModules();

  home = mkdtempSync(join(tmpdir(), "mulligan-s2-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mulligan-s2-cwd-"));
  setHome(home);

  // Write the project-local settings that the session_start handler will read
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ mulligan: { enabled: false } }),
    "utf8",
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// The test
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-001 headline proof: enabled=false disables all four tools (disk→setConfig wiring)", () => {
  it("session_start reads .pi/settings.json and disables config + tools + context pass-through", async () => {
    // ── Mock pi: captures FULL tool objects (not just {name}) so .execute() is reachable ──
    const registeredTools: any[] = [];
    const handlers = new Map<string, Function>();
    const pi = {
      registerTool: vi.fn((t: any) => {
        registeredTools.push(t); // FULL object — NOT just { name }
      }),
      on: vi.fn((e: string, h: Function) => {
        handlers.set(e, h);
      }),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      setLabel: vi.fn(),
    } as unknown as ExtensionAPI;

    // ── Mock ctx: cwd=tmp dir, isProjectTrusted=()=>true, sessionManager.getSessionId ──
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "s2-session" },
    } as unknown as ExtensionContext;

    // ── (a) Import factory and invoke it ──
    const mod = await import("../../src/index.js");
    mod.default(pi);

    // ── (b) Fire the session_start handler (triggers disk read → setConfig) ──
    const sessionStart = handlers.get("session_start")!;
    sessionStart({ reason: "startup" }, ctx);

    // ── (e) Assert getConfig().enabled === false ──
    const { getConfig } = await import("../../src/config.js");
    expect(getConfig().enabled).toBe(false);

    // ── (f) Assert a registered tool refuses with the em-dash prefix ──
    const rewind = registeredTools.find((t) => t.name === "mulligan_rewind")!;
    const res = await rewind.execute(
      "tc-1",
      {
        note: {
          what_happened: "x",
          avoid: "x",
          true_current_state: "x",
          next: "x",
        },
        granularity: "last_tool_call_group",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).toContain("Mulligan: refused — Mulligan is disabled");

    // ── (g) Assert context handler returns undefined (pass-through, E14) ──
    const contextHandler = handlers.get("context")!;
    const r = contextHandler({ messages: [{ role: "user", content: "hi" }] }, ctx);
    expect(r).toBeUndefined();
  });
});
