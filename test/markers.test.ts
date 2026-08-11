/**
 * markers.test.ts — IMPLICIT TDD suite for src/markers.ts.
 * Tests envelope/customType/seq/ts stamping, id rules (rewind+shrink uuid, turn-metric none),
 * seq monotonic + per-session isolated, C7 leaf-capture + call order, leaf-null, never-throws fail-open,
 * read-back type=custom (not custom_message), leaveNote (sendMessage/custom_message, no options, void),
 * setCheckpoint setLabel + getLabel round-trip (C9), and type-level assertions.
 */

import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from "vitest";
import {
  appendRewindMarker,
  appendShrinkMarker,
  appendTurnMetric,
  leaveNote,
  setCheckpoint,
  type MulliganEnvelope,
  type RewindMarker,
  type RewindMarkerInput,
  type ShrinkMarker,
  type ShrinkMarkerInput,
  type TurnMetric,
  type TurnMetricInput,
  type NoteDetails,
  type LeaveNoteInput,
} from "../src/markers.js";
import { clearAll } from "../src/runtime.js";
import { setLogFile } from "../src/log.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  clearAll();
  setLogFile(null);
});

afterEach(() => {
  clearAll();
  setLogFile(null);
});

// ── Fakes ──────────────────────────────────────────────────────────────────

interface FakePi {
  appended: Array<{ customType: string; data: unknown }>;
  sent: Array<{ customType: string; content: string; display: boolean; details: unknown }>;
  labels: Array<{ entryId: string; label: string }>;
  pi: ExtensionAPI;
}

interface FakeCtx {
  ctx: ExtensionContext;
  entries: Array<{ type: string; customType: string; data: unknown }>;
}

function makePi(opts: {
  throwOnAppend?: boolean;
  throwOnSendMessage?: boolean;
  throwOnSetLabel?: boolean;
} = {}): FakePi {
  const appended: FakePi["appended"] = [];
  const sent: FakePi["sent"] = [];
  const labels: FakePi["labels"] = [];

  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      if (opts.throwOnAppend) throw new Error("appendEntry boom");
      appended.push({ customType, data: data ?? null });
    },
    sendMessage: (msg: { customType: string; content: string; display: boolean; details: unknown }) => {
      if (opts.throwOnSendMessage) throw new Error("sendMessage boom");
      sent.push(msg);
    },
    setLabel: (entryId: string, label: string | undefined) => {
      if (opts.throwOnSetLabel) throw new Error("setLabel boom");
      labels.push({ entryId, label: label ?? "" });
    },
  } as unknown as ExtensionAPI;

  return { appended, sent, labels, pi };
}

function makeCtx(opts: {
  sessionId?: string;
  leafId?: string | null;
  throwOnGetSessionId?: boolean;
  throwOnGetLeafId?: boolean;
} = {}): FakeCtx {
  const sessionId = opts.sessionId ?? "s1";
  const leafId = "leafId" in opts ? opts.leafId : "leaf-1";
  const entries: FakeCtx["entries"] = [];

  // The appended entries are NOT wired into entries by default; the test that needs
  // read-back creates a custom makeCtx that does.
  const ctx = {
    sessionManager: {
      getSessionId: () => {
        if (opts.throwOnGetSessionId) throw new Error("getSessionId boom");
        return sessionId;
      },
      getLeafId: () => {
        if (opts.throwOnGetLeafId) throw new Error("getLeafId boom");
        return leafId;
      },
      getBranch: () => [
        { type: "message", id: leafId ?? "leaf-1", parentId: null },
      ],
      getEntries: () => entries,
      getLabel: (_id: string) => undefined,
    },
  } as unknown as ExtensionContext;

  return { ctx, entries };
}

/**
 * makeCtxWithReadBack — a makeCtx variant where getEntries() returns the appended entries
 * as {type:'custom', customType, data} for read-back assertions.
 */
function makeCtxWithReadBack(fakePi: FakePi, opts?: Parameters<typeof makeCtx>[0]): FakeCtx {
  const base = makeCtx(opts);
  const fakeEntries: Array<{ type: string; customType: string; data: unknown }> = [];
  base.ctx = {
    ...base.ctx,
    sessionManager: {
      ...base.ctx.sessionManager,
      getEntries: () =>
        fakePi.appended.map((a) => ({
          type: "custom" as const,
          customType: a.customType,
          data: a.data,
        })) as unknown as ReturnType<NonNullable<ExtensionContext["sessionManager"]>["getEntries"]>,
    },
  } as unknown as ExtensionContext;
  base.entries = fakeEntries;
  return base;
}

/**
 * makeCtxWithLabels — a makeCtx variant with a shared labels Map for C9 round-trip.
 */
function makeCtxWithLabels(
  labelsMap: Map<string, string>,
  opts?: Parameters<typeof makeCtx>[0],
): FakeCtx {
  const base = makeCtx(opts);
  base.ctx = {
    ...base.ctx,
    sessionManager: {
      ...base.ctx.sessionManager,
      getLabel: (id: string) => labelsMap.get(id),
    },
  } as unknown as ExtensionContext;
  return base;
}

// ── Test payloads ───────────────────────────────────────────────────────────

const REWIND_DATA: RewindMarkerInput = {
  granularity: "last_tool_call_group",
  options: { to_previous_prompt: false },
  excludeToolCallId: "call-self",
  note: {
    what_happened: "Ran grep -r auth . which returned ~38k tokens.",
    avoid: "Do not run repo-wide grep without -l.",
    true_current_state: "No files changed this turn.",
    next: "Re-run as grep -rl auth src/.",
  },
  ledger: {
    readFiles: ["src/a.ts"],
    modifiedFiles: [],
    bashSideEffects: [],
  },
};

const SHRINK_DATA: ShrinkMarkerInput = {
  target: { by_tool_name: "read", occurrence: "last" },
  replacement: "(shrunk — see original in /tree)",
  reason: "too big",
};

const METRIC_DATA: TurnMetricInput = {
  deltaTokens: 4321,
  bloatHit: true,
  bloatHits: [{ toolName: "read", approxTokens: 9412 }],
  grewOverThreshold: true,
  turnIndex: 3,
};

// ── Suites ──────────────────────────────────────────────────────────────────

describe("appendRewindMarker", () => {
  it("calls appendEntry with customType 'mulligan:rewind' and stamps envelope", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    const result = appendRewindMarker(pi, ctx, REWIND_DATA);

    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:rewind");
    const entry = appended[0].data as RewindMarker;
    expect(entry.schema).toBe("pi-mulligan");
    expect(entry.v).toBe(1);
    expect(entry.kind).toBe("rewind");
    expect(entry.seq).toBe(1);
    expect(typeof entry.ts).toBe("number");
    expect(entry.ts).toBeLessThanOrEqual(Date.now());
    expect(result).toBe("leaf-1");
  });

  it("spreads caller data verbatim into the entry", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendRewindMarker(pi, ctx, REWIND_DATA);

    const entry = appended[0].data as RewindMarker;
    expect(entry.granularity).toBe("last_tool_call_group");
    expect(entry.options.to_previous_prompt).toBe(false);
    expect(entry.excludeToolCallId).toBe("call-self");
    expect(entry.note.what_happened).toBe(REWIND_DATA.note.what_happened);
    expect(entry.ledger.readFiles).toEqual(["src/a.ts"]);
  });

  it("returns the leaf id from getLeafId()", () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-42" });

    const result = appendRewindMarker(pi, ctx, REWIND_DATA);
    expect(result).toBe("leaf-42");
  });
});

describe("appendShrinkMarker", () => {
  it("calls appendEntry with customType 'mulligan:shrink' and stamps envelope", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    const result = appendShrinkMarker(pi, ctx, SHRINK_DATA);

    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:shrink");
    const entry = appended[0].data as ShrinkMarker;
    expect(entry.schema).toBe("pi-mulligan");
    expect(entry.v).toBe(1);
    expect(entry.kind).toBe("shrink");
    expect(entry.seq).toBe(1);
    expect(typeof entry.ts).toBe("number");
    expect(result).toBe("leaf-1");
  });

  it("stamps id as a UUID and spreads caller data", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendShrinkMarker(pi, ctx, SHRINK_DATA);

    const entry = appended[0].data as ShrinkMarker;
    expect(typeof entry.id).toBe("string");
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(entry.target).toEqual(SHRINK_DATA.target);
    expect(entry.replacement).toBe(SHRINK_DATA.replacement);
    expect(entry.reason).toBe(SHRINK_DATA.reason);
  });
});

describe("appendTurnMetric", () => {
  it("calls appendEntry with customType 'mulligan:turn-metric' and stamps envelope", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    const result = appendTurnMetric(pi, ctx, METRIC_DATA);

    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:turn-metric");
    const entry = appended[0].data as TurnMetric;
    expect(entry.schema).toBe("pi-mulligan");
    expect(entry.v).toBe(1);
    expect(entry.kind).toBe("turn-metric");
    expect(entry.seq).toBe(1);
    expect(typeof entry.ts).toBe("number");
    expect(result).toBe("leaf-1");
  });

  it("does NOT stamp id (spec/04 §5 — TurnMetric has no id field)", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendTurnMetric(pi, ctx, METRIC_DATA);

    const entry = appended[0].data as TurnMetric;
    expect(entry).not.toHaveProperty("id");
  });

  it("spreads caller data verbatim", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendTurnMetric(pi, ctx, METRIC_DATA);

    const entry = appended[0].data as TurnMetric;
    expect(entry.deltaTokens).toBe(4321);
    expect(entry.bloatHit).toBe(true);
    expect(entry.bloatHits).toEqual([{ toolName: "read", approxTokens: 9412 }]);
    expect(entry.grewOverThreshold).toBe(true);
    expect(entry.turnIndex).toBe(3);
  });
});

describe("id stamping", () => {
  it("rewind and shrink stamp id as UUID; turn-metric has no id", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendRewindMarker(pi, ctx, REWIND_DATA);
    appendShrinkMarker(pi, ctx, SHRINK_DATA);
    appendTurnMetric(pi, ctx, METRIC_DATA);

    const rw = appended[0].data as RewindMarker;
    const sh = appended[1].data as ShrinkMarker;
    const tm = appended[2].data as TurnMetric;

    expect(rw.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sh.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tm).not.toHaveProperty("id");
  });

  it("two rewind calls produce distinct ids", () => {
    const { pi, appended } = makePi();
    const { ctx: ctx1 } = makeCtx({ sessionId: "s1" });
    const { ctx: ctx2 } = makeCtx({ sessionId: "s2" });

    appendRewindMarker(pi, ctx1, REWIND_DATA);
    appendRewindMarker(pi, ctx2, REWIND_DATA);

    const id1 = (appended[0].data as RewindMarker).id;
    const id2 = (appended[1].data as RewindMarker).id;
    expect(id1).not.toBe(id2);
  });
});

describe("seq monotonicity and per-session isolation", () => {
  it("shared counter: rewind=1, shrink=2, turn-metric=3 within one session", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendRewindMarker(pi, ctx, REWIND_DATA);
    appendShrinkMarker(pi, ctx, SHRINK_DATA);
    appendTurnMetric(pi, ctx, METRIC_DATA);

    expect((appended[0].data as RewindMarker).seq).toBe(1);
    expect((appended[1].data as ShrinkMarker).seq).toBe(2);
    expect((appended[2].data as TurnMetric).seq).toBe(3);
  });

  it("a second session starts at seq 1 (isolated)", () => {
    const { pi, appended } = makePi();
    const { ctx: ctx1 } = makeCtx({ sessionId: "session-a" });
    const { ctx: ctx2 } = makeCtx({ sessionId: "session-b" });

    appendRewindMarker(pi, ctx1, REWIND_DATA); // seq 1 in session-a
    appendRewindMarker(pi, ctx2, REWIND_DATA); // seq 1 in session-b

    expect((appended[0].data as RewindMarker).seq).toBe(1);
    expect((appended[1].data as RewindMarker).seq).toBe(1);
  });
});

describe("C7 — leaf-id capture and call order", () => {
  it("appendEntry called exactly once and return === getLeafId()", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx({ leafId: "my-leaf" });

    const result = appendRewindMarker(pi, ctx, REWIND_DATA);

    expect(appended).toHaveLength(1);
    expect(result).toBe("my-leaf");
  });

  it("appendShrinkMarker calls appendEntry exactly once", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendShrinkMarker(pi, ctx, SHRINK_DATA);
    expect(appended).toHaveLength(1);
  });

  it("appendTurnMetric calls appendEntry exactly once", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx();

    appendTurnMetric(pi, ctx, METRIC_DATA);
    expect(appended).toHaveLength(1);
  });
});

describe("leaf-null path", () => {
  it("all three append wrappers return null when getLeafId() returns null", () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ leafId: null });

    // Markers ARE still appended (appendEntry succeeds)
    const r1 = appendRewindMarker(pi, ctx, REWIND_DATA);
    const r2 = appendShrinkMarker(pi, ctx, SHRINK_DATA);
    const r3 = appendTurnMetric(pi, ctx, METRIC_DATA);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });

  it("marker is still appended even when getLeafId() returns null", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx({ leafId: null });

    appendRewindMarker(pi, ctx, REWIND_DATA);
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe("mulligan:rewind");
  });
});

describe("never-throws fail-open", () => {
  it("throwing appendEntry → null, no throw", () => {
    const { pi } = makePi({ throwOnAppend: true });
    const { ctx } = makeCtx();

    expect(() => appendRewindMarker(pi, ctx, REWIND_DATA)).not.toThrow();
    expect(appendRewindMarker(pi, ctx, REWIND_DATA)).toBeNull();
  });

  it("throwing getSessionId → null, no throw", () => {
    const { pi } = makePi();
    const { ctx } = makeCtx({ throwOnGetSessionId: true });

    expect(() => appendShrinkMarker(pi, ctx, SHRINK_DATA)).not.toThrow();
    expect(appendShrinkMarker(pi, ctx, SHRINK_DATA)).toBeNull();
  });

  it("throwing getLeafId → null, no throw (marker still appended)", () => {
    const { pi, appended } = makePi();
    const { ctx } = makeCtx({ throwOnGetLeafId: true });

    const result = appendTurnMetric(pi, ctx, METRIC_DATA);
    expect(result).toBeNull();
    // The appendEntry succeeded before getLeafId threw
    expect(appended).toHaveLength(1);
  });

  it("throwing setLabel in setCheckpoint → null, no throw", () => {
    const { pi } = makePi({ throwOnSetLabel: true });
    const { ctx } = makeCtx();

    expect(() => setCheckpoint(pi, ctx, "test")).not.toThrow();
    expect(setCheckpoint(pi, ctx, "test")).toBeNull();
  });

  it("throwing sendMessage in leaveNote → no throw, returns void", () => {
    const { pi } = makePi({ throwOnSendMessage: true });

    expect(() => leaveNote(pi, { content: "note text", rewindId: "rw-1" })).not.toThrow();
    const result = leaveNote(pi, { content: "note text", rewindId: "rw-1" });
    expect(result).toBeUndefined();
  });
});

describe("read-back type=custom (not custom_message)", () => {
  it("rewind marker entry type is 'custom' and customType is 'mulligan:rewind'", () => {
    const fakePi = makePi();
    const fake = makeCtxWithReadBack(fakePi);

    appendRewindMarker(fakePi.pi, fake.ctx, REWIND_DATA);

    const entries = fake.ctx.sessionManager.getEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0] as unknown as { type: string; customType: string };
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("mulligan:rewind");
  });

  it("shrink marker entry type is 'custom'", () => {
    const fakePi = makePi();
    const fake = makeCtxWithReadBack(fakePi);

    appendShrinkMarker(fakePi.pi, fake.ctx, SHRINK_DATA);

    const entries = fake.ctx.sessionManager.getEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0] as unknown as { type: string; customType: string };
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("mulligan:shrink");
  });
});

describe("leaveNote", () => {
  it("calls sendMessage with correct customType, content, display, and details", () => {
    const { pi, sent } = makePi();

    leaveNote(pi, { content: "## Note content", rewindId: "rw-abc" });

    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("mulligan:note");
    expect(sent[0].content).toBe("## Note content");
    expect(sent[0].display).toBe(true);
    expect(sent[0].details).toEqual({
      schema: "pi-mulligan",
      v: 1,
      kind: "note",
      rewindId: "rw-abc",
    });
  });

  it("does NOT call appendEntry or setLabel", () => {
    const { pi, appended, labels } = makePi();

    leaveNote(pi, { content: "note", rewindId: "rw-1" });

    expect(appended).toHaveLength(0);
    expect(labels).toHaveLength(0);
  });

  it("returns void (undefined)", () => {
    const { pi } = makePi();
    const result = leaveNote(pi, { content: "note", rewindId: "rw-1" });
    expect(result).toBeUndefined();
  });

  it("throwing sendMessage does not throw", () => {
    const { pi } = makePi({ throwOnSendMessage: true });
    expect(() => leaveNote(pi, { content: "note", rewindId: "rw-1" })).not.toThrow();
  });
});

describe("leaveNote channel = custom_message (not custom)", () => {
  it("uses sent[] (sendMessage), NOT appended[] (appendEntry)", () => {
    const { pi, appended, sent } = makePi();

    leaveNote(pi, { content: "note", rewindId: "rw-1" });

    // Note goes via sendMessage (in context), NOT appendEntry (not in context)
    expect(appended).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});

describe("setCheckpoint", () => {
  it("calls setLabel with (targetId, 'mulligan:checkpoint:<name>') and returns targetId", () => {
    const { pi, labels } = makePi();
    const { ctx } = makeCtx({ leafId: "leaf-99" });

    const result = setCheckpoint(pi, ctx, "before-x");

    expect(result).toBe("leaf-99");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual({ entryId: "leaf-99", label: "mulligan:checkpoint:before-x" });
  });

  it("prefixes the checkpoint name correctly", () => {
    const { pi, labels } = makePi();
    const { ctx } = makeCtx();

    setCheckpoint(pi, ctx, "x_y-z1");

    expect(labels[0].label).toBe("mulligan:checkpoint:x_y-z1");
  });

  it("returns null when getLeafId() returns null and does NOT call setLabel", () => {
    const { pi, labels } = makePi();
    const { ctx } = makeCtx({ leafId: null });

    const result = setCheckpoint(pi, ctx, "test");

    expect(result).toBeNull();
    expect(labels).toHaveLength(0);
  });

  it("throwing setLabel returns null, no throw", () => {
    const { pi } = makePi({ throwOnSetLabel: true });
    const { ctx } = makeCtx();

    expect(() => setCheckpoint(pi, ctx, "test")).not.toThrow();
    expect(setCheckpoint(pi, ctx, "test")).toBeNull();
  });
});

describe("setCheckpoint/getLabel round-trip (C9)", () => {
  it("setLabel writes and getLabel reads back the same label", () => {
    const labelsMap = new Map<string, string>();
    const { pi, labels } = makePi();
    const { ctx } = makeCtxWithLabels(labelsMap, { leafId: "leaf-55" });

    // setCheckpoint calls pi.setLabel which pushes to labels[]
    const result = setCheckpoint(pi, ctx, "my-cp");
    expect(result).toBe("leaf-55");

    // Wire the label from pi.setLabel into the labelsMap for the fake getLabel
    expect(labels).toHaveLength(1);
    labelsMap.set(labels[0].entryId, labels[0].label);

    // getLabel reads back
    const readback = ctx.sessionManager.getLabel("leaf-55");
    expect(readback).toBe("mulligan:checkpoint:my-cp");
  });
});

describe("type-level assertions (compile-time)", () => {
  it("MulliganEnvelope kind union is 'rewind' | 'shrink' | 'turn-metric'", () => {
    expectTypeOf<MulliganEnvelope["kind"]>().toEqualTypeOf<"rewind" | "shrink" | "turn-metric">();
  });

  it("RewindMarker narrows kind to 'rewind'", () => {
    expectTypeOf<RewindMarker["kind"]>().toEqualTypeOf<"rewind">();
  });

  it("ShrinkMarker narrows kind to 'shrink'", () => {
    expectTypeOf<ShrinkMarker["kind"]>().toEqualTypeOf<"shrink">();
  });

  it("TurnMetric narrows kind to 'turn-metric' and has NO id", () => {
    expectTypeOf<TurnMetric["kind"]>().toEqualTypeOf<"turn-metric">();
    // TurnMetric should not have an 'id' property
    const _tm: TurnMetric = {
      schema: "pi-mulligan",
      v: 1,
      kind: "turn-metric",
      seq: 1,
      ts: 0,
      deltaTokens: null,
      bloatHit: false,
      bloatHits: [],
      grewOverThreshold: false,
      turnIndex: 0,
    };
    expect(_tm).not.toHaveProperty("id");
  });

  it("LeaveNoteInput shape is { content: string; rewindId: string }", () => {
    expectTypeOf<LeaveNoteInput>().toHaveProperty("content").toEqualTypeOf<string>();
    expectTypeOf<LeaveNoteInput>().toHaveProperty("rewindId").toEqualTypeOf<string>();
  });

  it("NoteDetails has schema/v/kind/rewindId", () => {
    expectTypeOf<NoteDetails["schema"]>().toEqualTypeOf<"pi-mulligan">();
    expectTypeOf<NoteDetails["v"]>().toEqualTypeOf<1>();
    expectTypeOf<NoteDetails["kind"]>().toEqualTypeOf<"note">();
    expectTypeOf<NoteDetails["rewindId"]>().toEqualTypeOf<string>();
  });

  it("return types: append*/setCheckpoint = string | null; leaveNote = void", () => {
    expectTypeOf(appendRewindMarker).returns.toEqualTypeOf<string | null>();
    expectTypeOf(appendShrinkMarker).returns.toEqualTypeOf<string | null>();
    expectTypeOf(appendTurnMetric).returns.toEqualTypeOf<string | null>();
    expectTypeOf(setCheckpoint).returns.toEqualTypeOf<string | null>();
    expectTypeOf(leaveNote).returns.toEqualTypeOf<void>();
  });

  it("RewindMarker.hideEntryIds is string[] | undefined", () => {
    expectTypeOf<RewindMarker['hideEntryIds']>().toEqualTypeOf<string[] | undefined>();
  });

  it("RewindMarkerInput auto-gains hideEntryIds via Omit", () => {
    const _riPinned: RewindMarkerInput = {
      granularity: "last_tool_call_group",
      options: { to_previous_prompt: false },
      note: { what_happened: "x", avoid: "y", true_current_state: "z", next: "n" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
      hideEntryIds: ['e1', 'e2'],
    };
    expect(_riPinned.hideEntryIds).toEqual(['e1', 'e2']);
  });

  it("Input types are Omit of wrapper-stamped fields", () => {
    // RewindMarkerInput omits schema, v, kind, id, seq, ts
    const _ri: RewindMarkerInput = {
      granularity: "last_tool_call_group",
      options: { to_previous_prompt: false },
      note: { what_happened: "x", avoid: "y", true_current_state: "z", next: "n" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
    };

    // ShrinkMarkerInput omits schema, v, kind, id, seq, ts
    const _si: ShrinkMarkerInput = {
      target: { by_tool_name: "read", occurrence: "last" },
      replacement: "summary",
    };

    // TurnMetricInput omits schema, v, kind, seq, ts (no id to omit)
    const _ti: TurnMetricInput = {
      deltaTokens: null,
      bloatHit: false,
      bloatHits: [],
      grewOverThreshold: false,
      turnIndex: 0,
    };

    expect(_ri).toBeDefined();
    expect(_si).toBeDefined();
    expect(_ti).toBeDefined();
  });
});
