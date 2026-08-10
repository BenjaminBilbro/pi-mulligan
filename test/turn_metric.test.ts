/**
 * turn_metric.test.ts — unit suite for src/nudges.ts Pi-coupled handlers
 *   (bloatReminderHandler + turnEndMetricHandler). Uses fake pi + fake ctx.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bloatReminderHandler,
  turnEndMetricHandler,
} from "../src/nudges.js";
import { clearAll, runtime } from "../src/runtime.js";
import { setLogFile } from "../src/log.js";
import { setConfig } from "../src/config.js";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  clearAll();
  setLogFile(null);
});

afterEach(() => {
  clearAll();
  setLogFile(null);
  setConfig(undefined);
});

// ── Fakes ──────────────────────────────────────────────────────────────────

interface FakePi {
  appended: Array<{ customType: string; data: unknown }>;
  sent: Array<{ customType: string; content: string; display: boolean; details: unknown }>;
  pi: ExtensionAPI;
}

function makePi(opts: { throwOnAppend?: boolean } = {}): FakePi {
  const appended: FakePi["appended"] = [];
  const sent: FakePi["sent"] = [];

  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      if (opts.throwOnAppend) throw new Error("appendEntry boom");
      appended.push({ customType, data: data ?? null });
    },
    sendMessage: (msg: { customType: string; content: string; display: boolean; details: unknown }) => {
      sent.push(msg);
    },
  } as unknown as ExtensionAPI;

  return { appended, sent, pi };
}

function makeToolCtx(opts: {
  sessionId?: string;
  throwOnGetSessionId?: boolean;
  contextUsageTokens?: number | null;
} = {}): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";

  return {
    sessionManager: {
      getSessionId: () => {
        if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
        return sessionId;
      },
    },
    getContextUsage: () =>
      opts.contextUsageTokens !== undefined
        ? { tokens: opts.contextUsageTokens, contextWindow: 200000, percent: null }
        : undefined,
  } as unknown as ExtensionContext;
}

function makeTurnEndCtx(opts: {
  sessionId?: string;
  throwOnGetSessionId?: boolean;
  contextUsageTokens?: number | null;
} = {}): ExtensionContext {
  return makeToolCtx(opts);
}

// ── Helper: generate a content block array of >= targetBytes ────────────────

function bigContentBlocks(targetBytes: number): Array<{ type: "text"; text: string }> {
  const chunk = "x".repeat(1024); // 1 KB chunk
  const count = Math.ceil(targetBytes / 1024);
  return Array.from({ length: count }, () => ({ type: "text", text: chunk }));
}

// ════════════════════════════════════════════════════════════════════════════
// bloatReminderHandler suite
// ════════════════════════════════════════════════════════════════════════════

describe("bloatReminderHandler", () => {
  it(">8KB text result → returns {content} with appended [mulligan] block; pendingBloatHits length 1", () => {
    const ctx = makeToolCtx({ sessionId: "s-bloat" });
    const blocks = bigContentBlocks(9000);
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;

    const result = bloatReminderHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.content).toBeDefined();
    expect(result!.content!.length).toBe(blocks.length + 1);
    // Last block is the reminder
    const lastBlock = result!.content![result!.content!.length - 1];
    expect(lastBlock.type).toBe("text");
    expect((lastBlock as { text: string }).text).toContain("[mulligan]");
    // Original blocks preserved (append, not replace)
    expect(result!.content![0]).toBe(blocks[0]);

    // pendingBloatHits recorded
    const rt = runtime("s-bloat");
    expect(rt.pendingBloatHits).toHaveLength(1);
    expect(rt.pendingBloatHits[0].toolName).toBe("read");
    expect(typeof rt.pendingBloatHits[0].approxTokens).toBe("number");
  });

  it("<8KB result → returns undefined, pendingBloatHits empty", () => {
    const ctx = makeToolCtx({ sessionId: "s-small" });
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: [{ type: "text", text: "small result" }],
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;

    const result = bloatReminderHandler(event, ctx);

    expect(result).toBeUndefined();
    const rt = runtime("s-small");
    expect(rt.pendingBloatHits).toEqual([]);
  });

  it("mulligan_* toolName → undefined (skip own tools)", () => {
    const ctx = makeToolCtx({ sessionId: "s-skip" });
    const blocks = bigContentBlocks(9000);
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "mulligan_rewind",
    } as unknown as ToolResultEvent;

    const result = bloatReminderHandler(event, ctx);

    expect(result).toBeUndefined();
    const rt = runtime("s-skip");
    expect(rt.pendingBloatHits).toEqual([]);
  });

  it("config.enabled=false → undefined, no measurement", () => {
    setConfig({ enabled: false });
    const ctx = makeToolCtx({ sessionId: "s-disabled" });
    const blocks = bigContentBlocks(9000);
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;

    expect(bloatReminderHandler(event, ctx)).toBeUndefined();
    expect(runtime("s-disabled").pendingBloatHits).toEqual([]);
  });

  it("config.nudges.bloatReminder=false → undefined, no measurement", () => {
    setConfig({ nudges: { bloatReminder: false } });
    const ctx = makeToolCtx({ sessionId: "s-nobloat" });
    const blocks = bigContentBlocks(9000);
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;

    expect(bloatReminderHandler(event, ctx)).toBeUndefined();
    expect(runtime("s-nobloat").pendingBloatHits).toEqual([]);
  });

  it("throwOnGetSessionId → caught, returns undefined (fail-open)", () => {
    const ctx = makeToolCtx({ throwOnGetSessionId: true });
    const blocks = bigContentBlocks(9000);
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;

    expect(() => bloatReminderHandler(event, ctx)).not.toThrow();
    expect(bloatReminderHandler(event, ctx)).toBeUndefined();
  });

  it("F-shrink-preventive: bloat handler then turnEndMetricHandler → metric bloatHit===true", () => {
    const fakePi = makePi();
    const bloatCtx = makeToolCtx({ sessionId: "s-fbloat" });
    const blocks = bigContentBlocks(9000);

    // Drive bloat handler
    const bloatEvent = {
      type: "tool_result",
      toolCallId: "c1",
      input: {},
      content: blocks,
      isError: false,
      toolName: "read",
    } as unknown as ToolResultEvent;
    bloatReminderHandler(bloatEvent, bloatCtx);

    // Drive turn_end handler
    const rt = runtime("s-fbloat");
    rt.tokenBaseline = 1000; // set a baseline so delta is computable
    rt.lastFiltered = [{ role: "user", content: "a".repeat(400) }]; // ~100 tokens

    const turnEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "done" },
      toolResults: [],
    } as unknown as TurnEndEvent;
    const turnCtx = makeTurnEndCtx({ sessionId: "s-fbloat" });

    turnEndMetricHandler(fakePi.pi, turnEvent, turnCtx);

    // appendTurnMetric should have been called with bloatHit===true
    expect(fakePi.appended).toHaveLength(1);
    expect(fakePi.appended[0].customType).toBe("mulligan:turn-metric");
    const data = fakePi.appended[0].data as Record<string, unknown>;
    expect(data.bloatHit).toBe(true);
    expect((data.bloatHits as Array<unknown>).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// turnEndMetricHandler suite
// ════════════════════════════════════════════════════════════════════════════

describe("turnEndMetricHandler", () => {
  it("builds metric with deltaTokens = now − baseline when baseline is set", () => {
    const fakePi = makePi();
    const sessionId = "s-delta";
    const ctx = makeTurnEndCtx({ sessionId });

    const rt = runtime(sessionId);
    rt.tokenBaseline = 2000;
    // lastFiltered will have ~500 tokens worth of content (2000 chars / 4 chars per token)
    rt.lastFiltered = [{ role: "user", content: "x".repeat(2000) }];

    const event = {
      type: "turn_end",
      turnIndex: 2,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(1);
    const data = fakePi.appended[0].data as Record<string, unknown>;
    // deltaTokens = 500 (estimateTokens of 2000 chars) - 2000 = -1500
    expect(data.deltaTokens).toBe(500 - 2000);
  });

  it("deltaTokens is null when tokenBaseline is null (first turn)", () => {
    const fakePi = makePi();
    const sessionId = "s-null-delta";
    const ctx = makeTurnEndCtx({ sessionId });

    // tokenBaseline stays null (default)
    const rt = runtime(sessionId);
    expect(rt.tokenBaseline).toBeNull();
    rt.lastFiltered = [{ role: "user", content: "hello" }];

    const event = {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(1);
    const data = fakePi.appended[0].data as Record<string, unknown>;
    expect(data.deltaTokens).toBeNull();
  });

  it("appendTurnMetric called exactly once with 5 data fields (no seq/envelope in arg)", () => {
    const fakePi = makePi();
    const sessionId = "s-fields";
    const ctx = makeTurnEndCtx({ sessionId });

    const rt = runtime(sessionId);
    rt.tokenBaseline = 1000;
    rt.lastFiltered = [{ role: "user", content: "x".repeat(16000) }]; // ~4000 tokens
    rt.pendingBloatHits = [{ toolName: "read", approxTokens: 2000 }];

    const event = {
      type: "turn_end",
      turnIndex: 5,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(1);
    const data = fakePi.appended[0].data as Record<string, unknown>;

    // The 5 DATA fields (appendTurnMetric stamps schema/v/kind/seq/ts)
    expect(data.deltaTokens).toBe(4000 - 1000); // 3000
    expect(data.bloatHit).toBe(true);
    expect((data.bloatHits as Array<unknown>).length).toBe(1);
    expect(data.grewOverThreshold).toBe(false); // 3000 > 3000 is false, need > threshold
    expect(data.turnIndex).toBe(5);
  });

  it("grewOverThreshold is true when delta > driftThresholdTokens", () => {
    const fakePi = makePi();
    const sessionId = "s-grow";
    const ctx = makeTurnEndCtx({ sessionId });

    const rt = runtime(sessionId);
    rt.tokenBaseline = 1000;
    // Make content large enough: 16000 chars = ~4000 tokens, delta = 4000-1000 = 3000
    // Need > 3000 (default threshold), so make delta = 3001+
    // 16004 chars / 4 = 4001 tokens, delta = 4001-1000 = 3001 > 3000 ✓
    rt.lastFiltered = [{ role: "user", content: "x".repeat(16004) }];

    const event = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    const data = fakePi.appended[0].data as Record<string, unknown>;
    expect(data.grewOverThreshold).toBe(true);
  });

  it("rt.tokenBaseline rolled to 'now' and rt.lastTurnIndex set", () => {
    const fakePi = makePi();
    const sessionId = "s-roll";
    const ctx = makeTurnEndCtx({ sessionId });

    const rt = runtime(sessionId);
    rt.tokenBaseline = 500;
    rt.lastFiltered = [{ role: "user", content: "x".repeat(2000) }]; // ~500 tokens

    const event = {
      type: "turn_end",
      turnIndex: 7,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(rt.tokenBaseline).toBe(500); // estimateTokens of 2000 chars = 500 tokens
    expect(rt.lastTurnIndex).toBe(7);
  });

  it("pendingBloatHits cleared to [] after snapshot", () => {
    const fakePi = makePi();
    const sessionId = "s-clear";
    const ctx = makeTurnEndCtx({ sessionId });

    const rt = runtime(sessionId);
    rt.tokenBaseline = 1000;
    rt.lastFiltered = [{ role: "user", content: "hello" }];
    rt.pendingBloatHits = [{ toolName: "read", approxTokens: 2000 }];

    const event = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(rt.pendingBloatHits).toEqual([]);
    // But the metric captured the bloat hits
    const data = fakePi.appended[0].data as Record<string, unknown>;
    expect(data.bloatHit).toBe(true);
    expect((data.bloatHits as Array<unknown>).length).toBe(1);
  });

  it("config.enabled=false → no-ops (no appendTurnMetric call)", () => {
    setConfig({ enabled: false });
    const fakePi = makePi();
    const ctx = makeTurnEndCtx({ sessionId: "s-off" });

    const event = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(0);
  });

  it("config.nudges.perTurnDrift=false → no-ops", () => {
    setConfig({ nudges: { perTurnDrift: false } });
    const fakePi = makePi();
    const ctx = makeTurnEndCtx({ sessionId: "s-no-drift" });

    const event = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(0);
  });

  it("fail-open on throw (throwing getSessionId → no throw, no append)", () => {
    const fakePi = makePi();
    const ctx = makeTurnEndCtx({ throwOnGetSessionId: true });

    const event = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    expect(() =>
      turnEndMetricHandler(fakePi.pi, event, ctx),
    ).not.toThrow();
    expect(fakePi.appended).toHaveLength(0);
  });

  it("falls back to getContextUsage().tokens when lastFiltered is null", () => {
    const fakePi = makePi();
    const sessionId = "s-fallback";
    const ctx = makeTurnEndCtx({ sessionId, contextUsageTokens: 8000 });

    const rt = runtime(sessionId);
    // lastFiltered stays null, tokenBaseline stays null
    expect(rt.lastFiltered).toBeNull();

    const event = {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", content: "" },
      toolResults: [],
    } as unknown as TurnEndEvent;

    turnEndMetricHandler(fakePi.pi, event, ctx);

    expect(fakePi.appended).toHaveLength(1);
    const data = fakePi.appended[0].data as Record<string, unknown>;
    // deltaTokens is null because tokenBaseline is null
    expect(data.deltaTokens).toBeNull();
    // but the metric was still persisted (bloatHit=false, grewOverThreshold=false)
    expect(data.bloatHit).toBe(false);
  });
});
