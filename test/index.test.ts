/**
 * index.test.ts — extension wiring tests (P1.M5.T1.S1).
 *
 * Validates that the default-exported factory:
 *   - does not throw on a mock ExtensionAPI
 *   - registers exactly 4 tools (sorted by name)
 *   - registers exactly 5 event handlers
 *   - works with zero-config load (getConfig().enabled === true)
 *   - when enabled=false: context pass-through + all 4 tools refuse
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockSessionManager() {
  return {
    getSessionId: vi.fn(() => "test-session-id"),
    getEntries: vi.fn(() => []),
    buildContextEntries: vi.fn(() => []),
    getBranch: vi.fn(() => []),
    getLabel: vi.fn(() => undefined),
    getContextUsage: vi.fn(() => ({ tokens: 0, characters: 0 })),
  };
}

/** Create a minimal mock ExtensionAPI that records registerTool / on calls. */
function createMockPi() {
  const registeredTools: Array<{ name: string }> = [];
  const handlers = new Map<string, Function>();

  const sessionManager = createMockSessionManager();

  const pi = {
    registerTool: vi.fn((tool: { name: string }) => {
      registeredTools.push({ name: tool.name });
    }),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    setLabel: vi.fn(),
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

  return { pi, registeredTools, handlers, sessionManager };
}

/** Create a minimal mock ExtensionContext. */
function createMockCtx(sessionManager: ReturnType<typeof createMockSessionManager>) {
  return {
    sessionManager,
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("index.ts extension wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should call the factory without throwing", async () => {
    const mod = await import("../src/index.js");
    const factory = mod.default;
    const { pi } = createMockPi();
    expect(() => factory(pi)).not.toThrow();
  });

  it("should register exactly 4 tools with correct sorted names", async () => {
    const mod = await import("../src/index.js");
    const factory = mod.default;
    const { pi, registeredTools } = createMockPi();
    factory(pi);

    const names = registeredTools.map((t) => t.name);
    expect(names).toHaveLength(4);
    expect(names.sort()).toEqual([
      "mulligan_audit",
      "mulligan_checkpoint",
      "mulligan_rewind",
      "mulligan_shrink",
    ]);
  });

  it("should register exactly 5 event handlers with correct keys", async () => {
    const mod = await import("../src/index.js");
    const factory = mod.default;
    const { pi, handlers } = createMockPi();
    factory(pi);

    const keys = [...handlers.keys()].sort();
    expect(keys).toHaveLength(5);
    expect(keys).toEqual([
      "context",
      "session_shutdown",
      "session_start",
      "tool_result",
      "turn_end",
    ]);
  });

  it("should work with zero-config load (default config)", async () => {
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.enabled).toBe(true);
    expect(config.log.file).toBeNull();
    expect(config.rewind.enabled).toBe(true);
    expect(config.shrink.enabled).toBe(true);
    expect(config.nudges.bloatReminder).toBe(true);
    expect(config.nudges.perTurnDrift).toBe(true);
  });

  it("should pass-through context when enabled=false", async () => {
    const { setConfig } = await import("../src/config.js");
    setConfig({ enabled: false });

    const mod = await import("../src/index.js");
    const factory = mod.default;
    const { pi, handlers, sessionManager } = createMockPi();
    factory(pi);

    const contextHandler = handlers.get("context")!;
    const ctx = createMockCtx(sessionManager);
    const result = contextHandler({ messages: [{ role: "user", content: "hi" }] }, ctx);
    // When disabled, contextHandler returns undefined (pass-through)
    expect(result).toBeUndefined();

    // Reset config for other tests
    setConfig({ enabled: true });
  });

  it("should refuse all 4 tools when enabled=false", async () => {
    const { setConfig } = await import("../src/config.js");
    setConfig({ enabled: false });

    // Import tools directly and call execute with disabled config
    const { makeRewindTool } = await import("../src/tools/rewind.js");
    const { makeShrinkTool } = await import("../src/tools/shrink.js");
    const { makeCheckpointTool } = await import("../src/tools/checkpoint.js");
    const { auditTool } = await import("../src/tools/audit.js");

    const { pi, sessionManager } = createMockPi();
    const ctx = createMockCtx(sessionManager);

    const piApi = pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

    // mulligan_rewind should refuse
    const rewindTool = makeRewindTool(piApi);
    const rewindResult = await (rewindTool as any).execute(
      "tc-1",
      {
        note: {
          what_happened: "test",
          avoid: "test",
          true_current_state: "test",
          next: "test",
        },
        granularity: "last_tool_call_group",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(rewindResult.content[0].text).toContain("refused");
    expect(rewindResult.content[0].text).toContain("disabled");

    // mulligan_shrink should refuse
    const shrinkTool = makeShrinkTool(piApi);
    const shrinkResult = await (shrinkTool as any).execute(
      "tc-2",
      {
        target: { by_tool_name: "read", occurrence: "last" },
        replacement: "summary",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(shrinkResult.content[0].text).toContain("refused");
    expect(shrinkResult.content[0].text).toContain("disabled");

    // mulligan_checkpoint should refuse
    const checkpointTool = makeCheckpointTool(piApi);
    const checkpointResult = await (checkpointTool as any).execute(
      "tc-3",
      { name: "test" },
      undefined,
      undefined,
      ctx,
    );
    expect(checkpointResult.content[0].text).toContain("refused");
    expect(checkpointResult.content[0].text).toContain("disabled");

    // mulligan_audit should refuse
    const auditResult = await (auditTool as any).execute(
      "tc-4",
      {},
      undefined,
      undefined,
      ctx,
    );
    expect(auditResult.content[0].text).toContain("refused");
    expect(auditResult.content[0].text).toContain("disabled");

    // Reset config for other tests
    setConfig({ enabled: true });
  });
});
