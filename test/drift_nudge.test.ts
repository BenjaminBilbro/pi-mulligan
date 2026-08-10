/**
 * drift_nudge.test.ts — unit suite for filter.ts Phase-2 nudge injection path.
 * Tests contextHandler with metric entries that trigger/suppress the drift nudge,
 * F-nudge-drift end-to-end, and zero-persist assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { contextHandler, type MarkersBundle } from "../src/filter.js";
import { NUDGE_TURN_WINDOW_MS } from "../src/nudges.js";
import { clearAll } from "../src/runtime.js";
import { setLogFile } from "../src/log.js";
import { setConfig } from "../src/config.js";
import type { ExtensionContext, ContextEvent } from "@earendil-works/pi-coding-agent";

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

function makeCtx(opts: {
  sessionId?: string;
  entries?: unknown[];
  branch?: unknown[];
} = {}): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";
  const entries = opts.entries ?? [];
  const branch = opts.branch ?? [];

  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
}

function makeEvent(messages: unknown[]): ContextEvent {
  return { type: "context", messages } as unknown as ContextEvent;
}

// ── Entry builders ──────────────────────────────────────────────────────────

function metricEntry(
  seq: number,
  overrides?: Partial<{
    deltaTokens: number | null;
    bloatHit: boolean;
    grewOverThreshold: boolean;
    turnIndex: number;
    ts: number;
  }>,
) {
  return {
    type: "custom",
    customType: "mulligan:turn-metric",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "turn-metric",
      seq,
      ts: overrides?.ts ?? Date.now(),
      deltaTokens: overrides?.deltaTokens ?? null,
      bloatHit: overrides?.bloatHit ?? false,
      bloatHits: [],
      grewOverThreshold: overrides?.grewOverThreshold ?? false,
      turnIndex: overrides?.turnIndex ?? 0,
    },
  };
}

function rewindEntry(seq: number, overrides?: Partial<{ ts: number }>) {
  return {
    type: "custom",
    customType: "mulligan:rewind",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "rewind",
      id: `rw-${seq}`,
      seq,
      ts: overrides?.ts ?? Date.now(),
      granularity: "last_tool_call_group",
      options: {},
      note: { what_happened: "test", avoid: "test", true_current_state: "test", next: "test" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
    },
  };
}

function shrinkEntry(seq: number, overrides?: Partial<{ ts: number }>) {
  return {
    type: "custom",
    customType: "mulligan:shrink",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "shrink",
      id: `sh-${seq}`,
      seq,
      ts: overrides?.ts ?? Date.now(),
      target: { by_tool_call_id: "X" },
      replacement: "SUMMARY",
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// drift nudge injection
// ════════════════════════════════════════════════════════════════════════════

describe("drift nudge injection via contextHandler", () => {
  const baseMessages = [{ role: "user", content: "hello" }];

  it("metric with grewOverThreshold:true → returned messages end with mulligan:nudge", () => {
    const ctx = makeCtx({
      sessionId: "s-drift",
      entries: [
        metricEntry(1, { grewOverThreshold: true, deltaTokens: 5000 }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toBeDefined();
    const msgs = result!.messages!;
    // Should have original message + nudge
    expect(msgs.length).toBeGreaterThan(baseMessages.length);

    const last = msgs[msgs.length - 1] as unknown as Record<string, unknown>;
    expect(last.customType).toBe("mulligan:nudge");
    expect(last.content).toContain("[mulligan]");
  });

  it("metric with bloatHit:true (deltaTokens null) → nudge STILL fires (bloat arm)", () => {
    const ctx = makeCtx({
      sessionId: "s-bloat-nudge",
      entries: [
        metricEntry(1, { bloatHit: true, deltaTokens: null, grewOverThreshold: false }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    const msgs = result!.messages!;
    const last = msgs[msgs.length - 1] as unknown as Record<string, unknown>;
    expect(last.customType).toBe("mulligan:nudge");
  });

  it("metric with grewOverThreshold:false AND bloatHit:false → NO nudge appended", () => {
    const ctx = makeCtx({
      sessionId: "s-no-nudge",
      entries: [
        metricEntry(1, { grewOverThreshold: false, bloatHit: false }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(baseMessages.length);
  });

  it("config.nudges.perTurnDrift=false → no nudge even if metric warrants", () => {
    setConfig({ nudges: { perTurnDrift: false } });
    const ctx = makeCtx({
      sessionId: "s-drift-off",
      entries: [
        metricEntry(1, { grewOverThreshold: true, deltaTokens: 5000 }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(baseMessages.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// suppression
// ════════════════════════════════════════════════════════════════════════════

describe("drift nudge suppression", () => {
  const baseMessages = [{ role: "user", content: "hello" }];
  // NUDGE_TURN_WINDOW_MS imported at module level

  it("rewindEntry ts in-window → SUPPRESSED (no nudge)", () => {
    const metricTs = Date.now();
    const rewindTs = metricTs - NUDGE_TURN_WINDOW_MS / 2; // 5 minutes before metric → in window

    const ctx = makeCtx({
      sessionId: "s-suppress",
      entries: [
        metricEntry(1, { grewOverThreshold: true, ts: metricTs }),
        rewindEntry(2, { ts: rewindTs }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(baseMessages.length); // no nudge appended
  });

  it("rewindEntry ts older than window → nudge DOES fire", () => {
    const metricTs = Date.now();
    const rewindTs = metricTs - NUDGE_TURN_WINDOW_MS - 1000; // outside window

    const ctx = makeCtx({
      sessionId: "s-older",
      entries: [
        metricEntry(1, { grewOverThreshold: true, ts: metricTs }),
        rewindEntry(2, { ts: rewindTs }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    const msgs = result!.messages!;
    const last = msgs[msgs.length - 1] as unknown as Record<string, unknown>;
    expect(last.customType).toBe("mulligan:nudge");
  });

  it("shrinkEntry ts in-window → SUPPRESSED", () => {
    const metricTs = Date.now();
    const shrinkTs = metricTs - NUDGE_TURN_WINDOW_MS / 2;

    const ctx = makeCtx({
      sessionId: "s-shrink-suppress",
      entries: [
        metricEntry(1, { grewOverThreshold: true, ts: metricTs }),
        shrinkEntry(2, { ts: shrinkTs }),
      ],
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(baseMessages.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// zero-persist
// ════════════════════════════════════════════════════════════════════════════

describe("zero-persist: mulligan:nudge is ephemeral (never persisted)", () => {
  const baseMessages = [{ role: "user", content: "hello" }];

  it("nudge appears ONLY in returned messages; entries contain no mulligan:nudge", () => {
    const entries = [
      metricEntry(1, { grewOverThreshold: true, deltaTokens: 5000 }),
    ];
    const ctx = makeCtx({
      sessionId: "s-zero-persist",
      entries,
    });
    const event = makeEvent(baseMessages);

    const result = contextHandler(event, ctx);

    // Nudge IS in the returned messages
    expect(result).toBeDefined();
    const msgs = result!.messages!;
    const last = msgs[msgs.length - 1] as unknown as Record<string, unknown>;
    expect(last.customType).toBe("mulligan:nudge");

    // Entries do NOT contain mulligan:nudge (only the turn-metric)
    const readEntries = ctx.sessionManager.getEntries();
    const hasNudgeEntry = readEntries.some(
      (e: unknown) =>
        typeof e === "object" && e !== null &&
        (e as Record<string, unknown>).type === "custom" &&
        (e as Record<string, unknown>).customType === "mulligan:nudge",
    );
    expect(hasNudgeEntry).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F-nudge-drift end-to-end
// ════════════════════════════════════════════════════════════════════════════

describe("F-nudge-drift: >3000-delta metric → next context.fire ends with mulligan:nudge", () => {
  it("end-to-end: large delta → nudge injected on next inference", () => {
    const ctx = makeCtx({
      sessionId: "s-e2e",
      entries: [
        metricEntry(1, {
          grewOverThreshold: true,
          deltaTokens: 4200,
          turnIndex: 3,
        }),
      ],
    });

    const messages = [
      { role: "user", content: "original task" },
      { role: "assistant", content: "did a bunch of work" },
    ];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    const msgs = result!.messages!;
    // Original messages preserved
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    // Nudge appended at end
    expect(msgs.length).toBe(3);
    const nudge = msgs[2] as unknown as Record<string, unknown>;
    expect(nudge.customType).toBe("mulligan:nudge");
    expect(nudge.role).toBe("custom");
    expect(nudge.display).toBe(false);
    expect((nudge.details as Record<string, unknown>).ephemeral).toBe(true);
    expect(nudge.content).toContain("[mulligan]");
    expect(nudge.content).toContain("tokens");
  });
});
