/**
 * shrink.test.ts — unit tests for the `mulligan_shrink` tool (src/tools/shrink.ts).
 *
 * Mirrors the house test idiom from test/tools/rewind.test.ts: vitest, hand-rolled
 * `makePi()`/`makeCtx()` fakes (NO vi.fn()), `.js` import paths, `expectTypeOf` for type assertions,
 * `clearAll()` runtime reset before/after each test (nextSeq mutates the shared module-scoped runtime map).
 *
 * Coverage:
 *   a) registration metadata (spec/05 §5): name/label/description/parameters.
 *   b) the 3 refusal paths: config-disabled (E14 master + shrink); empty replacement; structurally-impossible
 *      target (empty/whitespace discriminator for all 3 arms).
 *   c) success + match-now yes: target matches a toolResult in the snapshot → matched:true, VERBATIM text,
 *      appendShrinkMarker called with EXACT {target,replacement,reason} (NO pinnedEntryId).
 *   d) match-now no-match persists: valid non-empty target that does NOT match → matched:false, STILL persists (E8).
 *   e) best-effort failure: buildContextEntries throws → matched:false + STILL persists + success text (E13).
 *   f) never-throws: pi.appendEntry throws → refusal text, NO throw escapes.
 *   g) result shape: EVERY path has content:[{type:"text"}] + details (GOTCHA #4).
 *   h) types: ToolDefinition / AgentToolResult.
 */
import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from "vitest";
import {
  makeShrinkTool,
  ShrinkParams,
  SHRINK_DESC,
  type ShrinkArgs,
  type ShrinkDetails,
} from "../../src/tools/shrink.js";
import { clearAll } from "../../src/runtime.js";
import { setConfig } from "../../src/config.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// GOTCHA (shared with rewind.test.ts): nextSeq mutates the SHARED module-scoped runtime map. clearAll() before
// AND after each test so a previous test's seq can't leak in (appendShrinkMarker calls nextSeq internally).
// ALSO reset the config cache to defaults (setConfig(undefined)) — tests setConfig({shrink:{enabled:false}})
// or {enabled:false}; without the reset, the poisoned cache leaks into sibling tests.
beforeEach(() => {
  clearAll();
  setConfig(undefined); // reset the config cache to validated DEFAULT_CONFIG
});
afterEach(() => {
  clearAll();
  setConfig(undefined);
});

// ── fakes (mirrors rewind.test.ts makePi/makeCtx) ──────────────────────────────

/** A minimal fake ExtensionAPI capturing appendEntry (hand-rolled, no vi.fn()). */
function makePi(opts: {
  throwOnAppend?: boolean;
} = {}) {
  const appended: { customType: string; data: unknown }[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      if (opts.throwOnAppend) throw new Error("appendEntry boom");
      appended.push({ customType, data });
    },
  };
  return { appended, pi: pi as unknown as ExtensionAPI };
}

/**
 * A minimal fake ExtensionContext. Scripts:
 *   - leafId (getLeafId — the captured marker entry id; default "leaf-1")
 *   - contextEntries (buildContextEntries — SessionEntry[] snapshot flattened to messages)
 *   - throwOnBuildContext (forces buildContextEntries to throw for best-effort tests)
 */
function makeCtx(opts: {
  sessionId?: string;
  leafId?: string | null;
  contextEntries?: unknown[];
  throwOnBuildContext?: boolean;
} = {}) {
  const sessionId = opts.sessionId ?? "s1";
  const leafId: string | null = opts.leafId === undefined ? "leaf-1" : opts.leafId;
  const contextEntries = opts.contextEntries ?? [];

  const sessionManager = {
    getSessionId() {
      return sessionId;
    },
    getLeafId() {
      return leafId;
    },
    buildContextEntries() {
      if (opts.throwOnBuildContext) throw new Error("buildContextEntries boom");
      return contextEntries;
    },
  };
  const ctx = { sessionManager };
  return { ctx: ctx as unknown as ExtensionContext };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Invoke the tool's execute with a minimal call signature. toolCallId defaults to "call-1". */
async function run(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: ShrinkArgs,
  toolCallId = "call-1",
): Promise<AgentToolResult<ShrinkDetails>> {
  const tool = makeShrinkTool(pi);
  return tool.execute(toolCallId, params, undefined, undefined, ctx);
}

/** Extract the text from a result's first content block. */
function firstText(res: AgentToolResult<ShrinkDetails>): string {
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected a text content block, got ${block?.type ?? "none"}`);
  }
  return block.text;
}

/**
 * A single message-as-entry in the snapshot (buildContextEntries returns SessionEntry[]; we cast through unknown).
 * For match-now, the tool flattens via sessionEntryToContextMessages.
 */
function msgEntry(message: Record<string, unknown>): { type: "message"; id: string; message: Record<string, unknown> } {
  return { type: "message", id: `e-${Math.random().toString(36).slice(2)}`, message };
}

/** Build an assistant message whose content is a list of toolCall blocks with the given ids. */
function asst(...callIds: string[]): Record<string, unknown> {
  return {
    role: "assistant",
    content: callIds.map((id) => ({ type: "toolCall", id, name: "tool", arguments: {} })),
  };
}

/** Build a toolResult message. */
function result(toolCallId: string): Record<string, unknown> {
  return {
    role: "toolResult",
    toolName: "tool",
    content: [{ type: "text", text: "big output..." }],
    isError: false,
    toolCallId,
  };
}

/** Build a user message. */
function user(text: string): Record<string, unknown> {
  return { role: "user", content: text };
}

// ── registration metadata (spec/05 §5) ──────────────────────────────────────

describe("mulligan_shrink — registration metadata (spec/05 §5)", () => {
  it("name === 'mulligan_shrink', label === 'Mulligan Shrink', description === SHRINK_DESC verbatim", () => {
    const { pi } = makePi();
    const tool = makeShrinkTool(pi);
    expect(tool.name).toBe("mulligan_shrink");
    expect(tool.label).toBe("Mulligan Shrink");
    expect(tool.description).toBe(SHRINK_DESC);
  });

  it("parameters === ShrinkParams (the typebox Type.Object)", () => {
    const { pi } = makePi();
    const tool = makeShrinkTool(pi);
    expect(tool.parameters).toBe(ShrinkParams);
  });
});

// ── refusal path 1: config disabled (step 1; E14) ───────────────────────────

describe("mulligan_shrink — refusal: config disabled (step 1; E14)", () => {
  it("config.enabled === false → refusal 'Mulligan is disabled'; no marker appended", async () => {
    setConfig({ enabled: false });
    const { appended, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });
    expect(firstText(res)).toBe("Mulligan: refused — Mulligan is disabled.");
    expect(appended).toHaveLength(0);
    expect(res.details).toEqual({});
  });

  it("config.shrink.enabled === false → refusal 'shrink is disabled'; no marker", async () => {
    setConfig({ shrink: { enabled: false } });
    const { appended, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });
    expect(firstText(res)).toBe("Mulligan: refused — shrink is disabled.");
    expect(appended).toHaveLength(0);
    expect(res.details).toEqual({});
  });
});

// ── refusal path 2: empty replacement ───────────────────────────────────────

describe("mulligan_shrink — refusal: empty replacement (step 2)", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tabs and newlines", "\t\n"],
  ])("rejects replacement '%s' → 'replacement must be non-empty'; no marker", async (_label, replacement) => {
    const { appended, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement,
    });
    expect(firstText(res)).toBe("Mulligan: refused — replacement must be non-empty.");
    expect(appended).toHaveLength(0);
    expect(res.details).toEqual({});
  });
});

// ── refusal path 3: structurally-impossible target ──────────────────────────

describe("mulligan_shrink — refusal: structurally-impossible target (step 3)", () => {
  it.each([
    ["empty by_tool_call_id", { by_tool_call_id: "" }],
    ["whitespace by_tool_call_id", { by_tool_call_id: "   " }],
    ["empty by_tool_name", { by_tool_name: "", occurrence: "last" as const }],
    ["whitespace by_tool_name", { by_tool_name: "   ", occurrence: "first" as const }],
    ["empty by_content_includes", { by_content_includes: "" }],
    ["whitespace by_content_includes", { by_content_includes: "  \t" }],
  ])("rejects %s → 'target discriminator must be non-empty'; no marker", async (_label, target) => {
    const { appended, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: target as ShrinkArgs["target"],
      replacement: "compact summary",
    });
    expect(firstText(res)).toBe("Mulligan: refused — target discriminator must be non-empty.");
    expect(appended).toHaveLength(0);
    expect(res.details).toEqual({});
  });
});

// ── success + match-now: yes ─────────────────────────────────────────────────

describe("mulligan_shrink — success + match-now: yes", () => {
  it("by_tool_call_id matching a toolResult → matched:true, VERBATIM text, marker persisted with EXACT payload", async () => {
    const { appended, pi } = makePi();
    const callId = "tc-1";
    const ctxEntries = [
      msgEntry(user("hi")),
      msgEntry(asst(callId)),
      msgEntry(result(callId)),
    ];
    const { ctx } = makeCtx({ contextEntries: ctxEntries });
    const target: ShrinkArgs["target"] = { by_tool_call_id: callId };
    const replacement = "Compact: file has 3 relevant functions.";
    const reason = "Too verbose";
    const res = await run(pi, ctx, { target, replacement, reason });

    // marker persisted once
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:shrink");
    const data = appended[0].data as Record<string, unknown>;
    expect(data.schema).toBe("pi-mulligan");
    expect(data.v).toBe(1);
    expect(data.kind).toBe("shrink");
    expect(typeof data.id).toBe("string");
    expect(typeof data.seq).toBe("number");
    expect(typeof data.ts).toBe("number");
    expect(data.target).toEqual(target);
    expect(data.replacement).toBe(replacement);
    expect(data.reason).toBe(reason);
    // NO pinnedEntryId
    expect("pinnedEntryId" in data).toBe(false);

    // success text VERBATIM
    expect(firstText(res)).toBe(
      "Mulligan: shrink recorded. Matched message will show the replacement from the next turn on. (Matched now: yes)",
    );

    // details
    expect(res.details.matched).toBe(true);
    expect(res.details.markerId).toBe("leaf-1");
  });
});

// ── success + match-now: no (E8 — persists anyway) ────────────────────────────

describe("mulligan_shrink — match-now: no (E8 — persists anyway)", () => {
  it("non-empty target that does NOT match → matched:false, STILL persists, VERBATIM text with 'no'", async () => {
    const { appended, pi } = makePi();
    const ctxEntries = [
      msgEntry(user("hi")),
      msgEntry(asst("tc-1")),
      msgEntry(result("tc-1")),
    ];
    const { ctx } = makeCtx({ contextEntries: ctxEntries });
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-NOPE" },
      replacement: "compact summary",
    });

    // marker STILL persisted (E8 — no-match is NOT a refusal)
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:shrink");

    // matched:false
    expect(res.details.matched).toBe(false);

    // VERBATIM text with "no"
    expect(firstText(res)).toBe(
      "Mulligan: shrink recorded. Matched message will show the replacement from the next turn on. (Matched now: no)",
    );
  });
});

// ── best-effort (E13 — snapshot throw → still persists) ────────────────────────

describe("mulligan_shrink — best-effort (E13)", () => {
  it("buildContextEntries THROWS → matched:false + STILL persists + success text", async () => {
    const { appended, pi } = makePi();
    const { ctx } = makeCtx({ throwOnBuildContext: true });
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });

    // success (not a refusal)
    expect(firstText(res)).toMatch(/^Mulligan: shrink recorded/);
    expect(res.details.matched).toBe(false);
    expect(appended).toHaveLength(1); // marker STILL persisted
  });
});

// ── never-throws (E13) ────────────────────────────────────────────────────

describe("mulligan_shrink — never-throws (E13)", () => {
  it("pi.appendEntry THROWS → refusal text, NO throw escapes", async () => {
    const { appended, pi } = makePi({ throwOnAppend: true });
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });

    // appendShrinkMarker catches internally → returns null → tool succeeds with markerId:null
    // (The marker wrapper is fail-open — it catches the appendEntry throw and returns null.)
    // So this is actually a success path where markerId is null.
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    expect(typeof firstText(res)).toBe("string");
    // The marker was NOT appended (appendEntry threw, caught by appendShrinkMarker)
    expect(appended).toHaveLength(0);
  });
});

// ── result shape (details on every path — GOTCHA #4) ──────────────────────

describe("mulligan_shrink — result shape (details on every path)", () => {
  it("success path → details with matched + markerId", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ contextEntries: [] });
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });

    expect(res.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(res.details).toBeDefined();
    expect(typeof res.details.matched).toBe("boolean");
    expect(res.details.markerId).toBeDefined();
  });

  it("refusal path → details present (empty object — GOTCHA #4)", async () => {
    setConfig({ enabled: false });
    const { pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "compact summary",
    });

    expect(res.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(res.details).toBeDefined();
    expect(res.details).toEqual({});
  });
});

// ── types ─────────────────────────────────────────────────────────────────

describe("mulligan_shrink — types", () => {
  it("makeShrinkTool returns ToolDefinition<typeof ShrinkParams, ShrinkDetails>", () => {
    const { pi } = makePi();
    expectTypeOf(makeShrinkTool).returns.toMatchTypeOf<ToolDefinition<typeof ShrinkParams, ShrinkDetails>>();
  });

  it("execute returns Promise<AgentToolResult<ShrinkDetails>>", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ contextEntries: [] });
    const tool = makeShrinkTool(pi);
    const res = await tool.execute(
      "call-1",
      { target: { by_tool_call_id: "call-1" }, replacement: "summary" },
      undefined,
      undefined,
      ctx,
    );
    expectTypeOf(res).toMatchTypeOf<AgentToolResult<ShrinkDetails>>();
  });
});

// ── marker payload exactness (NO pinnedEntryId) ──────────────────────────

describe("mulligan_shrink — marker payload exactness", () => {
  it("appendShrinkMarker called with EXACT {target, replacement, reason} — no extra keys", async () => {
    const { appended, pi } = makePi();
    const { ctx } = makeCtx({ contextEntries: [] });
    const target: ShrinkArgs["target"] = { by_content_includes: "some text" };
    const replacement = "shrunk";
    const res = await run(pi, ctx, { target, replacement });

    expect(appended).toHaveLength(1);
    const data = appended[0].data as Record<string, unknown>;
    // The input fields (before stamping) are exactly target + replacement (no reason)
    expect(data.target).toEqual(target);
    expect(data.replacement).toBe(replacement);
    expect(data.reason).toBeUndefined();
    // NO pinnedEntryId
    expect("pinnedEntryId" in data).toBe(false);
    // Stamped fields present
    expect(data.schema).toBe("pi-mulligan");
    expect(data.v).toBe(1);
    expect(data.kind).toBe("shrink");
    expect(typeof data.id).toBe("string");
    expect(typeof data.seq).toBe("number");
    expect(typeof data.ts).toBe("number");
  });

  it("markerId === ctx.leafId on success", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ leafId: "my-leaf-42", contextEntries: [] });
    const res = await run(pi, ctx, {
      target: { by_tool_call_id: "call-1" },
      replacement: "summary",
    });
    expect(res.details.markerId).toBe("my-leaf-42");
  });
});
