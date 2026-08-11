/**
 * filter.test.ts — unit suite for src/filter.ts (readMarkers + contextHandler).
 * Vitest globals mode. Uses fake-ctx fakes mirrored from test/markers.test.ts.
 *
 * Covers: readMarkers bucketing/latest-metric/skip-malformed/never-throws,
 * contextHandler disabled-pass-through/transform+cache/F-rewind-core-mechanic/
 * shrink-mechanic/F-failopen/C12-fresh-read/branchEntries-reversal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  contextHandler,
  readMarkers,
  type MarkersBundle,
} from "../src/filter.js";
import { clearAll } from "../src/runtime.js";
import { setLogFile } from "../src/log.js";
import { setConfig } from "../src/config.js";
import { runtime } from "../src/runtime.js";
import { appendFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, ContextEvent } from "@earendil-works/pi-coding-agent";

// We use `any` for message field assertions in tests because the ContextEvent.messages
// type is a union of specific Pi AgentMessage variants (UserMessage, AssistantMessage, etc.)
// and our fake messages are plain objects that don't satisfy all union members' constraints.
// eslint-disable-next-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  clearAll();
  setLogFile(null);
});

afterEach(() => {
  clearAll();
  setLogFile(null);
  // Restore config to default enabled state
  setConfig(undefined);
});

// ── Fakes (mirror test/markers.test.ts) ────────────────────────────────────

function makeCtx(opts: {
  sessionId?: string;
  entries?: unknown[];
  branch?: unknown[];
  throwOnGetEntries?: boolean;
  throwOnGetBranch?: boolean;
  throwOnGetSessionId?: boolean;
} = {}): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";
  const entries = opts.entries ?? [];
  const branch = opts.branch ?? entries;

  return {
    sessionManager: {
      getSessionId: () => {
        if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
        return sessionId;
      },
      getEntries: () => {
        if (opts.throwOnGetEntries) throw new Error("getEntries boom");
        return entries;
      },
      getBranch: () => {
        if (opts.throwOnGetBranch) throw new Error("getBranch boom");
        return branch;
      },
    },
  } as unknown as ExtensionContext;
}

function makeEvent(messages: unknown[]): ContextEvent {
  return { type: "context", messages } as unknown as ContextEvent;
}

// ── Entry builders ──────────────────────────────────────────────────────────

function rewindEntry(
  seq: number,
  overrides?: Partial<{
    granularity: string;
    excludeToolCallId: string;
    checkpoint: string;
    options: { to_previous_prompt?: boolean };
  }>,
) {
  return {
    type: "custom",
    customType: "mulligan:rewind",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "rewind",
      id: `rw-${seq}`,
      seq,
      ts: Date.now(),
      granularity: overrides?.granularity ?? "last_tool_call_group",
      options: overrides?.options ?? {},
      excludeToolCallId: overrides?.excludeToolCallId,
      checkpoint: overrides?.checkpoint,
      note: { what_happened: "test", avoid: "test", true_current_state: "test", next: "test" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
    },
  };
}

function shrinkEntry(
  seq: number,
  overrides?: Partial<{
    target: { by_tool_call_id: string };
    replacement: string;
  }>,
) {
  return {
    type: "custom",
    customType: "mulligan:shrink",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "shrink",
      id: `sh-${seq}`,
      seq,
      ts: Date.now(),
      target: overrides?.target ?? { by_tool_call_id: "X" },
      replacement: overrides?.replacement ?? "SUMMARY",
    },
  };
}

function metricEntry(seq: number, overrides?: Partial<{ deltaTokens: number | null; turnIndex: number }>) {
  return {
    type: "custom",
    customType: "mulligan:turn-metric",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "turn-metric",
      seq,
      ts: Date.now(),
      deltaTokens: overrides?.deltaTokens ?? 100,
      bloatHit: false,
      bloatHits: [],
      grewOverThreshold: false,
      turnIndex: overrides?.turnIndex ?? 0,
    },
  };
}

function noteEntry() {
  // Notes are custom_message (type !== "custom") — should be skipped by readMarkers
  return {
    type: "custom_message",
    customType: "mulligan:note",
    data: { schema: "pi-mulligan", v: 1, kind: "note" },
  };
}

function labelEntry(name: string) {
  // Checkpoints are labels (type !== "custom") — should be skipped by readMarkers
  return {
    type: "label",
    targetId: "entry-1",
    label: `mulligan:checkpoint:${name}`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// readMarkers suite
// ════════════════════════════════════════════════════════════════════════════

describe("readMarkers", () => {
  it("empty entries → {rewinds:[], shrinks:[], metric:null}", () => {
    const ctx = makeCtx({ entries: [] });
    const result = readMarkers(ctx);
    expect(result).toEqual({ rewinds: [], shrinks: [], metric: null });
  });

  it("buckets mulligan:rewind & mulligan:shrink by customType+kind", () => {
    const ctx = makeCtx({
      entries: [rewindEntry(1), shrinkEntry(2)],
    });
    const result = readMarkers(ctx);
    expect(result.rewinds).toHaveLength(1);
    expect(result.rewinds[0].seq).toBe(1);
    expect(result.shrinks).toHaveLength(1);
    expect(result.shrinks[0].seq).toBe(2);
  });

  it("picks latest metric by highest seq (seq 3 & 7 → metric.seq===7)", () => {
    const ctx = makeCtx({
      entries: [metricEntry(3), metricEntry(7), metricEntry(5)],
    });
    const result = readMarkers(ctx);
    expect(result.metric).not.toBeNull();
    expect(result.metric!.seq).toBe(7);
  });

  it("metric is null when no turn-metrics present", () => {
    const ctx = makeCtx({
      entries: [rewindEntry(1)],
    });
    const result = readMarkers(ctx);
    expect(result.metric).toBeNull();
  });

  it("ignores custom_message (note) and label (checkpoint) — type !== 'custom'", () => {
    const ctx = makeCtx({
      entries: [noteEntry(), labelEntry("test"), rewindEntry(1)],
    });
    const result = readMarkers(ctx);
    expect(result.rewinds).toHaveLength(1);
    expect(result.shrinks).toHaveLength(0);
    expect(result.metric).toBeNull();
  });

  it("skips malformed entries (data not record / wrong kind / unknown customType) without throwing", () => {
    const ctx = makeCtx({
      entries: [
        // data is not a record
        { type: "custom", customType: "mulligan:rewind", data: "not-a-record" },
        // wrong kind
        { type: "custom", customType: "mulligan:rewind", data: { kind: "shrink", seq: 1 } },
        // unknown mulligan:* type
        { type: "custom", customType: "mulligan:cancel", data: { kind: "cancel", seq: 1 } },
        // valid rewind after malformed
        rewindEntry(2),
      ],
    });
    const result = readMarkers(ctx);
    expect(result.rewinds).toHaveLength(1);
    expect(result.rewinds[0].seq).toBe(2);
    expect(result.shrinks).toHaveLength(0);
  });

  it("NEVER throws when getBranch throws → returns empty bundle", () => {
    const ctx = makeCtx({ throwOnGetBranch: true });
    expect(() => readMarkers(ctx)).not.toThrow();
    const result = readMarkers(ctx);
    expect(result).toEqual({ rewinds: [], shrinks: [], metric: null });
  });

  it("skips entries without customType or with non-string customType", () => {
    const ctx = makeCtx({
      entries: [
        { type: "custom", customType: 42, data: { kind: "rewind", seq: 1 } },
        { type: "custom", data: { kind: "rewind", seq: 2 } },
        rewindEntry(3),
      ],
    });
    const result = readMarkers(ctx);
    expect(result.rewinds).toHaveLength(1);
    expect(result.rewinds[0].seq).toBe(3);
  });

  it("skips entries with customType not starting with 'mulligan:'", () => {
    const ctx = makeCtx({
      entries: [
        { type: "custom", customType: "other:entry", data: { kind: "rewind", seq: 1 } },
        rewindEntry(2),
      ],
    });
    const result = readMarkers(ctx);
    expect(result.rewinds).toHaveLength(1);
    expect(result.rewinds[0].seq).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// contextHandler suite
// ════════════════════════════════════════════════════════════════════════════

describe("contextHandler", () => {
  // (h) DISABLED: setConfig({enabled:false}) → result===undefined, no cache write
  it("returns undefined (pass-through) when config.enabled === false and does NOT write rt.lastFiltered", () => {
    setConfig({ enabled: false });
    const ctx = makeCtx({ sessionId: "s-disabled" });
    const messages = [{ role: "user", content: "hello" }];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeUndefined();
    // Verify no cache pollution
    const rt = runtime("s-disabled");
    expect(rt.lastFiltered).toBeNull();
  });

  // (i) NO MARKERS: messages round-trip → {messages} same length; cache set
  it("no markers: round-trips messages, sets rt.lastFiltered and rt.lastFilterTs", () => {
    const ctx = makeCtx({ sessionId: "s-nomarkers" });
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(2);
    // Cache check
    const rt = runtime("s-nomarkers");
    expect(rt.lastFiltered).toHaveLength(2);
    expect(rt.lastFilterTs).not.toBeNull();
    expect(typeof rt.lastFilterTs).toBe("number");
    expect(rt.lastFilterTs!).toBeLessThanOrEqual(Date.now());
  });

  // (j) F-rewind-core MECHANIC: canary tool group removed, rewind's own group kept
  it("F-rewind-core: removes canary tool group but keeps rewind's own group + note", () => {
    const ctx = makeCtx({
      sessionId: "s-rewind",
      entries: [
        rewindEntry(1, {
          granularity: "last_tool_call_group",
          excludeToolCallId: "R",
        }),
      ],
    });

    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "X", name: "bash", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "X", content: "CANARY-BLOAT" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "R", name: "mulligan_rewind", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "R", content: "ok" },
      {
        role: "custom",
        customType: "mulligan:note",
        content: "note text",
        details: { schema: "pi-mulligan", v: 1, kind: "note", rewindId: "rw-1" },
      },
    ];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.messages).toBeDefined();

    const filtered = result!.messages!;

    // User message survives
    expect(filtered.some((m: any) => (m as any).role === "user")).toBe(true);

    // Canary tool group (X) is REMOVED
    expect(filtered.some((m) => {
      const msg = m as any;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return msg.content.some((b: any) => b.type === "toolCall" && b.id === "X");
      }
      return false;
    })).toBe(false);
    expect(filtered.some((m) => (m as any).role === "toolResult" && (m as any).toolCallId === "X")).toBe(false);

    // Rewind's own group (R) is KEPT
    expect(filtered.some((m) => {
      const msg = m as any;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return msg.content.some((b: any) => b.type === "toolCall" && b.id === "R");
      }
      return false;
    })).toBe(true);
    expect(filtered.some((m) => (m as any).role === "toolResult" && (m as any).toolCallId === "R")).toBe(true);

    // Note (mulligan:note) is KEPT
    expect(filtered.some((m) => (m as any).customType === "mulligan:note")).toBe(true);

    // No orphan toolCall/toolResult (pairing intact)
    const toolCalls = filtered.filter((m) => {
      const msg = m as any;
      return msg.role === "assistant" && Array.isArray(msg.content) &&
        msg.content.some((b: any) => b.type === "toolCall");
    });
    const callIds = new Set<string>();
    for (const m of toolCalls) {
      for (const b of (m as any).content) {
        if (b.type === "toolCall") callIds.add(b.id);
      }
    }
    const toolResults = filtered.filter((m) => (m as any).role === "toolResult");
    for (const tr of toolResults) {
      expect(callIds.has((tr as any).toolCallId)).toBe(true);
    }
  });

  // (k) SHRINK MECHANIC: content replaced, role/toolCallId preserved
  it("shrink: replaces content of targeted message, preserves role and toolCallId", () => {
    const ctx = makeCtx({
      sessionId: "s-shrink",
      entries: [
        shrinkEntry(1, {
          target: { by_tool_call_id: "X" },
          replacement: "SUMMARY",
        }),
      ],
    });

    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "X", content: "huge output", toolName: "bash" },
    ];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    const filtered = result!.messages!;

    // Find the toolResult with toolCallId X
    const shrunk = filtered.find((m) => (m as any).toolCallId === "X");
    expect(shrunk).toBeDefined();
    expect((shrunk as any)!.role).toBe("toolResult");
    expect((shrunk as any)!.toolCallId).toBe("X");
    // Content should be replaced
    expect((shrunk as any)!.content).toEqual([{ type: "text", text: "SUMMARY" }]);
  });

  // (l) F-failopen: forced exception → undefined, no throw, no cache overwrite
  it("F-failopen: forced exception returns undefined, does not throw, does not overwrite rt.lastFiltered", () => {
    // Use throwOnGetBranch because getSessionId() runs first and succeeds, then
    // runtime() succeeds, then readMarkers() succeeds (getEntries doesn't throw),
    // but getBranch().slice().reverse() throws
    const ctx = makeCtx({ throwOnGetBranch: true, sessionId: "s-failopen" });
    const messages = [{ role: "user", content: "hi" }];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeUndefined();
    // rt.lastFiltered should NOT be overwritten (stays null)
    const rt = runtime("s-failopen");
    expect(rt.lastFiltered).toBeNull();
  });

  it("F-failopen: logs error to JSONL when log file is set", () => {
    const logPath = join(tmpdir(), `mulligan-failopen-test-${Date.now()}.jsonl`);
    // Create the file so it exists before log writes to it
    appendFileSync(logPath, "");
    setLogFile(logPath);

    const ctx = makeCtx({ throwOnGetBranch: true, sessionId: "s-log" });
    const messages = [{ role: "user", content: "hi" }];
    const event = makeEvent(messages);

    contextHandler(event, ctx);

    // Read the log file and check for the error entry
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    const errorLine = lines.find((l: string) => l.includes('"filter.fire"'));

    expect(errorLine).toBeDefined();
    const parsed = JSON.parse(errorLine!);
    expect(parsed.event).toBe("filter.fire");
    expect(parsed.level).toBe("error");
    expect(parsed.sessionId).toBe("s-log");

    // Cleanup
    setLogFile(null);
    try { unlinkSync(logPath); } catch { /* ignore */ }
  });

  // (m) C12 FRESH READ: second call reflects mutated entries
  it("C12 fresh-read: second call reflects mutated entries between calls", () => {
    let entries: unknown[] = [];
    const ctx = makeCtx({
      sessionId: "s-fresh",
      entries: [], // overridden below
    });

    // Override getEntries AND getBranch to capture the mutable array
    const mutableEntries: unknown[] = [];
    (ctx.sessionManager as any).getEntries = () => mutableEntries;
    (ctx.sessionManager as any).getBranch = () => mutableEntries;

    // First call — no markers
    const messages = [{ role: "user", content: "hi" }];
    const event1 = makeEvent(messages);
    const result1 = contextHandler(event1, ctx);

    expect(result1).toBeDefined();
    expect(result1!.messages).toHaveLength(1);

    // Now add a shrink marker
    mutableEntries.push(shrinkEntry(1, {
      target: { by_tool_call_id: "X" },
      replacement: "SHRUNK",
    }));

    // Second call with messages that include the targeted toolResult
    const messages2 = [
      { role: "user", content: "hi" },
      { role: "toolResult", toolCallId: "X", content: "big content", toolName: "bash" },
    ];
    const event2 = makeEvent(messages2);
    const result2 = contextHandler(event2, ctx);

    expect(result2).toBeDefined();
    // The shrink should have been applied (content replaced)
    const toolResult = result2!.messages!.find((m) => (m as any).toolCallId === "X");
    expect(toolResult).toBeDefined();
    expect((toolResult as any)!.content).toEqual([{ type: "text", text: "SHRUNK" }]);
  });

  // (n) BRANCHENTRIES REVERSAL: checkpoint rewind resolves with reversed branch
  it("branchEntries reversal: checkpoint rewind resolves correctly with reversed getBranch output", () => {
    // getBranch returns LEAF→ROOT; contextHandler reverses it to ROOT→LEAF.
    // resolveCheckpoint scans ROOT→LEAF in REVERSE (leaf→root) to find the most-recent label.
    // After reversal: [entry-1 (root msg), entry-3 (leaf msg), cp-1 (label)]
    // REVERSE scan finds cp-1 at index 2 (leaf-most label wins).
    // Walk context-producing entries: entry-1 (msgCursor 0→1, matches targetId → iTarget=0),
    // entry-3 (msgCursor 1→2). Remove indices > 0 → removes assistant. ✓
    const branchLeafToRoot = [
      { type: "message", id: "entry-3", parentId: "entry-1" },
      { type: "label", id: "cp-1", parentId: "entry-1", targetId: "entry-1", label: "mulligan:checkpoint:my-cp" },
      { type: "message", id: "entry-1", parentId: null },
      rewindEntry(1, {
        granularity: "checkpoint",
        checkpoint: "my-cp",
      }),
    ];

    const ctx = makeCtx({
      sessionId: "s-branch",
      entries: [
        rewindEntry(1, {
          granularity: "checkpoint",
          checkpoint: "my-cp",
        }),
      ],
      branch: branchLeafToRoot, // LEAF→ROOT (Pi's getBranch return) — includes the rewind marker for readMarkers
    });

    // Messages: [user (entry-1), assistant1 (entry-3)]
    const messages = [
      { role: "user", content: "original task" },
      { role: "assistant", content: "extra response to rewind" },
    ];
    const event = makeEvent(messages);

    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    // The checkpoint rewind should remove the assistant message (after entry-1)
    // but keep the user message (entry-1 is the checkpoint target)
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages![0].role).toBe("user");
  });
});
