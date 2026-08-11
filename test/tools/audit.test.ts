/**
 * audit.test.ts — unit tests for the `mulligan_audit` tool (src/tools/audit.ts).
 *
 * Mirrors the house test idiom from test/tools/shrink.test.ts + checkpoint.test.ts:
 * vitest, hand-rolled `makeCtx()` fake (NO vi.fn(), NO makePi — audit needs no pi),
 * `.js` import paths, `expectTypeOf` for type assertions,
 * `clearAll()` runtime reset + `setConfig(undefined)` before/after each test.
 *
 * Coverage:
 *   a) registration metadata (spec/05 §5)
 *   b) cached-path happy path (largest-first + bloat flag + suggestion)
 *   c) fallback path (E16 — low confidence, no crash)
 *   d) top-N respected
 *   e) suggestion naming + empty omission
 *   f) bloat flag boundary (8192 not flagged / 8193 flagged)
 *   g) active markers line + checkpoint scan
 *   h) config-disabled refusal (E14)
 *   i) never-throws (E13)
 *   j) details-on-every-path
 *   k) D5 no-getContextUsage regression
 *   l) PURE renderer unit cases
 *   m) PURE helper unit cases
 *   n) types
 */
import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from "vitest";
import {
  auditTool,
  AuditParams,
  AUDIT_DESC,
  renderAuditReport,
  describeMessage,
  buildCallLookup,
  messageBytes,
  listCheckpoints,
  type AuditArgs,
  type AuditDetails,
  type AuditRow,
} from "../../src/tools/audit.js";
import { clearAll, runtime } from "../../src/runtime.js";
import { setConfig } from "../../src/config.js";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  clearAll();
  setConfig(undefined);
});
afterEach(() => {
  clearAll();
  setConfig(undefined);
});

// ── fakes ──────────────────────────────────────────────────────────────

/**
 * A minimal fake ExtensionContext. Audit needs NO makePi (it never writes).
 * Provides: getSessionId, getEntries, getBranch, buildContextEntries.
 */
function makeCtx(opts: {
  sessionId?: string;
  entries?: unknown[];
  branch?: unknown[];
  contextEntries?: unknown[];
  throwOnGetEntries?: boolean;
  throwOnBuildContext?: boolean;
  throwOnGetSessionId?: boolean;
} = {}) {
  const sessionId = opts.sessionId ?? "s1";
  const entries = opts.entries ?? [];
  const branch = opts.branch ?? entries;
  const contextEntries = opts.contextEntries ?? [];

  const sessionManager = {
    getSessionId() {
      if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
      return sessionId;
    },
    getEntries() {
      if (opts.throwOnGetEntries) throw new Error("getEntries boom");
      return entries;
    },
    getBranch() {
      return branch;
    },
    buildContextEntries() {
      if (opts.throwOnBuildContext) throw new Error("buildContextEntries boom");
      return contextEntries;
    },
  };
  const ctx = { sessionManager };
  return { ctx: ctx as unknown as ExtensionContext };
}

// ── helpers ────────────────────────────────────────────────────────────

/** Invoke the tool's execute. toolCallId defaults to "call-1". */
async function run(
  ctx: ExtensionContext,
  params?: AuditArgs,
  toolCallId = "call-1",
): Promise<AgentToolResult<AuditDetails>> {
  return auditTool.execute(toolCallId, params ?? {}, undefined, undefined, ctx);
}

/** Extract the text from a result's first content block. */
function firstText(res: AgentToolResult<AuditDetails>): string {
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected a text content block, got ${block?.type ?? "none"}`);
  }
  return block.text;
}

// ── message builders ─────────────────────────────────────────────────

function user(text: string): Record<string, unknown> {
  return { role: "user", content: text };
}

function asst(...callIds: string[]): Record<string, unknown> {
  return {
    role: "assistant",
    content: callIds.map((id) => ({
      type: "toolCall",
      id,
      name: "tool",
      arguments: { path: "src/foo.ts" },
    })),
  };
}

function asstWithContent(...blocks: unknown[]): Record<string, unknown> {
  return { role: "assistant", content: blocks };
}

function result(
  toolCallId: string,
  toolName: string,
  text: string,
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    toolCallId,
  };
}

function custom(customType: string): Record<string, unknown> {
  return { role: "custom", customType };
}

// ── (a) registration metadata ────────────────────────────────────────

describe("mulligan_audit — registration metadata", () => {
  it("name === 'mulligan_audit', label === 'Mulligan Audit', description === AUDIT_DESC verbatim", () => {
    expect(auditTool.name).toBe("mulligan_audit");
    expect(auditTool.label).toBe("Mulligan Audit");
    expect(auditTool.description).toBe(AUDIT_DESC);
  });

  it("parameters === AuditParams (the typebox Type.Object)", () => {
    expect(auditTool.parameters).toBe(AuditParams);
  });
});

// ── (b) cached-path happy path ─────────────────────────────────────────

describe("mulligan_audit — cached-path happy path", () => {
  it("seeded lastFiltered → report with total, bloat flag on large read, suggestion naming it", async () => {
    const { ctx } = makeCtx();
    const bigText = "x".repeat(40000);
    const msgs = [user("hi"), asst("c1"), result("c1", "read", bigText)];
    runtime(ctx.sessionManager).lastFiltered = msgs;

    const res = await run(ctx);
    const text = firstText(res);

    // Header
    expect(text).toContain("## Mulligan audit — context you are currently carrying");
    // Total line with TWO spaces before "(estimate"
    expect(text).toMatch(/Total \(filtered\): ~[\d,]+ tokens  \(estimate, confidence: medium\)/);
    // The big read result appears first in Top block (it's the largest)
    expect(text).toContain("⚠ above bloat threshold (8 KB)");
    // Suggestion names the largest
    expect(text).toContain("Suggestion:");
    expect(text).toContain("Consider mulligan_shrink.");

    // Details
    expect(res.details.source).toBe("cached");
    expect(res.details.confidence).toBe("medium");
    expect(res.details.nRewinds).toBe(0);
    expect(res.details.totalTokens).toBeGreaterThan(0);
  });
});

// ── (c) fallback path (E16) ───────────────────────────────────────────

describe("mulligan_audit — fallback path (E16)", () => {
  it("lastFiltered null + contextEntries shaped as message entries → renders with confidence low, source fallback", async () => {
    // Use contextEntries that mimic what buildContextEntries would return
    const msg1 = { type: "message", id: "e1", message: user("hello") };
    const msg2 = { type: "message", id: "e2", message: asst("tc1") };
    const msg3 = { type: "message", id: "e3", message: result("tc1", "bash", "output") };
    const { ctx } = makeCtx({ contextEntries: [msg1, msg2, msg3], branch: [] });
    // Do NOT seed lastFiltered — leave it null

    const res = await run(ctx);
    const text = firstText(res);

    // Report renders without crash
    expect(text).toContain("## Mulligan audit — context you are currently carrying");
    expect(text).toContain("confidence: low");
    expect(res.details.source).toBe("fallback");
    expect(res.details.confidence).toBe("low");
  });
});

// ── (d) top-N respected ────────────────────────────────────────────────

describe("mulligan_audit — top-N", () => {
  it("seeded lastFiltered with 12 messages, top:3 → only 3 rows in Top block", async () => {
    const { ctx } = makeCtx();
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(user("msg".repeat((i + 1) * 10)));
    }
    runtime(ctx.sessionManager).lastFiltered = msgs;

    const res = await run(ctx, { top: 3 });
    const text = firstText(res);

    // Count data rows under "Top messages by size:" — lines starting with whitespace+digit
    const topIdx = text.indexOf("Top messages by size:");
    const afterTop = text.slice(topIdx);
    const rows = afterTop.split("\n").filter(
      (l) => /^\s+\d/.test(l),
    );
    expect(rows.length).toBe(3);
  });

  it("default (no top) → ≤8 rows", async () => {
    const { ctx } = makeCtx();
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(user("msg".repeat((i + 1) * 10)));
    }
    runtime(ctx.sessionManager).lastFiltered = msgs;

    const res = await run(ctx);
    const text = firstText(res);

    const topIdx = text.indexOf("Top messages by size:");
    const afterTop = text.slice(topIdx);
    const rows = afterTop.split("\n").filter(
      (l) => /^\s+\d/.test(l),
    );
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});

// ── (e) suggestion naming + empty omission ─────────────────────────────

describe("mulligan_audit — suggestion naming + empty omission", () => {
  it("empty filtered view → 'No messages in filtered view.' and NO Suggestion", async () => {
    const { ctx } = makeCtx();
    runtime(ctx.sessionManager).lastFiltered = [];

    const res = await run(ctx);
    const text = firstText(res);

    expect(text).toContain("No messages in filtered view.");
    expect(text).not.toContain("Suggestion:");
  });

  it("single message → Suggestion names that message's label", async () => {
    const { ctx } = makeCtx();
    runtime(ctx.sessionManager).lastFiltered = [result("c1", "read", "some output")];

    const res = await run(ctx);
    const text = firstText(res);

    expect(text).toContain("Suggestion:");
    expect(text).toContain("Consider mulligan_shrink.");
  });
});

// ── (f) bloat flag boundary ─────────────────────────────────────────────

describe("mulligan_audit — bloat flag boundary", () => {
  it("message with content exactly at threshold (8192 bytes) → NOT flagged (strictly >)", async () => {
    const { ctx } = makeCtx();
    const exactBytes = "a".repeat(8192); // exactly 8192 bytes
    runtime(ctx.sessionManager).lastFiltered = [result("c1", "read", exactBytes)];

    const res = await run(ctx);
    const text = firstText(res);

    // Should NOT have the bloat flag
    expect(text).not.toContain("⚠ above bloat threshold");
    // Verify no row is bloaty
    expect(res.details.top.every((r) => !r.bloaty)).toBe(true);
  });

  it("message with 8193 bytes → flagged", async () => {
    const { ctx } = makeCtx();
    const overBytes = "a".repeat(8193); // 8193 bytes > 8192
    runtime(ctx.sessionManager).lastFiltered = [result("c1", "read", overBytes)];

    const res = await run(ctx);
    const text = firstText(res);

    expect(text).toContain("⚠ above bloat threshold (8 KB)");
    expect(res.details.top.some((r) => r.bloaty)).toBe(true);
  });
});

// ── (g) active markers line + checkpoint scan ────────────────────────────

describe("mulligan_audit — active markers line", () => {
  it("entries with rewind marker + checkpoint label → Active markers shows them", async () => {
    const rewindEntry = {
      type: "custom",
      id: "rw-1",
      customType: "mulligan:rewind",
      data: {
        schema: "pi-mulligan",
        v: 1,
        kind: "rewind",
        id: "rw-uuid",
        granularity: "last_tool_call_group",
        seq: 1,
        ts: Date.now(),
        options: {},
        note: {
          what_happened: "test",
          avoid: "test",
          true_current_state: "test",
          next: "test",
        },
        ledger: { modifiedFiles: [], bashSideEffects: [] },
      },
    };
    const cpEntry = {
      type: "label",
      id: "cp-1",
      label: "mulligan:checkpoint:before-x",
    };
    const { ctx } = makeCtx({ entries: [rewindEntry, cpEntry] });
    runtime(ctx.sessionManager).lastFiltered = [user("hi")];

    const res = await run(ctx);
    const text = firstText(res);

    expect(text).toContain("1 rewind (last_tool_call_group)");
    expect(text).toContain("0 shrink");
    expect(text).toContain("1 checkpoints [before-x]");
    expect(res.details.nRewinds).toBe(1);
    expect(res.details.nCheckpoints).toBe(1);
  });
});

// ── (h) config-disabled refusal (E14) ──────────────────────────────────

describe("mulligan_audit — config-disabled refusal (E14)", () => {
  it("config.enabled === false → refusal text; details all-zero", async () => {
    setConfig({ enabled: false });
    const { ctx } = makeCtx();
    const res = await run(ctx);

    expect(firstText(res)).toBe("Mulligan: refused — Mulligan is disabled.");
    expect(res.details.totalTokens).toBe(0);
    expect(res.details.source).toBe("fallback");
    expect(res.details.confidence).toBe("low");
    expect(res.details.nRewinds).toBe(0);
    expect(res.details.nShrinks).toBe(0);
    expect(res.details.nCheckpoints).toBe(0);
    expect(res.details.top).toEqual([]);
  });
});

// ── (i) never-throws (E13) ─────────────────────────────────────────────

describe("mulligan_audit — never-throws (E13)", () => {
  it("getSessionId throws → no throw escapes; failure text", async () => {
    const { ctx } = makeCtx({ throwOnGetSessionId: true });
    const res = await run(ctx);

    expect(firstText(res)).toMatch(/^Mulligan: audit failed —/);
    expect(res.details.error).toBeDefined();
  });

  it("buildContextEntries throws with lastFiltered null → no throw escapes", async () => {
    const { ctx } = makeCtx({ throwOnBuildContext: true });
    // Do NOT seed lastFiltered — force fallback path
    const res = await run(ctx);

    expect(firstText(res)).toMatch(/^Mulligan: audit failed —/);
    expect(res.details.error).toBeDefined();
  });
});

// ── (j) details-on-every-path ──────────────────────────────────────────

describe("mulligan_audit — details on every path", () => {
  it("success path → details with all required fields", async () => {
    const { ctx } = makeCtx();
    runtime(ctx.sessionManager).lastFiltered = [user("hi")];
    const res = await run(ctx);

    expect(res.details).toBeDefined();
    expect(typeof res.details.totalTokens).toBe("number");
    expect(["low", "medium", "high"]).toContain(res.details.confidence);
    expect(["cached", "fallback"]).toContain(res.details.source);
    expect(typeof res.details.nRewinds).toBe("number");
    expect(typeof res.details.nShrinks).toBe("number");
    expect(typeof res.details.nCheckpoints).toBe("number");
    expect(Array.isArray(res.details.top)).toBe(true);
  });

  it("refusal path → details with all-zero fields", async () => {
    setConfig({ enabled: false });
    const { ctx } = makeCtx();
    const res = await run(ctx);

    expect(res.details).toBeDefined();
    expect(res.details.totalTokens).toBe(0);
    expect(res.details.confidence).toBe("low");
    expect(res.details.source).toBe("fallback");
    expect(res.details.nRewinds).toBe(0);
    expect(res.details.nShrinks).toBe(0);
    expect(res.details.nCheckpoints).toBe(0);
    expect(res.details.top).toEqual([]);
  });

  it("catch path → details with error field", async () => {
    const { ctx } = makeCtx({ throwOnGetSessionId: true });
    const res = await run(ctx);

    expect(res.details).toBeDefined();
    expect(res.details.error).toBeDefined();
    expect(res.details.totalTokens).toBe(0);
  });
});

// ── (k) D5 guard — no getContextUsage ───────────────────────────────────

describe("mulligan_audit — D5 guard (no getContextUsage)", () => {
  it("report text does NOT mention getContextUsage", async () => {
    const { ctx } = makeCtx();
    runtime(ctx.sessionManager).lastFiltered = [user("hi")];
    const res = await run(ctx);
    expect(firstText(res)).not.toContain("getContextUsage");
  });
});

// ── (l) PURE renderer unit cases ───────────────────────────────────────

describe("renderAuditReport — pure unit cases", () => {
  it("TWO spaces before '(estimate' on Total line", () => {
    const report = renderAuditReport({
      totalTokens: 12340,
      confidence: "medium",
      rewinds: [],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: ["first:user", "latest:user"],
      rows: [],
      filtered: [user("hi")],
    });
    expect(report).toMatch(/tokens  \(estimate, confidence: medium\)/);
  });

  it("empty checkpoints renders '[]'", () => {
    const report = renderAuditReport({
      totalTokens: 100,
      confidence: "medium",
      rewinds: [],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: [],
      rows: [],
      filtered: [user("hi")],
    });
    expect(report).toContain("0 checkpoints []");
  });

  it("distinct rewind granularities are deduped", () => {
    const report = renderAuditReport({
      totalTokens: 100,
      confidence: "medium",
      rewinds: [
        { granularity: "last_tool_call_group", seq: 1 } as unknown as import("../../src/markers.js").RewindMarker,
        { granularity: "last_tool_call_group", seq: 2 } as unknown as import("../../src/markers.js").RewindMarker,
      ],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: [],
      rows: [],
      filtered: [user("hi")],
    });
    expect(report).toContain("2 rewind (last_tool_call_group)");
  });

  it("bloat flag renders threshold in KB", () => {
    const report = renderAuditReport({
      totalTokens: 100,
      confidence: "medium",
      rewinds: [],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: [],
      rows: [
        {
          tokens: 1000,
          role: "toolResult",
          label: "read big.log",
          bloaty: true,
          thresholdBytes: 8192,
        },
      ],
      filtered: [user("hi")],
    });
    expect(report).toContain("⚠ above bloat threshold (8 KB)");
  });

  it("empty protectedRoles renders 'none'", () => {
    const report = renderAuditReport({
      totalTokens: 100,
      confidence: "medium",
      rewinds: [],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: [],
      rows: [],
      filtered: [user("hi")],
    });
    expect(report).toContain("will not rewind past none.");
  });

  it("empty filtered view → 'No messages in filtered view.' with no suggestion", () => {
    const report = renderAuditReport({
      totalTokens: 0,
      confidence: "low",
      rewinds: [],
      shrinks: [],
      checkpointNames: [],
      protectedRoles: [],
      rows: [],
      filtered: [],
    });
    expect(report).toContain("No messages in filtered view.");
    expect(report).not.toContain("Suggestion:");
  });

  it("checkpoints rendered with names", () => {
    const report = renderAuditReport({
      totalTokens: 100,
      confidence: "medium",
      rewinds: [],
      shrinks: [],
      checkpointNames: ["before-x", "before-y"],
      protectedRoles: [],
      rows: [],
      filtered: [user("hi")],
    });
    expect(report).toContain("2 checkpoints [before-x, before-y]");
  });
});

// ── (l2) renderAuditReport — role-aware Suggestion (BUG-008) ──────────

describe("renderAuditReport — role-aware Suggestion (BUG-008)", () => {
  const base = {
    totalTokens: 100,
    confidence: "medium" as const,
    rewinds: [],
    shrinks: [],
    checkpointNames: [],
    protectedRoles: [],
    filtered: [{ role: "user", content: "hi" }],
  };
  function row(role: string, label: string): AuditRow {
    return { tokens: 1000, role, label, bloaty: false, thresholdBytes: 8192 };
  }
  it("rows[0].role === 'toolResult' → unchanged toolResult Suggestion", () => {
    const report = renderAuditReport({ ...base, rows: [row("toolResult", "read src/big.log")] });
    expect(report).toContain("Suggestion:");
    expect(report).toContain("the `read src/big.log` result is the largest contributor.");
    expect(report).toContain("Consider mulligan_shrink.");
    expect(report).not.toContain("the assistant turn");
    expect(report).not.toContain("no Mulligan operation applies");
  });
  it("rows[0].role === 'assistant' → assistant-turn Suggestion naming rewind + shrink", () => {
    const report = renderAuditReport({ ...base, rows: [row("assistant", "(thinking + toolCall x2)")] });
    expect(report).toContain("Suggestion:");
    expect(report).toContain("the assistant turn `(thinking + toolCall x2)` is the largest contributor.");
    expect(report).toContain("Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink.");
    expect(report).not.toContain("result is the largest contributor.");
    expect(report).not.toContain("no Mulligan operation applies");
  });
  it("rows[0].role === 'user' → honest 'no Mulligan operation applies' Suggestion with role echoed", () => {
    const report = renderAuditReport({ ...base, rows: [row("user", 'user "hello world"')] });
    expect(report).toContain("Suggestion:");
    expect(report).toContain("the largest contributor is the");
    expect(report).toContain("message (role: `user`)");
    expect(report).toContain("no Mulligan operation applies to a non-tool message.");
    expect(report).not.toContain("Consider mulligan_shrink.");
    expect(report).not.toContain("the assistant turn");
  });
  it("rows[0].role === 'custom' (otherwise branch) → same 'no op' Suggestion with role echoed", () => {
    const report = renderAuditReport({ ...base, rows: [row("custom", "mulligan:note")] });
    expect(report).toContain("no Mulligan operation applies to a non-tool message.");
    expect(report).toContain("message (role: `custom`)");
  });
  it("empty filtered view → STILL omits the Suggestion (regression)", () => {
    const report = renderAuditReport({ ...base, rows: [], filtered: [] });
    expect(report).toContain("No messages in filtered view.");
    expect(report).not.toContain("Suggestion:");
  });
});

// ── (m) PURE helper unit cases ──────────────────────────────────────────

describe("describeMessage — pure unit cases", () => {
  it("toolResult with callLookup → 'toolName args'", () => {
    const lookup = new Map<string, { name: string; args: Record<string, unknown> }>();
    lookup.set("c1", { name: "read", args: { path: "src/foo.ts" } });
    const msg = { role: "toolResult", toolName: "read", toolCallId: "c1", content: [] };
    expect(describeMessage(msg, lookup)).toBe("read src/foo.ts");
  });

  it("assistant → summarizes content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
      ],
    };
    expect(describeMessage(msg, new Map())).toBe("(thinking + toolCall x2)");
  });

  it("user → 'user \"<snippet>\"'", () => {
    const msg = { role: "user", content: "hello world, this is a long message" };
    const label = describeMessage(msg, new Map());
    expect(label).toMatch(/^user "/);
    expect(label).toContain('"');
  });

  it("custom → customType", () => {
    const msg = { role: "custom", customType: "mulligan:note" };
    expect(describeMessage(msg, new Map())).toBe("mulligan:note");
  });

  it("unknown role → role name", () => {
    const msg = { role: "branchSummary" };
    expect(describeMessage(msg, new Map())).toBe("branchSummary");
  });
});

describe("buildCallLookup — pure unit cases", () => {
  it("indexes multiple toolCall blocks in one assistant message", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ];
    const lookup = buildCallLookup(msgs);
    expect(lookup.get("c1")?.name).toBe("read");
    expect(lookup.get("c2")?.name).toBe("bash");
  });

  it("skips non-assistant messages", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const lookup = buildCallLookup(msgs);
    expect(lookup.size).toBe(0);
  });
});

describe("messageBytes — pure unit cases", () => {
  it("string content → UTF-8 byteLength", () => {
    const msg = { role: "user", content: "café" };
    expect(messageBytes(msg)).toBe(Buffer.byteLength("café", "utf8")); // 5 bytes
  });

  it("array content → resultBytes", () => {
    const msg = { role: "toolResult", content: [{ type: "text", text: "hello" }] };
    expect(messageBytes(msg)).toBe(5); // "hello" = 5 bytes
  });

  it("no content → 0", () => {
    const msg = { role: "user" };
    expect(messageBytes(msg)).toBe(0);
  });
});

describe("listCheckpoints — pure unit cases", () => {
  it("lists active checkpoints prefix-stripped", () => {
    const entries = [
      { type: "label", id: "l1", label: "mulligan:checkpoint:before-x" },
      { type: "label", id: "l2", label: "mulligan:checkpoint:before-y" },
    ];
    expect(listCheckpoints(entries)).toEqual(["before-x", "before-y"]);
  });

  it("consumed checkpoint (cleared label) is NOT listed", () => {
    // A cleared checkpoint: the entry's label changed to something else
    const entries = [
      { type: "label", id: "l1", label: "mulligan:checkpoint:before-x" },
      { type: "label", id: "l1", label: "" }, // same id, later entry clears it
    ];
    // latest-wins: id "l1" now has label "" which doesn't start with mulligan:checkpoint:
    expect(listCheckpoints(entries)).toEqual([]);
  });

  it("non-label entries are skipped", () => {
    const entries = [
      { type: "custom", id: "e1", customType: "mulligan:rewind", data: {} },
      { type: "message", id: "e2", message: {} },
    ];
    expect(listCheckpoints(entries)).toEqual([]);
  });
});

// ── (n) types ──────────────────────────────────────────────────────────

describe("mulligan_audit — types", () => {
  it("auditTool matches ToolDefinition<typeof AuditParams, AuditDetails>", () => {
    expectTypeOf(auditTool).toMatchTypeOf<ToolDefinition<typeof AuditParams, AuditDetails>>();
  });

  it("execute returns Promise<AgentToolResult<AuditDetails>>", async () => {
    const { ctx } = makeCtx();
    runtime(ctx.sessionManager).lastFiltered = [];
    const res = await auditTool.execute("call-1", {}, undefined, undefined, ctx);
    expectTypeOf(res).toMatchTypeOf<AgentToolResult<AuditDetails>>();
  });
});
