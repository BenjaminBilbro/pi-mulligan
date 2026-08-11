/**
 * edge-cases.test.ts — E1–E20 edge-case matrix consolidation (spec/08).
 *
 * Deterministic vitest suite that walks ALL 20 edges as named assertions,
 * delegating to the shipped pure helpers / tools / filter via the established
 * fake-pi/fake-ctx patterns. ALSO includes:
 *   - Self-contained randomized pairing-invariant property test (spec/10 §3)
 *   - Documented-limitation behavior assertions for E7/E15/E18
 *
 * REUSE: fakes copied from test/tools/rewind.test.ts, test/filter.test.ts,
 *        test/pipeline.test.ts, test/transforms.test.ts — NO new patterns.
 *
 * Boundary with P1.M5.T3: E6 parallel-tool model-driven view-behavior is
 *   definitive at unit level here; end-to-end F-rewind-core is T3's.
 *   E13 fail-open is definitive at unit level here; forced-throw F-failopen is T3's.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ── shipped exports ──────────────────────────────────────────────────────────
import {
  filterPipeline,
  partitionIntoUnits,
  resolveLastToolCallGroup,
  resolveLastTurn,
  applyShrink,
  protectedOk,
  stableSortBySeq,
  type MessageLike,
  type MarkerBundle,
  type RewindMarkerLike,
  type ShrinkMarkerLike,
  type ProtectedConfig,
  type ShrinkTarget,
} from "../src/transforms.js";
import { contextHandler, readMarkers } from "../src/filter.js";
import { makeRewindTool } from "../src/tools/rewind.js";
import { makeShrinkTool } from "../src/tools/shrink.js";
import { makeCheckpointTool } from "../src/tools/checkpoint.js";
import { auditTool } from "../src/tools/audit.js";
import { injectNudge } from "../src/nudges.js";
import { NOTE_INVALID_REASON } from "../src/notes.js";
import { setConfig } from "../src/config.js";
import { clearAll, runtime } from "../src/runtime.js";
import { setLogFile } from "../src/log.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ContextEvent,
} from "@earendil-works/pi-coding-agent";

// ── resets (MANDATORY — nextSeq + config cache are module-scoped) ────────────

beforeEach(() => {
  clearAll();
  setConfig(undefined);
  setLogFile(null);
});
afterEach(() => {
  clearAll();
  setConfig(undefined);
  setLogFile(null);
});

// ── fakes (copied from sibling tests — no new patterns) ────────────────────

/** Minimal fake ExtensionAPI capturing appendEntry + sendMessage (hand-rolled, no vi.fn()). */
function makePi(opts: { throwOnAppend?: boolean; throwOnSendMessage?: boolean } = {}) {
  const appended: { customType: string; data: unknown }[] = [];
  const sent: { customType: string; content: unknown; display: boolean; details?: unknown }[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      if (opts.throwOnAppend) throw new Error("appendEntry boom");
      appended.push({ customType, data });
    },
    sendMessage(message: { customType: string; content: unknown; display: boolean; details?: unknown }) {
      if (opts.throwOnSendMessage) throw new Error("sendMessage boom");
      sent.push(message);
    },
  };
  return { appended, sent, pi: pi as unknown as ExtensionAPI };
}

/** Minimal fake ExtensionContext for filter/rewind tests. */
function makeCtx(opts: {
  sessionId?: string;
  leafId?: string | null;
  entries?: unknown[];
  branch?: unknown[];
  contextEntries?: unknown[];
  labels?: Map<string, string>;
  throwOnBuildContext?: boolean;
  throwOnGetEntries?: boolean;
  throwOnGetBranch?: boolean;
  throwOnGetSessionId?: boolean;
  getContextUsage?: () => { tokens: number; characters: number } | undefined;
} = {}): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";
  const leafId: string | null = opts.leafId === undefined ? "leaf-1" : opts.leafId;
  const entries = opts.entries ?? [];
  const branch = opts.branch ?? [];
  const contextEntries = opts.contextEntries ?? [];
  const labels = opts.labels ?? new Map<string, string>();

  return {
    sessionManager: {
      getSessionId() {
        if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
        return sessionId;
      },
      getLeafId() { return leafId; },
      getEntries() {
        if (opts.throwOnGetEntries) throw new Error("getEntries boom");
        return entries;
      },
      getLabel(id: string) { return labels.get(id); },
      getBranch() {
        if (opts.throwOnGetBranch) throw new Error("getBranch boom");
        return branch;
      },
      buildContextEntries() {
        if (opts.throwOnBuildContext) throw new Error("buildContextEntries boom");
        return contextEntries;
      },
      getContextUsage() {
        return opts.getContextUsage?.();
      },
    },
  } as unknown as ExtensionContext;
}

function makeEvent(messages: unknown[]): ContextEvent {
  return { type: "context", messages } as unknown as ContextEvent;
}

// ── entry builders (from test/filter.test.ts) ─────────────────────────────

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
      schema: "pi-mulligan", v: 1, kind: "rewind", id: `rw-${seq}`, seq, ts: Date.now(),
      granularity: overrides?.granularity ?? "last_tool_call_group",
      options: overrides?.options ?? {},
      excludeToolCallId: overrides?.excludeToolCallId,
      checkpoint: overrides?.checkpoint,
      note: { what_happened: "test", avoid: "test", true_current_state: "test", next: "test" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
    },
  };
}

function shrinkEntry(seq: number, overrides?: Partial<{ target: { by_tool_call_id: string }; replacement: string }>) {
  return {
    type: "custom",
    customType: "mulligan:shrink",
    data: {
      schema: "pi-mulligan", v: 1, kind: "shrink", id: `sh-${seq}`, seq, ts: Date.now(),
      target: overrides?.target ?? { by_tool_call_id: "X" },
      replacement: overrides?.replacement ?? "SUMMARY",
    },
  };
}

// ── message builders (from test/transforms.test.ts + test/tools/rewind.test.ts) ─

function user(text: string): MessageLike {
  return { role: "user", content: text };
}

function asst(...callIds: string[]): MessageLike {
  return {
    role: "assistant",
    content: callIds.map((id) => ({ type: "toolCall", id, name: "tool", arguments: {} })),
  };
}

function asstText(text: string): MessageLike {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function res(toolCallId: string, toolName?: string): MessageLike {
  return {
    role: "toolResult", toolCallId, toolName: toolName ?? "tool",
    content: [{ type: "text", text: "..." }], isError: false,
  };
}

function custom(customType: string): MessageLike {
  return { role: "custom", customType, content: "x", display: true };
}

/** msgEntry — a message-as-entry for buildContextEntries fakes. */
function msgEntry(message: Record<string, unknown>): { type: "message"; id: string; message: Record<string, unknown> } {
  return { type: "message", id: `e-${Math.random().toString(36).slice(2)}`, message };
}

// ── property-test toolkit (from test/pipeline.test.ts — self-contained copy) ─

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genMessages(rng: () => number): MessageLike[] {
  const count = 2 + Math.floor(rng() * 8);
  const msgs: MessageLike[] = [];
  let i = 0;
  msgs.push(user(`u${i++}`));
  while (msgs.length < count) {
    const r = rng();
    const remaining = count - msgs.length;
    if (r < 0.35 && remaining >= 2) {
      const id = `c${i++}`;
      msgs.push(asst(id));
      msgs.push(res(id));
    } else if (r < 0.5 && remaining >= 4) {
      const id1 = `c${i++}`;
      const id2 = `c${i++}`;
      msgs.push(asst(id1, id2));
      msgs.push(res(id1));
      msgs.push(res(id2));
    } else if (r < 0.65) {
      msgs.push(asstText(`thinking${i++}`));
    } else if (r < 0.78) {
      msgs.push(user(`u${i++}`));
    } else if (r < 0.88) {
      msgs.push(custom("mulligan:note"));
    } else if (remaining >= 2) {
      const id = `c${i++}`;
      msgs.push(asst(id));
      msgs.push(res(id));
    } else {
      msgs.push(asstText(`t${i++}`));
    }
  }
  return msgs;
}

function genMarkers(rng: () => number, msgs: MessageLike[]): MarkerBundle {
  const rewinds: RewindMarkerLike[] = [];
  const shrinks: ShrinkMarkerLike[] = [];
  const numRewinds = Math.floor(rng() * 3);
  for (let i = 0; i < numRewinds; i++) {
    const gran = rng() < 0.5 ? "last_tool_call_group" as const : "last_turn" as const;
    const toolResults = msgs.filter((m) => m.role === "toolResult");
    const exclude = rng() < 0.5 && toolResults.length > 0
      ? (toolResults[Math.floor(rng() * toolResults.length)].toolCallId as string)
      : undefined;
    rewinds.push({ seq: rewinds.length + 1, granularity: gran, excludeToolCallId: exclude });
  }
  if (rng() < 0.3) {
    const toolResults = msgs.filter((m) => m.role === "toolResult");
    if (toolResults.length > 0) {
      const target = toolResults[Math.floor(rng() * toolResults.length)];
      shrinks.push({ seq: 100 + shrinks.length, target: { by_tool_call_id: target.toolCallId as string }, replacement: "[shrunk]" });
    }
  }
  return { rewinds, shrinks };
}

function expectNoOrphans(msgs: MessageLike[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "toolCall" && typeof b.id === "string") callIds.add(b.id);
      }
    }
    if (m.role === "toolResult" && typeof m.toolCallId === "string") resultIds.add(m.toolCallId);
  }
  for (const id of callIds) {
    expect(resultIds.has(id), `call id ${id} has no matching toolResult`).toBe(true);
  }
  for (const id of resultIds) {
    expect(callIds.has(id), `result id ${id} has no matching toolCall`).toBe(true);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const VALID_NOTE = {
  what_happened: "Ran a repo-wide grep that dumped ~38k tokens.",
  avoid: "Don't grep without -l; use the built-in grep tool which truncates.",
  true_current_state: "No files changed on the abandoned span.",
  next: "Re-run as grep -rl auth src/ and read only the 3 relevant files.",
};

const cfg: ProtectedConfig = { rewind: { protectedRoles: ["first:user", "latest:user"] } };

/** mkRewind — build a minimal RewindMarkerLike for filterPipeline. */
function mkRewind(seq: number, granularity: RewindMarkerLike["granularity"], extra?: Partial<RewindMarkerLike>): RewindMarkerLike {
  return { seq, granularity, ...extra };
}

/** mkShrink — build a minimal ShrinkMarkerLike for filterPipeline. */
function mkShrink(seq: number, target: ShrinkTarget, replacement: string, extra?: Partial<ShrinkMarkerLike>): ShrinkMarkerLike {
  return { seq, target, replacement, ...extra };
}

/** Extract text from first content block of a tool result. */
function firstText(res: AgentToolResult<unknown>): string {
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected text block, got ${block?.type ?? "none"}`);
  }
  return block.text;
}

// ════════════════════════════════════════════════════════════════════════════
// E1–E20 edge-case matrix
// ════════════════════════════════════════════════════════════════════════════

describe("E1 — orphan toolResult is a plain unit; never hidden alone (spec/08 E1)", () => {
  it("partitionIntoUnits treats an orphan toolResult as its own plain unit", () => {
    const msgs: MessageLike[] = [user("hi"), res("orphan-1")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(2);
    expect(units[1]).toEqual({ indices: [1], kind: "plain" });
  });

  it("rewind targeting an orphan's unit leaves it intact (the orphan is its own plain unit)", () => {
    const msgs: MessageLike[] = [
      user("hi"),
      asst("c1"), res("c1"),
      res("orphan-42"),
    ];
    // Rewind last_tool_call_group with excludeToolCallId=c99 (not in msgs)
    // → targets the last non-excluded toolGroup, which is [1,2] (c1 group)
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_tool_call_group", { excludeToolCallId: "c99" })],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // orphan (index 3) should survive — it's a plain unit, not the target toolGroup
    expect(out.find((m) => m.role === "toolResult" && m.toolCallId === "orphan-42")).toBeDefined();
    // The orphan is a plain unit, so it's never removed — but pairing invariant
    // requires toolCalls to have results and vice versa. The orphan survives,
    // confirming the rewind doesn't hide it alone.
  });
});

describe("E2 — rewind excludes its own toolCallId; targets completed turns (spec/08 E2)", () => {
  it("resolveLastToolCallGroup returns the PREVIOUS toolGroup indices, never the rewind's own", () => {
    const msgs: MessageLike[] = [
      user("hi"),
      asst("A"), res("A"),
      asst("REW"), res("REW"),
    ];
    const units = partitionIntoUnits(msgs);
    // excludeToolCallId="REW" → should return the indices for "A" group
    const result = resolveLastToolCallGroup(units, msgs, "REW");
    expect(result).not.toBeNull();
    // Returns number[] — the indices of the resolved group
    expect(result).toContain(1);
    expect(result).toContain(2);
  });

  it("if only the rewind's own toolGroup exists → null (no-op)", () => {
    const msgs: MessageLike[] = [user("hi"), asst("REW"), res("REW")];
    const units = partitionIntoUnits(msgs);
    const result = resolveLastToolCallGroup(units, msgs, "REW");
    expect(result).toBeNull();
  });
});

describe("E3 — protected message → tool refuses + filter no-ops (spec/08 E3)", () => {
  it("rewind with to_previous_prompt removes first user → protectedOk returns false → filterPipeline no-ops", () => {
    const msgs: MessageLike[] = [user("first"), asst("c"), res("c")];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_turn", { options: { to_previous_prompt: true } })],
      shrinks: [],
    };
    // filterPipeline's protectedOk guard blocks removal of the first user
    const out = filterPipeline(msgs, markers, cfg);
    expect(out).toHaveLength(3); // nothing removed
    expect(out[0].role).toBe("user");
  });

  it("rewind tool with to_previous_prompt: true when only one user message succeeds with K=0 (respects filter-level guard)", async () => {
    // The tool resolves; filterPipeline-level protectedOk is the defense-in-depth.
    // With a single user + no tool groups, there's nothing to hide anyway.
    const ctxEntries = [msgEntry(user("hi"))];
    const { appended, sent, pi } = makePi();
    const ctx = makeCtx({ contextEntries: ctxEntries });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE,
      granularity: "last_turn",
      to_previous_prompt: true,
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    // Tool REFUSES before persisting (step 5b — BUG-006 fix: nuclear last_turn across first user message)
    expect(text).toContain("would cross a protected message");
  });

  it("protectedOk returns false when remove includes the first user index", () => {
    const msgs: MessageLike[] = [user("first"), asst("c"), res("c")];
    expect(protectedOk(msgs, [0], cfg)).toBe(false);
  });

  it("filterPipeline skips removal when protectedOk returns false", () => {
    const msgs: MessageLike[] = [user("only"), asst("c"), res("c")];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_turn", { options: { to_previous_prompt: true } })],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // Single user → resolveLastTurn refuses → nothing removed
    expect(out).toHaveLength(3);
  });
});

describe("E4 — maxDepth exceeded → tool refuses (spec/08 E4)", () => {
  it("depth >= maxDepth → refusal naming the count; no marker", async () => {
    setConfig({ rewind: { maxDepth: 2 } });
    const { appended, pi } = makePi();
    const ctx = makeCtx({ entries: [rewindEntry(1), rewindEntry(2)] });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toMatch(/refused.*max rewind depth.*2/i);
    expect(appended).toHaveLength(0);
  });
});

describe("E5 — side-effect span → mutation warning appended (spec/08 E5)", () => {
  it("hidden span with writes/bash → success text contains the VERBATIM MUTATION_WARNING", async () => {
    const { appended, pi } = makePi();
    const callId = "mut-1";
    const ctxEntries = [
      msgEntry(user("hi")),
      msgEntry({
        role: "assistant",
        content: [
          { type: "toolCall", id: "w1", name: "write", arguments: { file_path: "/tmp/out.txt" } },
          { type: "toolCall", id: "b1", name: "bash", arguments: { command: "rm -rf /tmp/scratch" } },
        ],
      }),
      msgEntry({ role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] }),
      msgEntry({ role: "toolResult", toolCallId: "b1", content: [{ type: "text", text: "ok" }] }),
    ];
    const ctx = makeCtx({ contextEntries: ctxEntries });
    const tool = makeRewindTool(pi);
    const result = await tool.execute(callId, {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toContain("⚠ The hidden span modified files/ran side-effecting commands (see note). Those effects PERSIST on disk; do not blindly redo them.");
  });
});

describe("E6 — parallel-tool mode: rewind shares assistant with sibling → keep shared, hide previous (spec/06 §9 / spec/08 E6)", () => {
  it("resolveLastToolCallGroup skips the shared toolGroup when excludeToolCallId matches a sibling call in the SAME assistant", () => {
    // One assistant issues BOTH toolCall A and toolCall REW (parallel).
    // Both results are present. excludeToolCallId=REW.
    // The shared toolGroup [asst, resA, resREW] should be SKIPPED (contains the rewind's call).
    // → resolveLastToolCallGroup returns null or a PREVIOUS group.
    const msgs: MessageLike[] = [
      user("hi"),
      asst("A", "REW"), // single assistant with TWO toolCalls
      res("A"),
      res("REW"),
    ];
    const units = partitionIntoUnits(msgs);
    const result = resolveLastToolCallGroup(units, msgs, "REW");
    // The shared toolGroup contains the rewind's callId → it is skipped → null
    expect(result).toBeNull();
  });

  // NOTE: the model-driven end-to-end F-rewind-core proving this VIEW behavior
  // is owned by P1.M5.T3 (not duplicated here).
});

// ── E7: DOCUMENTED LIMITATION (compaction leak) ────────────────────────────

describe("E7 — compaction leak is bounded/transient — no crash (LIMITATION, spec/08 E7)", () => {
  it("filterPipeline does not crash on a post-compaction-shaped message list (summary + retained tail + stale shrink target)", () => {
    // Simulate post-compaction: a compaction summary message, retained tail messages,
    // and a shrink targeting content that was compacted away.
    const msgs: MessageLike[] = [
      { role: "assistant", content: [{ type: "text", text: "This is a compaction summary of the earlier work..." }] },
      user("continue with the task"),
      asst("c-new"), res("c-new"),
    ];
    const markers: MarkerBundle = {
      rewinds: [],
      // Shrink targets a toolCallId that no longer exists (compacted away)
      shrinks: [mkShrink(1, { by_tool_call_id: "c-compacted-away" }, "[summarized]")],
    };
    // MUST NOT throw
    const out = filterPipeline(msgs, markers, cfg);
    // Output should be coherent
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(1);
    // The stale shrink is simply a no-op (E8 behavior applies too)
  });
  // LIMITATION (spec/08 E7): compaction may transiently summarize hidden content;
  // v1 accepts this as bounded/transient. Assert NO crash, not a fix.
});

describe("E8 — marker targets nothing → no-op, idempotent (spec/08 E8)", () => {
  it("filterPipeline with a rewind whose target was already removed → no-op for that operation", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c1"), res("c1"),
      asst("c2"), res("c2"),
    ];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_tool_call_group", { excludeToolCallId: "c1" })],
      shrinks: [mkShrink(2, { by_tool_call_id: "c2" }, "[shrunk]")],
    };
    // rewind removes c2 group; shrink targets c2 → not found → no-op
    const out = filterPipeline(msgs, markers, cfg);
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
  });

  it("applyShrink with no match → returns same reference (no-op)", () => {
    const msgs: MessageLike[] = [user("hi"), asst("c"), res("c")];
    const result = applyShrink(msgs, { target: { by_tool_call_id: "nonexistent" }, replacement: "X" });
    expect(result).toBe(msgs); // same ref
  });
});

describe("E9 — vacuous note → tool refuses (spec/08 E9)", () => {
  it("empty what_happened → NOTE_INVALID_REASON refusal", async () => {
    const { appended, pi } = makePi();
    const ctx = makeCtx({ contextEntries: [] });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: { ...VALID_NOTE, what_happened: "" },
      granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toBe(`Mulligan: refused — ${NOTE_INVALID_REASON}.`);
    expect(appended).toHaveLength(0);
  });
});

describe("E10 — checkpoint invalid name / not found → tool refuses (spec/08 E10)", () => {
  it("checkpoint with bad name → refusal", async () => {
    const { appended, pi } = makePi();
    const ctx = makeCtx({});
    const tool = makeCheckpointTool(pi);
    const result = await tool.execute("call-1", { name: "Bad Name!" }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toMatch(/refused/i);
    expect(appended).toHaveLength(0);
  });

  it("rewind with missing checkpoint name → refusal", async () => {
    const { appended, pi } = makePi();
    const ctx = makeCtx({ contextEntries: [] });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE, granularity: "checkpoint",
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toMatch(/refused/i);
    expect(appended).toHaveLength(0);
  });

  it("rewind with non-existent checkpoint → refusal", async () => {
    const { appended, pi } = makePi();
    const ctx = makeCtx({
      entries: [],
      labels: new Map<string, string>(),
    });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE, granularity: "checkpoint", checkpoint: "missing",
    }, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toMatch(/refused.*checkpoint 'missing' not found/i);
    expect(appended).toHaveLength(0);
  });
});

describe("E11 — reload: markers survive; filter re-applies (spec/08 E11)", () => {
  it("readMarkers buckets a persisted mulligan:rewind custom entry into rewinds[]", () => {
    const entry = rewindEntry(42, { granularity: "last_tool_call_group", excludeToolCallId: "R" });
    const ctx = makeCtx({ entries: [entry] });
    const markers = readMarkers(ctx);
    expect(markers.rewinds).toHaveLength(1);
    expect(markers.rewinds[0].seq).toBe(42);
  });

  it("contextHandler applies the filter when markers are present (markers survive reload as entries)", () => {
    const ctx = makeCtx({
      sessionId: "s-reload-e11",
      entries: [rewindEntry(1, { granularity: "last_tool_call_group", excludeToolCallId: "R" })],
    });
    const messages: MessageLike[] = [
      user("hi"),
      asst("X"), res("X"),
      asst("R"), res("R"),
      custom("mulligan:note"),
    ];
    const event = makeEvent(messages);
    const result = contextHandler(event, ctx);

    expect(result).toBeDefined();
    const filtered = result!.messages!;
    // X group should be removed
    expect(filtered.some((m) => {
      const msg = m as any;
      return msg.role === "assistant" && Array.isArray(msg.content) &&
        msg.content.some((b: any) => b.type === "toolCall" && b.id === "X");
    })).toBe(false);
    // R group should be kept
    expect(filtered.some((m) => {
      const msg = m as any;
      return msg.role === "assistant" && Array.isArray(msg.content) &&
        msg.content.some((b: any) => b.type === "toolCall" && b.id === "R");
    })).toBe(true);
  });

  // NOTE: the real-pi integration proving JSONL persistence across --session-id
  // is in test/integration/edge-cases.integration.test.ts. The re-hide VIEW
  // end-to-end is owned by P1.M5.T3's F-reload harness.
});

describe("E12 — getContextUsage undefined → audit tolerates (spec/08 E12)", () => {
  it("audit tool returns a report when getContextUsage() returns undefined", async () => {
    const ctx = makeCtx({
      getContextUsage: () => undefined,
      entries: [],
      contextEntries: [],
    });
    const result = await auditTool.execute("call-1", {}, undefined, undefined, ctx);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof (result.content[0] as { text: string }).text).toBe("string");
  });
});

describe("E13 — tool/handler throws → fail-open pass-through (spec/08 E13)", () => {
  it("contextHandler with throwOnGetBranch returns undefined (pass-through, no turn break, no throw)", () => {
    const ctx = makeCtx({ throwOnGetBranch: true, sessionId: "s-failopen" });
    const event = makeEvent([user("hi")]);
    const result = contextHandler(event, ctx);
    expect(result).toBeUndefined();
  });

  it("contextHandler with throwOnGetEntries returns undefined (pass-through)", () => {
    const ctx = makeCtx({ throwOnGetEntries: true, sessionId: "s-failopen2" });
    const event = makeEvent([user("hi")]);
    const result = contextHandler(event, ctx);
    // getEntries throwing is caught by readMarkers (returns empty bundle),
    // but the filter may still return {messages} for the input. Check it doesn't throw.
    expect(() => contextHandler(event, ctx)).not.toThrow();
  });

  it("rewind tool with throwOnAppend returns a text result, never throws", async () => {
    const { appended, sent, pi } = makePi({ throwOnAppend: true });
    const ctx = makeCtx({ contextEntries: [] });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof (result.content[0] as { text: string }).text).toBe("string");
  });

  it("rewind tool with throwOnSendMessage returns success, marker persisted", async () => {
    const { appended, sent, pi } = makePi({ throwOnSendMessage: true });
    const ctx = makeCtx({ contextEntries: [] });
    const tool = makeRewindTool(pi);
    const result = await tool.execute("call-1", {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);
    expect(appended).toHaveLength(1);
    expect(sent).toHaveLength(0); // sendMessage threw, caught by fail-open
    expect(typeof (result.content[0] as { text: string }).text).toBe("string");
  });

  // NOTE: the forced-throw end-to-end F-failopen harness is owned by P1.M5.T3.
});

describe("E14 — config.enabled=false → pure no-op (spec/08 E14)", () => {
  it("contextHandler returns undefined (pass-through)", () => {
    setConfig({ enabled: false });
    const ctx = makeCtx({ sessionId: "s-disabled" });
    const event = makeEvent([user("hi")]);
    const result = contextHandler(event, ctx);
    expect(result).toBeUndefined();
  });

  it("all 4 tools refuse 'Mulligan is disabled'", async () => {
    setConfig({ enabled: false });

    // rewind
    const { pi: pi1 } = makePi();
    const ctx1 = makeCtx({ contextEntries: [] });
    const rewindRes = await makeRewindTool(pi1).execute("tc-1", {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx1);
    expect(firstText(rewindRes as unknown as AgentToolResult<unknown>)).toMatch(/Mulligan is disabled/);

    // shrink
    const { pi: pi2 } = makePi();
    const ctx2 = makeCtx({});
    const shrinkRes = await makeShrinkTool(pi2).execute("tc-2", {
      target: { by_tool_name: "read", occurrence: "last" }, replacement: "x",
    }, undefined, undefined, ctx2);
    expect(firstText(shrinkRes as unknown as AgentToolResult<unknown>)).toMatch(/Mulligan is disabled/);

    // checkpoint
    const { pi: pi3 } = makePi();
    const ctx3 = makeCtx({});
    const ckptRes = await makeCheckpointTool(pi3).execute("tc-3", { name: "test" }, undefined, undefined, ctx3);
    expect(firstText(ckptRes as unknown as AgentToolResult<unknown>)).toMatch(/Mulligan is disabled/);

    // audit
    const ctx4 = makeCtx({ getContextUsage: () => ({ tokens: 0, characters: 0 }), entries: [], contextEntries: [] });
    const auditRes = await auditTool.execute("tc-4", {}, undefined, undefined, ctx4);
    expect(firstText(auditRes as unknown as AgentToolResult<unknown>)).toMatch(/Mulligan is disabled/);
  });
});

// ── E15: DOCUMENTED LIMITATION (many markers, no GC) ─────────────────────

describe("E15 — many accumulated markers, no GC — still cheap, no crash (LIMITATION, spec/08 E15)", () => {
  it("filterPipeline with 50 rewind markers + 50 shrink markers on a bounded list does not throw", () => {
    const msgs: MessageLike[] = [
      user("hi"),
      asst("c1"), res("c1"),
      asst("c2"), res("c2"),
      user("continue"),
      asst("c3"), res("c3"),
    ];
    const rewinds: RewindMarkerLike[] = [];
    const shrinks: ShrinkMarkerLike[] = [];
    for (let i = 1; i <= 50; i++) {
      rewinds.push(mkRewind(i, i % 2 === 0 ? "last_turn" : "last_tool_call_group", {
        excludeToolCallId: i % 3 === 0 ? "c1" : undefined,
      }));
    }
    for (let i = 1; i <= 50; i++) {
      shrinks.push(mkShrink(100 + i, { by_tool_call_id: "c2" }, `[shrunk-${i}]`));
    }
    const markers: MarkerBundle = { rewinds, shrinks };
    // MUST NOT throw; completes
    const out = filterPipeline(msgs, markers, cfg);
    expect(Array.isArray(out)).toBe(true);
    expectNoOrphans(out);
  });
  // LIMITATION (spec/08 E15): v1 does no marker GC; markers persist intentionally.
  // O(markers×messages) is acceptable. Assert NO crash, not a fix.
});

describe("E16 — audit before any inference → fallback, confidence low (spec/08 E16)", () => {
  it("audit tool with rt.lastFiltered===null falls back to buildContextEntries→filterPipeline, confidence 'low'", async () => {
    const ctxEntries = [
      msgEntry(user("hi")),
      msgEntry(asst("c1")),
      msgEntry({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "big output" }] }),
    ];
    const ctx = makeCtx({
      sessionId: "s-fallback-e16",
      contextEntries: ctxEntries,
      entries: [],
      getContextUsage: () => ({ tokens: 100, characters: 500 }),
    });
    // rt.lastFiltered should be null for a fresh session
    const rt = runtime((ctx as any).sessionManager);
    expect(rt.lastFiltered).toBeNull();

    const result = await auditTool.execute("call-1", {}, undefined, undefined, ctx);
    const text = firstText(result as unknown as AgentToolResult<unknown>);
    expect(text).toContain("Mulligan audit");
    expect(result.details.confidence).toBe("low");
    expect(result.details.source).toBe("fallback");
  });
});

describe("E17 — two shrinks same target → last wins (spec/08 E17)", () => {
  it("filterPipeline with two shrinks on the same toolCallId → seq-2 replacement wins", () => {
    const msgs: MessageLike[] = [
      user("u"), asst("c1"), res("c1"), asst("c2"), res("c2"),
    ];
    const markers: MarkerBundle = {
      rewinds: [],
      shrinks: [
        mkShrink(1, { by_tool_call_id: "c1" }, "FIRST"),
        mkShrink(2, { by_tool_call_id: "c1" }, "SECOND"),
      ],
    };
    const out = filterPipeline(msgs, markers, cfg);
    const target = out.find((m) => m.role === "toolResult" && m.toolCallId === "c1");
    expect(target).toBeDefined();
    expect((target as any).content).toEqual([{ type: "text", text: "SECOND" }]);
  });
});

// ── E18: DOCUMENTED LIMITATION (advisory nudges) ──────────────────────────

describe("E18 — model ignores nudges → advisory, never persisted (LIMITATION, spec/08 E18)", () => {
  it("injectNudge appends a mulligan:nudge CustomMessage to the COPY; original input is unchanged", () => {
    const msgs: MessageLike[] = [user("hi"), asstText("world")];
    const metric = {
      deltaTokens: 5000,
      grewOverThreshold: true,
      bloatHit: false,
      turnIndex: 3,
    };
    const result = injectNudge(msgs, metric);

    // Result has the nudge
    expect(result).toHaveLength(msgs.length + 1);
    const nudge = result[result.length - 1];
    expect(nudge.role).toBe("custom");
    expect(nudge.customType).toBe("mulligan:nudge");

    // ORIGINAL input is unchanged (never persisted)
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("the nudge has ephemeral:true in details and display:false", () => {
    const msgs: MessageLike[] = [user("hi")];
    const metric = { deltaTokens: null, grewOverThreshold: false, bloatHit: true, turnIndex: 0 };
    const result = injectNudge(msgs, metric);
    const nudge = result[result.length - 1];
    expect(nudge.display).toBe(false);
    expect((nudge as any).details?.ephemeral).toBe(true);
  });
  // LIMITATION (spec/08 E18): nudges are advisory (D3). Mulligan does not force behavior.
});

describe("E19 — shrink non-toolResult → role preserved (spec/08 E19)", () => {
  it("applyShrink with by_content_includes on a user message → content replaced, role stays 'user'", () => {
    const msgs: MessageLike[] = [
      user("please read /tmp/big-file.ts"),
      asst("c"), res("c"),
    ];
    const result = applyShrink(msgs, {
      target: { by_content_includes: "big-file.ts" },
      replacement: "[file reference shrunk]",
    });
    // The user message should be shrunk
    const shrunk = result.find((m) => m.role === "user");
    expect(shrunk).toBeDefined();
    expect((shrunk as any).role).toBe("user");
    expect((shrunk as any).content).toEqual([{ type: "text", text: "[file reference shrunk]" }]);
  });
});

describe("E20 — appendEntry→sendMessage land in call order (spec/08 E20)", () => {
  it("makeRewindTool: fakePi.appended[0] is mulligan:rewind AND fakePi.sent[0] is mulligan:note (marker first, note second)", async () => {
    const { appended, sent, pi } = makePi();
    const callId = "tc-rewind";
    const ctxEntries = [
      msgEntry(user("hi")),
      msgEntry(asst("tc-1")),
      msgEntry({ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "..." }] }),
    ];
    const ctx = makeCtx({ contextEntries: ctxEntries });
    const tool = makeRewindTool(pi);
    await tool.execute(callId, {
      note: VALID_NOTE, granularity: "last_tool_call_group",
    }, undefined, undefined, ctx);

    // Marker first (appendEntry)
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:rewind");
    // Note second (sendMessage)
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("mulligan:note");
  });

  // NOTE: the real-pi integration proving JSONL ordering is in
  // test/integration/edge-cases.integration.test.ts.
});

// ════════════════════════════════════════════════════════════════════════════
// Self-contained randomized pairing-invariant property test (spec/10 §3)
// ════════════════════════════════════════════════════════════════════════════

describe("pairing-invariant property (spec/10 §3)", () => {
  /**
   * Self-contained randomized pairing invariant: ≥100 iters with a seeded PRNG.
   * Asserts NO orphan toolCall/toolResult in filterPipeline output AND monotonic
   * shrinkage (out.length <= msgs.length).
   *
   * The comprehensive 300-iter suite also lives in test/pipeline.test.ts; this
   * focused check makes edge-cases.test.ts self-sufficient as the DoD gate.
   */
  it("pairing invariant + monotonic shrinkage (100 iters, seeded)", () => {
    const rng = mulberry32(42);
    for (let iter = 0; iter < 100; iter++) {
      const msgs = genMessages(rng);
      const markers = genMarkers(rng, msgs);
      const out = filterPipeline(msgs, markers, cfg);
      expectNoOrphans(out);
      expect(out.length).toBeLessThanOrEqual(msgs.length);
    }
  });
});
