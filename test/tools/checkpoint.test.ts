/**
 * checkpoint.test.ts — unit tests for the `mulligan_checkpoint` tool (src/tools/checkpoint.ts).
 *
 * Mirrors the house test idiom from test/tools/shrink.test.ts: vitest, hand-rolled
 * `makePi()`/`makeCtx()` fakes (NO vi.fn()), `.js` import paths, `expectTypeOf` for type assertions,
 * `clearAll()` runtime reset before/after each test.
 *
 * Coverage:
 *   a) registration metadata (spec/05 §5): name/label/description/parameters.
 *   b) refusal: config disabled (E14 master switch).
 *   c) refusal: invalid name (E10 regex matrix).
 *   d) success happy path: exact setLabel args + VERBATIM text + details.
 *   e) setCheckpoint returns null (null leaf).
 *   f) setCheckpoint returns null (throwing setLabel).
 *   g) never-throws (E13).
 *   h) result shape: details on every path (GOTCHA #4).
 *   i) types: ToolDefinition / AgentToolResult.
 */
import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from "vitest";
import {
  makeCheckpointTool,
  CheckpointParams,
  CKPT_DESC,
  type CheckpointArgs,
  type CheckpointDetails,
} from "../../src/tools/checkpoint.js";
import { clearAll } from "../../src/runtime.js";
import { setConfig } from "../../src/config.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// nextSeq mutates the SHARED module-scoped runtime map. clearAll() before AND after each test
// so a previous test's seq can't leak in. ALSO reset the config cache to defaults.
beforeEach(() => {
  clearAll();
  setConfig(undefined);
});
afterEach(() => {
  clearAll();
  setConfig(undefined);
});

// ── fakes (mirrors shrink.test.ts makePi/makeCtx) ──────────────────────────────

/** A minimal fake ExtensionAPI capturing setLabel (hand-rolled, no vi.fn()). */
function makePi(opts: { throwOnSetLabel?: boolean } = {}) {
  const labels: { entryId: string; label: string }[] = [];
  const pi = {
    setLabel(entryId: string, label: string) {
      if (opts.throwOnSetLabel) throw new Error("setLabel boom");
      labels.push({ entryId, label });
    },
  };
  return { labels, pi: pi as unknown as ExtensionAPI };
}

/**
 * A minimal fake ExtensionContext. Provides:
 *   - sessionId (getSessionId)
 *   - leafId (getLeafId — default "leaf-1"; null to simulate no-leaf)
 *   - getLabel backed by a Map (for round-trip asserts if needed)
 *   - throwOnGetSessionId (forces getSessionId to throw for never-throws tests)
 */
function makeCtx(opts: {
  sessionId?: string;
  leafId?: string | null;
  labels?: Map<string, string>;
  throwOnGetSessionId?: boolean;
} = {}) {
  const sessionId = opts.sessionId ?? "s1";
  const leafId: string | null = opts.leafId === undefined ? "leaf-1" : opts.leafId;
  const labelMap = opts.labels ?? new Map();

  const sessionManager = {
    getSessionId() {
      if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
      return sessionId;
    },
    getLeafId() {
      return leafId;
    },
    getBranch() {
      return [{ type: "message", id: leafId ?? "leaf-1", parentId: null }];
    },
    getLabel(id: string) {
      return labelMap.get(id) ?? null;
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
  params: CheckpointArgs,
  toolCallId = "call-1",
): Promise<AgentToolResult<CheckpointDetails>> {
  const tool = makeCheckpointTool(pi);
  return tool.execute(toolCallId, params, undefined, undefined, ctx);
}

/** Extract the text from a result's first content block. */
function firstText(res: AgentToolResult<CheckpointDetails>): string {
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected a text content block, got ${block?.type ?? "none"}`);
  }
  return block.text;
}

// ── registration metadata (spec/05 §5) ──────────────────────────────────────

describe("mulligan_checkpoint — registration metadata (spec/05 §5)", () => {
  it("name === 'mulligan_checkpoint', label === 'Mulligan Checkpoint', description === CKPT_DESC verbatim", () => {
    const { pi } = makePi();
    const tool = makeCheckpointTool(pi);
    expect(tool.name).toBe("mulligan_checkpoint");
    expect(tool.label).toBe("Mulligan Checkpoint");
    expect(tool.description).toBe(CKPT_DESC);
  });

  it("parameters === CheckpointParams (the typebox Type.Object)", () => {
    const { pi } = makePi();
    const tool = makeCheckpointTool(pi);
    expect(tool.parameters).toBe(CheckpointParams);
  });
});

// ── refusal: config disabled (E14) ─────────────────────────────────────────

describe("mulligan_checkpoint — refusal: config disabled (E14)", () => {
  it("config.enabled === false → refusal 'Mulligan is disabled'; no label set", async () => {
    setConfig({ enabled: false });
    const { labels, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, { name: "before-refactor-x" });
    expect(firstText(res)).toBe("Mulligan: refused — Mulligan is disabled.");
    expect(labels).toHaveLength(0);
    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("");
  });
});

// ── refusal: invalid name (E10) ────────────────────────────────────────────

describe("mulligan_checkpoint — refusal: invalid name (E10)", () => {
  it.each([
    ["Has Uppercase"],
    ["with spaces"],
    ["has.dots"],
    ["has/slash"],
    [""],
    ["   "],
    ["a".repeat(41)],
    ["ünïcode"],
    ["has$dollar"],
  ])("rejects '%s' → refusal with regex reason; no label set", async (invalidName) => {
    const { labels, pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, { name: invalidName });
    expect(firstText(res)).toMatch(/^Mulligan: refused — .*must match.*\[a-z0-9_-]/);
    expect(labels).toHaveLength(0);
    expect(res.details).toBeDefined();
  });
});

// ── success happy path ─────────────────────────────────────────────────────

describe("mulligan_checkpoint — success", () => {
  it("valid name → setLabel called once with (leafId, 'mulligan:checkpoint:<name>'); VERBATIM text; details", async () => {
    const { labels, pi } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-42" });
    const name = "before-refactor-x";
    const res = await run(pi, ctx, { name });

    // setLabel called exactly once
    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual({ entryId: "leaf-42", label: "mulligan:checkpoint:before-refactor-x" });

    // VERBATIM success text
    expect(firstText(res)).toBe(
      `Mulligan: checkpoint '${name}' set at entry leaf-42. ` +
        `Rewind to it with mulligan_rewind(granularity:'checkpoint', checkpoint:'${name}').`,
    );

    // details
    expect(res.details.name).toBe(name);
    expect(res.details.entryId).toBe("leaf-42");
  });

  it("valid name with hyphens/underscores/digits → exact prefix", async () => {
    const { labels, pi } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-99" });
    const name = "x_y-z1";
    const res = await run(pi, ctx, { name });

    expect(labels).toHaveLength(1);
    expect(labels[0].label).toBe("mulligan:checkpoint:x_y-z1");
    expect(firstText(res)).toContain(`checkpoint '${name}' set at entry leaf-99`);
    expect(res.details.entryId).toBe("leaf-99");
    expect(res.details.name).toBe(name);
  });
});

// ── setCheckpoint returns null (null leaf) ──────────────────────────────────

describe("mulligan_checkpoint — setCheckpoint returns null (null leaf)", () => {
  it("makeCtx({leafId:null}) → refusal text; labels empty", async () => {
    const { labels, pi } = makePi();
    const { ctx } = makeCtx({ leafId: null });
    const res = await run(pi, ctx, { name: "my-checkpoint" });

    expect(firstText(res)).toMatch(/^Mulligan: refused — .*could not set checkpoint/);
    expect(labels).toHaveLength(0);
    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("my-checkpoint");
  });
});

// ── setCheckpoint returns null (throwing setLabel) ─────────────────────────

describe("mulligan_checkpoint — setCheckpoint returns null (throwing setLabel)", () => {
  it("makePi({throwOnSetLabel:true}) → refusal text; NEVER throws", async () => {
    const { labels, pi } = makePi({ throwOnSetLabel: true });
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, { name: "my-checkpoint" });

    // setCheckpoint catches the throw internally → returns null → refusal
    expect(firstText(res)).toMatch(/^Mulligan: refused — .*could not set checkpoint/);
    expect(labels).toHaveLength(0); // setLabel threw before capturing
    expect(res.details).toBeDefined();
  });
});

// ── never-throws (E13) ────────────────────────────────────────────────────

describe("mulligan_checkpoint — never-throws (E13)", () => {
  it("ctx whose getSessionId throws → refusal text, no throw escapes (setCheckpoint catches internally → null)", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ throwOnGetSessionId: true });

    // setCheckpoint catches getSessionId throw internally → returns null → tool returns null-leaf refusal
    // The key assertion: no throw escapes the tool.
    const res = await run(pi, ctx, { name: "test-ckpt" });

    expect(firstText(res)).toMatch(/^Mulligan: refused — .*could not set checkpoint/);
    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("test-ckpt");
  });
});

// ── result shape (details on every path — GOTCHA #4) ──────────────────────

describe("mulligan_checkpoint — result shape (details on every path)", () => {
  it("success path → details with name + entryId", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-1" });
    const res = await run(pi, ctx, { name: "before-x" });

    expect(res.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("before-x");
    expect(res.details.entryId).toBe("leaf-1");
  });

  it("refusal path → details with name (entryId undefined)", async () => {
    setConfig({ enabled: false });
    const { pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, { name: "before-x" });

    expect(res.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("");
    expect(res.details.entryId).toBeUndefined();
  });

  it("invalid-name refusal → details with the invalid name", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx();
    const res = await run(pi, ctx, { name: "BAD" });

    expect(res.details).toBeDefined();
    expect(res.details.name).toBe("BAD");
    expect(res.details.entryId).toBeUndefined();
  });
});

// ── types ─────────────────────────────────────────────────────────────────

describe("mulligan_checkpoint — types", () => {
  it("makeCheckpointTool returns ToolDefinition<typeof CheckpointParams, CheckpointDetails>", () => {
    const { pi } = makePi();
    expectTypeOf(makeCheckpointTool).returns.toMatchTypeOf<ToolDefinition<typeof CheckpointParams, CheckpointDetails>>();
  });

  it("execute returns Promise<AgentToolResult<CheckpointDetails>>", async () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-1" });
    const tool = makeCheckpointTool(pi);
    const res = await tool.execute("call-1", { name: "before-x" }, undefined, undefined, ctx);
    expectTypeOf(res).toMatchTypeOf<AgentToolResult<CheckpointDetails>>();
  });
});
