import { describe, it, expect, expectTypeOf } from "vitest";
import {
  partitionIntoUnits,
  resolveLastToolCallGroup,
  resolveLastTurn,
  resolveCheckpoint,
  mapEntryIdsToMessageIndices,
  applyRewind,
  resolveShrinkTarget,
  applyShrink,
  type ShrinkTarget,
  type Unit,
  type MessageLike,
  type BranchEntry,
} from "../src/transforms.js";

// No beforeEach needed: transforms.ts has NO module-scoped mutable state (pure over its arguments).

// ── fixture builders (mirror ledger.test.ts's `asst`) ───────────────────────────

/** Build an assistant message whose content is a list of toolCall blocks with the given ids. */
function asst(...callIds: string[]): MessageLike {
  return {
    role: "assistant",
    content: callIds.map((id) => ({ type: "toolCall", id, name: "tool", arguments: {} })),
  };
}

/** Build a text-only assistant (no toolCalls) → must be a plain unit. */
function asstText(text: string): MessageLike {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Build a toolResult message for the given toolCallId (optionally custom toolName). */
function result(toolCallId: string, toolName?: string): MessageLike {
  return {
    role: "toolResult",
    toolCallId,
    toolName: toolName ?? "tool",
    content: [{ type: "text", text: "..." }],
    isError: false,
  };
}

/** Build a user message. */
function user(text: string): MessageLike {
  return { role: "user", content: text };
}

/** Build a custom message (e.g. mulligan:note / mulligan:nudge) → must be a plain unit. */
function custom(customType: string): MessageLike {
  return { role: "custom", customType, content: "x", display: true };
}

/** Build a minimal branch entry (SessionEntry-like). */
function entry(id: string, type: BranchEntry["type"], extra: Record<string, unknown> = {}): BranchEntry {
  return { type, id, parentId: null, timestamp: "t", ...extra };
}

/** Build a mulligan:checkpoint LabelEntry pointing at targetId. */
function labelEntry(id: string, targetId: string, name: string): BranchEntry {
  return { type: "label", id, parentId: null, timestamp: "t", targetId, label: `mulligan:checkpoint:${name}` };
}

/** Compact per-unit summary "kind:minIdx:len" for readable multi-unit assertions. */
function summary(units: Unit[]): string {
  return units.map((u) => `${u.kind}:${u.indices[0]}:${u.indices.length}`).join(" | ");
}

/**
 * The pairing invariant (forward direction — always true): for every toolGroup unit, (i) it contains exactly one
 * assistant member, and (ii) every OTHER member is a toolResult whose toolCallId is one of that assistant's toolCall
 * ids. Used across many tests. (The "vice versa" — every call has a result — holds only when all results are present;
 * asserted separately in the fully-paired 3+3 case — GOTCHA #13.)
 */
function expectPairingInvariant(messages: MessageLike[], units: Unit[]): void {
  for (const u of units) {
    if (u.kind === "plain") {
      expect(u.indices, "plain unit spans exactly one index").toHaveLength(1);
      continue;
    }
    // toolGroup: find the assistant member, assert every other member is a matching toolResult.
    const asstIdx = u.indices.find((i) => messages[i]?.role === "assistant");
    expect(asstIdx, "toolGroup must contain an assistant message").toBeTypeOf("number");
    const asstMsg = messages[asstIdx as number] as MessageLike;
    const content = asstMsg.content;
    expect(Array.isArray(content), "assistant content is a block array").toBe(true);
    const callIds = new Set(
      (content as Array<Record<string, unknown>>)
        .filter((b) => b?.type === "toolCall" && typeof b.id === "string")
        .map((b) => b.id as string),
    );
    expect(callIds.size, "the assistant issued ≥1 pairable toolCall").toBeGreaterThan(0);
    for (const i of u.indices) {
      if (i === asstIdx) continue;
      const r = messages[i] as MessageLike;
      expect(r?.role, "non-assistant toolGroup member is a toolResult").toBe("toolResult");
      expect(callIds.has(r.toolCallId as string), "result's toolCallId ∈ the assistant's call ids").toBe(true);
    }
  }
}

// ── spec/10 §1.1 PINNED contract (the load-bearing tests) ──────────────────────

describe("partitionIntoUnits — spec/10 §1.1 PINNED contract", () => {
  it("[user, assistant(1 toolCall), result, assistant(text)] → 3 units (plain, toolGroup[1,2], plain)", () => {
    const msgs: MessageLike[] = [user("do it"), asst("c1"), result("c1"), asstText("done")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(3);
    expect(summary(units)).toBe("plain:0:1 | toolGroup:1:2 | plain:3:1");
    expect(units[0]).toEqual({ indices: [0], kind: "plain" }); // user
    expect(units[1]).toEqual({ indices: [1, 2], kind: "toolGroup" }); // assistant(c1) + result(c1)
    expect(units[2]).toEqual({ indices: [3], kind: "plain" }); // text assistant
    expectPairingInvariant(msgs, units);
  });

  it("orphan result (no matching toolCall) → its OWN plain unit; never merged (spec/08 E1)", () => {
    const msgs: MessageLike[] = [user("hi"), result("orphan-1")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(2);
    expect(summary(units)).toBe("plain:0:1 | plain:1:1");
    expect(units.every((u) => u.kind === "plain")).toBe(true); // nothing merged
    // the orphan result (index 1) stands alone as plain
    expect(units[1]).toEqual({ indices: [1], kind: "plain" });
  });

  it("assistant with 3 toolCalls + 3 results → ONE toolGroup with 4 indices", () => {
    const msgs: MessageLike[] = [asst("c1", "c2", "c3"), result("c1"), result("c2"), result("c3")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ indices: [0, 1, 2, 3], kind: "toolGroup" }); // 4 indices, sorted ascending
    expectPairingInvariant(msgs, units);
    // "vice versa" (reverse) — holds in the fully-paired case: every call id has a result in the unit (GOTCHA #13)
    const asstMsg = msgs[0];
    const content = asstMsg.content as Array<Record<string, unknown>>;
    const callIds = content.filter((b) => b?.type === "toolCall").map((b) => b.id as string);
    const resultIds = new Set(units[0].indices.slice(1).map((i) => (msgs[i] as MessageLike).toolCallId as string));
    for (const id of callIds) {
      expect(resultIds.has(id), `every call id ${id} has its result in the toolGroup`).toBe(true);
    }
  });

  it("invariant holds across a mixed list (the forward direction — GOTCHA #13)", () => {
    const msgs: MessageLike[] = [
      user("u"),
      asst("a"), result("a"),
      asstText("thinking..."),
      asst("b", "c"), result("b"), result("c"),
      result("orphan"),
    ];
    const units = partitionIntoUnits(msgs);
    expectPairingInvariant(msgs, units); // forward invariant; never throws, never asserts falsely
  });
});

// ── corner cases (spec/06 §2 corner cases) ─────────────────────────────────────

describe("partitionIntoUnits — spec/06 §2 corner cases", () => {
  it("assistant with toolCalls but NO results yet → toolGroup of just the assistant", () => {
    const msgs: MessageLike[] = [user("go"), asst("pending")]; // no result for "pending"
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("plain:0:1 | toolGroup:1:1");
    expect(units[1]).toEqual({ indices: [1], kind: "toolGroup" }); // NOT demoted to plain
    expectPairingInvariant(msgs, units);
  });

  it("parallel-tool mode: ONE assistant with 2 toolCalls + 2 results → ONE toolGroup (spec/06 §9)", () => {
    const msgs: MessageLike[] = [asst("p1", "p2"), result("p1"), result("p2")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ indices: [0, 1, 2], kind: "toolGroup" });
    expectPairingInvariant(msgs, units);
  });

  it("two SEPARATE assistant+result pairs → two toolGroups", () => {
    const msgs: MessageLike[] = [asst("a"), result("a"), asst("b"), result("b")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | toolGroup:2:2");
    expectPairingInvariant(msgs, units);
  });

  it("interleaved: asst(a), asst(b), result(a), result(b) → two toolGroups [0,2] and [1,3]", () => {
    const msgs: MessageLike[] = [asst("a"), asst("b"), result("a"), result("b")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | toolGroup:1:2");
    expect(units[0].indices).toEqual([0, 2]); // asst(a) groups with result(a) at index 2
    expect(units[1].indices).toEqual([1, 3]); // asst(b) groups with result(b) at index 3
    expectPairingInvariant(msgs, units);
  });

  it("a toolResult whose assistant had only a malformed (no-id) call → orphan → plain unit", () => {
    // assistant at 0 has a toolCall with NO valid id; result at 1 references "x" → no match → orphan plain
    const msgs: MessageLike[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "", name: "t", arguments: {} }] },
      result("x"),
    ] as unknown as MessageLike[];
    const units = partitionIntoUnits(msgs);
    expect(units.every((u) => u.kind === "plain")).toBe(true); // both plain: can't confirm either pair
    expect(units).toHaveLength(2);
  });
});

// ── plain units (non-tool messages) ─────────────────────────────────────────────

describe("partitionIntoUnits — plain units (everything not in a toolGroup)", () => {
  it("empty message list → []", () => {
    expect(partitionIntoUnits([])).toEqual([]);
  });

  it("a list with NO tools → all plain units, one per message, in order", () => {
    const msgs: MessageLike[] = [user("a"), asstText("b"), custom("mulligan:note"), user("c")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("plain:0:1 | plain:1:1 | plain:2:1 | plain:3:1");
    expect(units.every((u) => u.kind === "plain")).toBe(true);
  });

  it("custom messages (mulligan:note / mulligan:nudge) → plain units", () => {
    const msgs: MessageLike[] = [custom("mulligan:note"), custom("mulligan:nudge")];
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === "plain")).toBe(true);
  });

  it("a text-only assistant sandwiched between two toolGroups stays plain", () => {
    const msgs: MessageLike[] = [asst("a"), result("a"), asstText("commentary"), asst("b"), result("b")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | plain:2:1 | toolGroup:3:2");
    expect(units[1]).toEqual({ indices: [2], kind: "plain" });
    expectPairingInvariant(msgs, units);
  });
});

// ── defensive / never throws (spec/08 E13; context-handler hot path) ────────────

describe("partitionIntoUnits — defensive (NEVER throws — GOTCHA #8)", () => {
  it("null / undefined / non-array messages → [] (no throw)", () => {
    expect(partitionIntoUnits(null)).toEqual([]);
    expect(partitionIntoUnits(undefined)).toEqual([]);
    expect(partitionIntoUnits("not-an-array" as unknown as MessageLike[])).toEqual([]);
    expect(partitionIntoUnits({} as unknown as MessageLike[])).toEqual([]);
  });

  it("a non-record message element is skipped gracefully (no throw)", () => {
    const msgs = [null, 42, "raw", undefined] as unknown as MessageLike[];
    expect(() => partitionIntoUnits(msgs)).not.toThrow();
    // 4 plain units (each garbage index stands alone as plain)
    expect(partitionIntoUnits(msgs)).toHaveLength(4);
    expect(partitionIntoUnits(msgs).every((u) => u.kind === "plain")).toBe(true);
  });

  it("an assistant with non-array content → plain (no toolCall blocks read)", () => {
    const msgs: MessageLike[] = [{ role: "assistant", content: "just a string" }] as unknown as MessageLike[];
    expect(() => partitionIntoUnits(msgs)).not.toThrow();
    expect(partitionIntoUnits(msgs)).toEqual([{ indices: [0], kind: "plain" }]);
  });

  it("toolCall blocks with missing / non-string / empty ids are not pairable (GOTCHA #4)", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "t", arguments: {} }, // missing id
          { type: "toolCall", id: 123, name: "t", arguments: {} }, // non-string id
          { type: "toolCall", id: "", name: "t", arguments: {} }, // empty id
          { type: "text", text: "hi" },
        ],
      } as unknown as MessageLike,
    ];
    const units = partitionIntoUnits(msgs);
    expect(units).toEqual([{ indices: [0], kind: "plain" }]); // no valid-id call → plain
  });

  it("duplicate toolCallId across two results → BOTH group with the assistant (orphan-safe — GOTCHA #9)", () => {
    const msgs: MessageLike[] = [asst("dup"), result("dup"), result("dup")]; // two results, one call id
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("toolGroup");
    expect(units[0].indices).toEqual([0, 1, 2]); // both results join the SAME toolGroup → no orphan on removal
  });

  it("a result appearing BEFORE its assistant still pairs (order-robust — GOTCHA #9)", () => {
    const msgs: MessageLike[] = [result("x"), asst("x")]; // result at 0, assistant at 1 (malformed order)
    const units = partitionIntoUnits(msgs);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ indices: [0, 1], kind: "toolGroup" }); // grouped + sorted ascending
  });

  it("never throws on a throwing-Proxy message (fail-open like tokens.ts/ledger.ts)", () => {
    const trap: MessageLike = new Proxy(
      { role: "assistant", content: [{ type: "toolCall", id: "t", name: "x", arguments: {} }] } as MessageLike,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => partitionIntoUnits([trap])).not.toThrow();
    // every property read throws → readOwn swallows → treated as non-record/non-assistant → plain unit
    expect(partitionIntoUnits([trap])).toEqual([{ indices: [0], kind: "plain" }]);
  });

  it("accepts a real-ish Pi AgentMessage[] shape (structural typing)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "..." }], isError: false },
    ] as const;
    const units = partitionIntoUnits(msgs as unknown as MessageLike[]);
    expect(summary(units)).toBe("plain:0:1 | toolGroup:1:2");
    expectPairingInvariant(msgs as unknown as MessageLike[], units);
  });
});

// ── ordering & determinism ──────────────────────────────────────────────────────

describe("partitionIntoUnits — ordering & determinism", () => {
  it("units are ordered by their minimum index (indices[0])", () => {
    const msgs: MessageLike[] = [user("u"), asst("a"), result("a"), asst("b"), result("b")];
    const units = partitionIntoUnits(msgs);
    const mins = units.map((u) => u.indices[0]);
    expect(mins).toEqual([...mins].sort((x, y) => x - y)); // strictly non-decreasing
  });

  it("toolGroup indices are sorted ascending", () => {
    const msgs: MessageLike[] = [asst("a", "b"), result("b"), result("a")]; // results in non-call order
    const units = partitionIntoUnits(msgs);
    expect(units[0].indices).toEqual([0, 1, 2]); // ascending, regardless of call/result order
  });

  it("is pure / idempotent — same input → same output across calls", () => {
    const msgs: MessageLike[] = [user("u"), asst("a"), result("a")];
    const a = partitionIntoUnits(msgs);
    const b = partitionIntoUnits(msgs);
    expect(a).toEqual(b);
  });

  it("does not mutate its input", () => {
    const msgs: MessageLike[] = [user("u"), asst("a"), result("a")];
    const snapshot = JSON.stringify(msgs);
    partitionIntoUnits(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("a representative summary is captured via inline snapshot", () => {
    const msgs: MessageLike[] = [
      user("please"),
      asst("c1"),
      result("c1"),
      asstText("ok"),
      asst("c2", "c3"),
      result("c2"),
      result("c3"),
    ];
    expect(summary(partitionIntoUnits(msgs))).toMatchInlineSnapshot(
      `"plain:0:1 | toolGroup:1:2 | plain:3:1 | toolGroup:4:3"`,
    );
  });
});

// ── types ───────────────────────────────────────────────────────────────────────

describe("types", () => {
  it("partitionIntoUnits returns Unit[]", () => {
    expectTypeOf(partitionIntoUnits([])).toEqualTypeOf<Unit[]>();
  });

  it("Unit has the spec/06 §2 shape", () => {
    const u: Unit = { indices: [0], kind: "plain" };
    expectTypeOf(u).toEqualTypeOf<Unit>();
    expectTypeOf(u.indices).toEqualTypeOf<number[]>();
    expectTypeOf(u.kind).toEqualTypeOf<"plain" | "toolGroup">();
  });

  it("MessageLike accepts real-ish Pi message shapes (structural typing)", () => {
    const m1: MessageLike = { role: "user", content: "hi" };
    const m2: MessageLike = {
      role: "assistant",
      content: [{ type: "toolCall", id: "x", name: "read", arguments: { path: "a.ts" } }],
    };
    const m3: MessageLike = { role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "y" }] };
    const m4: MessageLike = { role: "custom", customType: "mulligan:note", content: "note", display: true };
    expectTypeOf(m1).toEqualTypeOf<MessageLike>();
    expectTypeOf(m2).toEqualTypeOf<MessageLike>();
    expectTypeOf(m3).toEqualTypeOf<MessageLike>();
    expectTypeOf(m4).toEqualTypeOf<MessageLike>();
  });

  it("accepts null | undefined input (defensive signature)", () => {
    expectTypeOf(partitionIntoUnits(null)).toEqualTypeOf<Unit[]>();
    expectTypeOf(partitionIntoUnits(undefined)).toEqualTypeOf<Unit[]>();
  });
});

// ── resolveLastToolCallGroup (spec/10 §1.2) ────────────────────────────────────────────

describe("resolveLastToolCallGroup — spec/10 §1.2 PINNED contract", () => {
  it("no exclude → returns the LAST toolGroup's indices (a(B)+r(B))", () => {
    const msgs: MessageLike[] = [user("u"), asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("plain:0:1 | toolGroup:1:2 | toolGroup:3:2");
    expect(resolveLastToolCallGroup(units, msgs)).toEqual([3, 4]); // the a(B)+r(B) toolGroup
  });

  it("excludeToolCallId='B' → returns the a(A)+r(A) toolGroup's indices (skips the rewind's own)", () => {
    const msgs: MessageLike[] = [user("u"), asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(resolveLastToolCallGroup(units, msgs, "B")).toEqual([1, 2]); // the a(A)+r(A) toolGroup
  });

  it("no toolGroup at all → null", () => {
    const msgs: MessageLike[] = [user("u"), asstText("thinking"), custom("mulligan:note")];
    const units = partitionIntoUnits(msgs);
    expect(units.every((u) => u.kind === "plain")).toBe(true);
    expect(resolveLastToolCallGroup(units, msgs)).toBeNull();
  });
});

describe("resolveLastToolCallGroup — exclude semantics", () => {
  it("excludeToolCallId matching NO unit → returns the last toolGroup (nothing skipped)", () => {
    const msgs: MessageLike[] = [user("u"), asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(resolveLastToolCallGroup(units, msgs, "DOES-NOT-EXIST")).toEqual([3, 4]);
  });

  it("only ONE toolGroup and exclude matches it → null (the only toolGroup was the rewind's own)", () => {
    const msgs: MessageLike[] = [user("u"), asst("only"), result("only")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("plain:0:1 | toolGroup:1:2");
    expect(resolveLastToolCallGroup(units, msgs, "only")).toBeNull();
  });

  it("excludeToolCallId is undefined → never skips (same as no exclude)", () => {
    const msgs: MessageLike[] = [asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(resolveLastToolCallGroup(units, msgs, undefined)).toEqual([2, 3]);
  });

  it("excludeToolCallId is empty string / non-string → never skips", () => {
    const msgs: MessageLike[] = [asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(resolveLastToolCallGroup(units, msgs, "")).toEqual([2, 3]);
    expect(resolveLastToolCallGroup(units, msgs, 123 as unknown as string)).toEqual([2, 3]);
  });

  it("skips EVERY toolGroup whose assistant issued the exclude id, landing on an earlier one", () => {
    const msgs: MessageLike[] = [asst("X"), result("X"), asst("Y"), result("Y"), asst("Z"), result("Z")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | toolGroup:2:2 | toolGroup:4:2");
    expect(resolveLastToolCallGroup(units, msgs, "Z")).toEqual([2, 3]);
  });
});

describe("resolveLastToolCallGroup — parallel-tool mode (spec/06 §9 / spec/08 E6)", () => {
  it("rewind shares an assistant message with a sibling call → that toolGroup is skipped, previous returned", () => {
    const msgs: MessageLike[] = [
      asst("prev"),
      result("prev"),
      asst("X", "REW"), // shared assistant message
      result("X"),
      result("REW"),
    ];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | toolGroup:2:3");
    expect(resolveLastToolCallGroup(units, msgs, "REW")).toEqual([0, 1]);
  });

  it("only the shared toolGroup exists → exclude it → null", () => {
    const msgs: MessageLike[] = [asst("A", "REW"), result("A"), result("REW")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:3");
    expect(resolveLastToolCallGroup(units, msgs, "REW")).toBeNull();
  });
});

describe("resolveLastToolCallGroup — defensive (NEVER throws — spec/08 E13)", () => {
  it("non-array units → null (no throw)", () => {
    expect(resolveLastToolCallGroup(null as unknown as Unit[], [])).toBeNull();
    expect(resolveLastToolCallGroup(undefined as unknown as Unit[], [])).toBeNull();
    expect(resolveLastToolCallGroup("nope" as unknown as Unit[], [])).toBeNull();
  });

  it("a toolGroup whose assistant is a throwing-Proxy → no match → returned (fail-safe, no throw)", () => {
    const trap: MessageLike = new Proxy(
      { role: "assistant", content: [{ type: "toolCall", id: "self", name: "mulligan_rewind", arguments: {} }] } as MessageLike,
      new Proxy({}, { get() { throw new Error("trap"); } }),
    );
    const msgs: MessageLike[] = [asst("real"), result("real"), trap, result("self")];
    const units = partitionIntoUnits(msgs);
    expect(() => resolveLastToolCallGroup(units, msgs, "self")).not.toThrow();
    expect(resolveLastToolCallGroup(units, msgs, "self")).not.toBeNull();
  });

  it("malformed messages array (non-array) → exclude never matches → returns last toolGroup", () => {
    const msgs = "garbage" as unknown as MessageLike[];
    const units: Unit[] = [
      { indices: [0, 1], kind: "toolGroup" },
      { indices: [2, 3], kind: "toolGroup" },
    ];
    expect(resolveLastToolCallGroup(units, msgs, "whatever")).toEqual([2, 3]);
  });

  it("a malformed unit record in the list is skipped, not crashing", () => {
    const msgs: MessageLike[] = [asst("A"), result("A")];
    const units = [
      null,
      { kind: "toolGroup" }, // no indices
      { indices: [0, 1], kind: "toolGroup" },
    ] as unknown as Unit[];
    expect(() => resolveLastToolCallGroup(units, msgs)).not.toThrow();
    expect(resolveLastToolCallGroup(units, msgs)).toEqual([0, 1]);
  });
});

describe("resolveLastToolCallGroup — ordering, purity, types", () => {
  it("plain units interspersed between toolGroups are skipped", () => {
    const msgs: MessageLike[] = [asst("A"), result("A"), asstText("chat"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    expect(summary(units)).toBe("toolGroup:0:2 | plain:2:1 | toolGroup:3:2");
    expect(resolveLastToolCallGroup(units, msgs)).toEqual([3, 4]);
  });

  it("is pure / idempotent — same input → same output, no mutation", () => {
    const msgs: MessageLike[] = [user("u"), asst("A"), result("A"), asst("B"), result("B")];
    const units = partitionIntoUnits(msgs);
    const a = resolveLastToolCallGroup(units, msgs, "B");
    const b = resolveLastToolCallGroup(units, msgs, "B");
    expect(a).toEqual(b);
    expect(JSON.stringify(units)).toBe(JSON.stringify(partitionIntoUnits(msgs)));
  });

  it("returns the unit's indices reference (the exact indices array)", () => {
    const msgs: MessageLike[] = [user("u"), asst("A"), result("A")];
    const units = partitionIntoUnits(msgs);
    const toolGroup = units.find((u) => u.kind === "toolGroup")!;
    expect(resolveLastToolCallGroup(units, msgs)).toBe(toolGroup.indices); // same array reference
  });

  it("returns number[] | null", () => {
    expectTypeOf(resolveLastToolCallGroup([], [])).toEqualTypeOf<number[] | null>();
    expectTypeOf(resolveLastToolCallGroup([], [], "x")).toEqualTypeOf<number[] | null>();
  });
});

// ── resolveLastTurn (spec/10 §1.3) ────────────────────────────────────────────────────

describe("resolveLastTurn — spec/10 §1.3 PINNED contract", () => {
  const twoTurns = (): MessageLike[] => [
    user("u0"), asst("c0"), result("c0"),
    user("u1"), asst("c1"), result("c1"),
  ];

  it("default → remove indices AFTER u1 (keep u1): remove = [4,5]", () => {
    expect(resolveLastTurn(twoTurns(), {}).remove).toEqual([4, 5]);
    expect(resolveLastTurn(twoTurns(), undefined).remove).toEqual([4, 5]); // opts may be undefined
  });

  it("to_previous_prompt:true → ALSO remove u1: remove = [3,4,5] (iLastUser=3, iFirstUser=0 → allowed)", () => {
    expect(resolveLastTurn(twoTurns(), { to_previous_prompt: true }).remove).toEqual([3, 4, 5]);
  });

  it("u1 is the FIRST user → nuclear refused by protected check: { remove: [] }", () => {
    const singleTurn: MessageLike[] = [user("only"), asst("c"), result("c")];
    expect(resolveLastTurn(singleTurn, { to_previous_prompt: true })).toEqual({ remove: [] });
  });
});

describe("resolveLastTurn — the rewind's OWN unit survives (default)", () => {
  it("rewind's assistant+result after iLastUser are kept; prior-turn work is removed", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("prev"), result("prev"), asst("REW"), result("REW"),
    ];
    expect(resolveLastTurn(msgs, {}, "REW").remove).toEqual([4, 5]); // [6,7] kept (rewind's own unit)
  });

  it("rewind's own unit is kept WHOLE even if it shares a message (parallel-tool — spec/06 §9 / spec/08 E6)", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("prev"), result("prev"), asst("sib", "REW"), result("sib"), result("REW"),
    ];
    expect(resolveLastTurn(msgs, {}, "REW").remove).toEqual([4, 5]); // shared unit [6,7,8] kept whole
  });
});

describe("resolveLastTurn — mulligan:* notes survive at the tail", () => {
  it("a mulligan:note after iLastUser is NOT removed", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("c1"), result("c1"), custom("mulligan:note"),
    ];
    expect(resolveLastTurn(msgs, {}).remove).toEqual([4, 5]);
  });

  it("a mulligan:nudge (ephemeral) after iLastUser is also kept", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("c1"), result("c1"), custom("mulligan:nudge"),
    ];
    expect(resolveLastTurn(msgs, {}).remove).toEqual([4, 5]);
  });

  it("multiple mulligan:* notes interspersed with removed work all survive", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("c1"), result("c1"), custom("mulligan:note"), custom("mulligan:note"),
    ];
    expect(resolveLastTurn(msgs, {}).remove).toEqual([4, 5]);
  });
});

describe("resolveLastTurn — no-op cases", () => {
  it("no user message at all → { remove: [] }", () => {
    const msgs: MessageLike[] = [asst("c"), result("c"), custom("mulligan:note")];
    expect(resolveLastTurn(msgs, {})).toEqual({ remove: [] });
    expect(resolveLastTurn(msgs, { to_previous_prompt: true })).toEqual({ remove: [] });
  });

  it("nothing after iLastUser → { remove: [] }", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), user("u1")];
    expect(resolveLastTurn(msgs, {})).toEqual({ remove: [] });
    expect(resolveLastTurn(msgs, { to_previous_prompt: true }).remove).toEqual([3]);
  });
});

describe("resolveLastTurn — excludeToolCallId semantics", () => {
  it("excludeToolCallId absent → rewind's own unit is NOT kept (removed with the rest); note survives", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("REW"), result("REW"), asst("c2"), result("c2"), custom("mulligan:note"),
    ];
    expect(resolveLastTurn(msgs, {}).remove).toEqual([4, 5, 6, 7]);
  });

  it("excludeToolCallId empty string / non-string → never keeps an own unit", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("REW"), result("REW"),
    ];
    expect(resolveLastTurn(msgs, {}, "").remove).toEqual([4, 5]);
    expect(resolveLastTurn(msgs, {}, 123 as unknown as string).remove).toEqual([4, 5]);
  });

  it("excludeToolCallId matching NO unit → nothing kept (same as absent)", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("c1"), result("c1"),
    ];
    expect(resolveLastTurn(msgs, {}, "DOES-NOT-EXIST").remove).toEqual([4, 5]);
  });
});

describe("resolveLastTurn — nuclear edge cases", () => {
  it("two user messages, nuclear on the 2nd → removes iLastUser + after (previous prompt remains)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), user("u1"), asst("c1"), result("c1")];
    expect(resolveLastTurn(msgs, { to_previous_prompt: true }).remove).toEqual([3, 4, 5]);
  });

  it("three user messages, nuclear → removes only the LAST user + after", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u3"), asst("c1"), result("c1"),
      user("u5"), asst("c2"), result("c2"),
    ];
    expect(resolveLastTurn(msgs, { to_previous_prompt: true }).remove).toEqual([6, 7, 8]);
  });

  it("default is NEVER refused on a single-user list (keeps that user)", () => {
    const msgs: MessageLike[] = [user("only"), asst("c"), result("c")];
    expect(resolveLastTurn(msgs, {}).remove).toEqual([1, 2]);
  });
});

describe("resolveLastTurn — defensive (NEVER throws — spec/08 E13)", () => {
  it("non-array messages → { remove: [] } (no throw)", () => {
    expect(resolveLastTurn(null as unknown as MessageLike[], {})).toEqual({ remove: [] });
    expect(resolveLastTurn(undefined as unknown as MessageLike[], {})).toEqual({ remove: [] });
    expect(resolveLastTurn("nope" as unknown as MessageLike[], {})).toEqual({ remove: [] });
  });

  it("malformed opts (non-object / missing field) → treated as default (not nuclear)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), user("u1"), asst("c1"), result("c1")];
    expect(resolveLastTurn(msgs, "bad" as unknown as { to_previous_prompt?: boolean }).remove).toEqual([4, 5]);
    expect(resolveLastTurn(msgs, { to_previous_prompt: false }).remove).toEqual([4, 5]);
  });

  it("a throwing-Proxy user message is skipped (readOwn swallows) — no throw", () => {
    const trap: MessageLike = new Proxy(
      { role: "user", content: "boom" } as MessageLike,
      new Proxy({}, { get() { throw new Error("trap"); } }),
    );
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), trap];
    expect(() => resolveLastTurn(msgs, {})).not.toThrow();
    expect(resolveLastTurn(msgs, {}).remove).toEqual([1, 2, 3]);
  });

  it("a throwing-Proxy mulligan message is removed (cannot confirm it is mulligan:*) — no throw, no crash", () => {
    const trap: MessageLike = new Proxy(
      { role: "custom", customType: "mulligan:note", content: "n" } as MessageLike,
      new Proxy({}, { get() { throw new Error("trap"); } }),
    );
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c"), trap];
    expect(() => resolveLastTurn(msgs, {})).not.toThrow();
    expect(resolveLastTurn(msgs, {}).remove).toEqual([1, 2, 3]);
  });
});

describe("resolveLastTurn — purity, ordering, types", () => {
  it("is pure / idempotent — same input → same output, no mutation", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), user("u1"), asst("c1"), result("c1")];
    const a = resolveLastTurn(msgs, {});
    const b = resolveLastTurn(msgs, {});
    expect(a).toEqual(b);
  });

  it("remove is ASCENDING (deterministic) for the nuclear case", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c0"), result("c0"), user("u1"), asst("c1"), result("c1")];
    const remove = resolveLastTurn(msgs, { to_previous_prompt: true }).remove;
    const sorted = [...remove].sort((x, y) => x - y);
    expect(remove).toEqual(sorted);
  });

  it("returns { remove: number[] } (the object wrapper, not a bare array or null)", () => {
    expectTypeOf(resolveLastTurn([], {})).toEqualTypeOf<{ remove: number[] }>();
    expectTypeOf(resolveLastTurn([], { to_previous_prompt: true })).toEqualTypeOf<{ remove: number[] }>();
    expectTypeOf(resolveLastTurn([], undefined, "x")).toEqualTypeOf<{ remove: number[] }>();
  });
});

// ── resolveCheckpoint (spec/06 §6) ────────────────────────────────────────────────────

describe("resolveCheckpoint — spec/06 §6 + mapping + compaction-refuse + defensive + tail-exclusions", () => {
  it("(clean) basic mapping — checkpoint mid-branch removes strictly-later work, keeps the point + before", () => {
    const msgs: MessageLike[] = [user("u1"), asst("c1"), result("c1"), asstText("junk")];
    const branchEntries: BranchEntry[] = [
      entry("e1", "message"), entry("e2", "message"), labelEntry("eL", "e2", "ckpt"),
      entry("e3", "message"), entry("e4", "message"),
    ];
    const res = resolveCheckpoint(msgs, branchEntries, "ckpt");
    expect(res).not.toBeNull();
    expect(res!.remove).toEqual([3]); // UNIT-SNAP: iTarget snapped 1→2 (unit [1,2]); only asstText idx3 removed
  });

  it("keeps the checkpoint point itself (iTarget never in remove) and everything before", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), entry("e_asst", "message"), labelEntry("eL", "e_asst", "p"),
      entry("e_result", "message"),
    ];
    const res = resolveCheckpoint(msgs, branch, "p");
    expect(res!.remove).toEqual([]); // UNIT-SNAP: iTarget 1→2; nothing > 2; asst+result both KEPT
    expect(res!.remove).not.toContain(1);
    expect(res!.remove).not.toContain(0);
  });

  it("UNIT-SNAP (BUG-003 secondary): a checkpoint on an assistant WITH tool calls keeps the WHOLE toolGroup", () => {
    const msgs: MessageLike[] = [user("u1"), asst("c1"), result("c1"), asstText("junk")];
    const branch: BranchEntry[] = [
      entry("e1", "message"), entry("e2", "message"), labelEntry("eL", "e2", "ckpt"),
      entry("e3", "message"), entry("e4", "message"),
    ];
    const res = resolveCheckpoint(msgs, branch, "ckpt");
    expect(res).not.toBeNull();
    expect(res!.remove).toEqual([3]);
    expect(res!.remove).not.toContain(1); // asst(c1) KEPT
    expect(res!.remove).not.toContain(2); // result(c1) KEPT — pairing preserved
  });

  it("UNIT-SNAP: a checkpoint on an assistant with MULTIPLE parallel results keeps the whole multi-result toolGroup", () => {
    const msgs: MessageLike[] = [user("u"), asst("p1", "p2"), result("p1"), result("p2"), asstText("tail")];
    const branch: BranchEntry[] = [
      entry("eu", "message"), entry("ea", "message"), labelEntry("eL", "ea", "m"),
      entry("er1", "message"), entry("er2", "message"), entry("et", "message"),
    ];
    const res = resolveCheckpoint(msgs, branch, "m");
    expect(res!.remove).toEqual([4]);
    expect(res!.remove).not.toContain(1);
    expect(res!.remove).not.toContain(2);
    expect(res!.remove).not.toContain(3); // both results survive
  });

  it("tail-exclusion: the rewind's own unit survives after iTarget", () => {
    const msgs: MessageLike[] = [user("u"), asst("rw-call"), result("rw-call"), asstText("bad")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), labelEntry("eL", "e_user", "k"), entry("e_asst_rw", "message"),
      entry("e_result", "message"), entry("e_text", "message"),
    ];
    const res = resolveCheckpoint(msgs, branch, "k", "rw-call");
    expect(res!.remove).toEqual([3]); // asst(text) removed; own unit (idx1,2) KEPT
    expect(res!.remove).not.toContain(1);
    expect(res!.remove).not.toContain(2);
  });

  it("tail-exclusion: a mulligan:note / mulligan:nudge custom_message after iTarget survives", () => {
    const msgs: MessageLike[] = [user("u"), result("c"), custom("mulligan:note"), custom("mulligan:nudge")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), labelEntry("eL", "e_user", "k"), entry("e_result", "message"),
      entry("e_note", "custom_message"), entry("e_nudge", "custom_message"),
    ];
    const res = resolveCheckpoint(msgs, branch, "k");
    expect(res!.remove).toEqual([1]); // only the result removed; note + nudge survive
  });

  it("compaction between root and checkpoint → REFUSE (null) — mapping indeterminate", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const branch: BranchEntry[] = [
      entry("e_comp", "compaction", { summary: "s", firstKeptEntryId: "e_user" }),
      entry("e_user", "message"), entry("e_asst", "message"), labelEntry("eL", "e_asst", "k"),
      entry("e_result", "message"),
    ];
    expect(resolveCheckpoint(msgs, branch, "k")).toBeNull();
  });

  it("compaction AFTER the checkpoint is not walked → mapping succeeds", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c"), asstText("post")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), entry("e_asst", "message"), labelEntry("eL", "e_asst", "k"),
      entry("e_result", "message"), entry("e_post", "message"),
      entry("e_comp", "compaction", { summary: "s", firstKeptEntryId: "e_result" }),
    ];
    const res = resolveCheckpoint(msgs, branch, "k");
    expect(res).not.toBeNull();
    expect(res!.remove).toEqual([3]); // UNIT-SNAP: iTarget 1→2; only asstText idx3 removed
  });

  it("checkpoint not found on branch → null (spec/08 E10)", () => {
    const branch: BranchEntry[] = [entry("e1", "message"), entry("e2", "message")];
    expect(resolveCheckpoint([user("u")], branch, "nope")).toBeNull();
  });

  it("checkpoint targetId labels a NON-context-producing entry → filtered out → null", () => {
    const branch: BranchEntry[] = [
      labelEntry("eL", "e_marker", "k"), entry("e_marker", "custom", { customType: "mulligan:rewind", data: {} }),
      entry("e_user", "message"),
    ];
    expect(resolveCheckpoint([user("u")], branch, "k")).toBeNull();
  });

  it("nothing after iTarget → { remove: [] } (determinable-but-empty, NOT null)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), entry("e_asst", "message"), labelEntry("eL", "e_asst", "k"),
    ];
    const res = resolveCheckpoint(msgs, branch, "k");
    expect(res).not.toBeNull();
    expect(res!.remove).toEqual([]);
  });

  it("defensive: non-array messages → null; non-array branchEntries → null; empty checkpointName → null", () => {
    expect(resolveCheckpoint(null as unknown as MessageLike[], [], "k")).toBeNull();
    expect(resolveCheckpoint([], null as unknown as BranchEntry[], "k")).toBeNull();
    expect(resolveCheckpoint([], [], "")).toBeNull();
    expect(resolveCheckpoint([], [], "   ")).toBeNull();
  });

  it("excludeToolCallId absent/empty/non-string → rewind's own unit NOT kept; note still survives", () => {
    const msgs: MessageLike[] = [user("u"), asst("rw-call"), result("rw-call"), custom("mulligan:note")];
    const branch: BranchEntry[] = [
      entry("e_user", "message"), labelEntry("eL", "e_user", "k"), entry("e_asst", "message"),
      entry("e_result", "message"), entry("e_note", "custom_message"),
    ];
    expect(resolveCheckpoint(msgs, branch, "k")!.remove).toEqual([1, 2]);
    expect(resolveCheckpoint(msgs, branch, "k", "")!.remove).toEqual([1, 2]);
  });

  it("never throws on throwing-Proxy messages/entries (E13)", () => {
    const throwingMsg = new Proxy({}, { get() { throw new Error("trap"); } });
    const throwingEntry = new Proxy({}, { get() { throw new Error("trap"); } }) as unknown as BranchEntry;
    expect(() => resolveCheckpoint([throwingMsg as unknown as MessageLike], [throwingEntry], "k")).not.toThrow();
  });

  it("returns { remove: number[] } | null (the exact union, never a bare array)", () => {
    expectTypeOf(resolveCheckpoint([], [], "x")).toEqualTypeOf<{ remove: number[] } | null>();
    const ok = resolveCheckpoint([user("u")], [labelEntry("eL", "e1", "x"), entry("e1", "message")], "x");
    expectTypeOf(ok).toEqualTypeOf<{ remove: number[] } | null>();
  });
});

// ── mapEntryIdsToMessageIndices (P1.M2.T1.S2) ────────────────────────────────────────────────────────────
describe("mapEntryIdsToMessageIndices — spec/06 §6 entry-id→message-index mapping (P1.M2.T1.S2)", () => {
  it("known id → correct index (single)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asstText("t")];
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message"), entry("e4", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e2"])).toEqual([1]);
  });

  it("known ids → ascending indices (multiple)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asstText("t")];
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message"), entry("e4", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e1", "e3"])).toEqual([0, 2]);
  });

  it("accepts Set<string> input", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asstText("t")];
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message"), entry("e4", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, new Set(["e2", "e3"]))).toEqual([1, 2]);
  });

  it("compaction present → indeterminate entry skipped; entries after compaction also skipped (partial-collect)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const branch = [entry("e_comp", "compaction"), entry("e_user", "message"), entry("e_asst", "message")];
    // e_comp is indeterminate (yield<0) → stop immediately, nothing collected
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e_comp"])).toEqual([]);
    // e_asst is after the compaction → also unreachable
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e_asst"])).toEqual([]);
    // requesting both → nothing collected (stop at compaction before either match)
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e_comp", "e_asst"])).toEqual([]);
  });

  it("unknown id → absent from result", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1")];
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["no-such-id"])).toEqual([]);
  });

  it("empty entryIds (array and Set) → []", () => {
    const msgs: MessageLike[] = [user("u")];
    const branch = [entry("e1", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, [])).toEqual([]);
    expect(mapEntryIdsToMessageIndices(msgs, branch, new Set())).toEqual([]);
  });

  it("alignment-lost: msgs shorter than ctxEntries → stops at mismatch, returns collected-so-far", () => {
    const msgs: MessageLike[] = [user("u")]; // only 1 message
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message")];
    // e1 maps to msgCursor=0, yield=1, 0+1=1 <= 1 (ok). e2: msgCursor=1, yield=1, 1+1=2 > 1 → stop
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e2"])).toEqual([]);
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e1"])).toEqual([0]);
  });

  it("branch_summary / custom_message each yield 1", () => {
    const msgs: MessageLike[] = [user("u"), asstText("t")];
    const branch = [entry("e_bs", "branch_summary"), entry("e_cm", "custom_message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e_bs"])).toEqual([0]);
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e_cm"])).toEqual([1]);
  });

  it("dedupe: duplicate ids in input produce ascending unique output", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1")];
    const branch = [entry("e1", "message"), entry("e2", "message"), entry("e3", "message")];
    expect(mapEntryIdsToMessageIndices(msgs, branch, ["e1", "e1", "e3", "e3"])).toEqual([0, 2]);
  });

  it("defensive (never throws): non-array inputs, null/undefined entryIds, throwing-Proxy entries", () => {
    expect(mapEntryIdsToMessageIndices(null as unknown as MessageLike[], [], [])).toEqual([]);
    expect(mapEntryIdsToMessageIndices([], null as unknown as BranchEntry[], [])).toEqual([]);
    expect(mapEntryIdsToMessageIndices([], {} as unknown as BranchEntry[], [])).toEqual([]);
    expect(mapEntryIdsToMessageIndices([], undefined as unknown as BranchEntry[], [])).toEqual([]);
    const throwingEntry = new Proxy({}, { get() { throw new Error("trap"); } }) as unknown as BranchEntry;
    expect(() => mapEntryIdsToMessageIndices([user("u")], [throwingEntry], ["x"])).not.toThrow();
  });

  it("refactor seam: helper's last index matches resolveCheckpoint's iTarget on clean fixture", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asstText("t"), user("u2")];
    const branch = [
      labelEntry("eL", "e2", "k"),
      entry("e1", "message"),
      entry("e2", "message"),
      entry("e3", "message"),
      entry("e4", "message"),
      entry("e5", "message"),
    ];
    const helperResult = mapEntryIdsToMessageIndices(msgs, branch, ["e2"]);
    expect(helperResult).toEqual([1]);
    const checkpointResult = resolveCheckpoint(msgs, branch, "k");
    // resolveCheckpoint should find iTarget = 1 (e2's last msg index = 0+1-1 = 0? No — e1→msg0, e2→msg1, iTarget=1)
    expect(checkpointResult).not.toBeNull();
    // helper's last index must match the index resolveCheckpoint keeps as iTarget
    // For e2 (message, yield=1): msgCursor after e1 = 1, so e2 → index 1, iTarget = 1
    expect(helperResult[helperResult.length - 1]).toBe(1);
  });

  it("type: returns number[]", () => {
    expectTypeOf(mapEntryIdsToMessageIndices([], [], [])).toEqualTypeOf<number[]>();
  });
});

// ── applyRewind (spec/10 §1.4) ────────────────────────────────────────────────────────────────────

describe("applyRewind — spec/10 §1.4 (gap-closed removal, pairing intact, idempotent)", () => {
  it("removing a toolGroup's indices keeps pairing (spec/06 §3/§4)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asst("c2"), result("c2")];
    const out = applyRewind(msgs, [3, 4]);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
    expect(out[2].role).toBe("toolResult");
    const units = partitionIntoUnits(out);
    expectPairingInvariant(out, units);
  });

  it("removing a range keeps mulligan:note at tail and preserves pairing", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("c1"), result("c1"), asst("c2"), result("c2"), custom("mulligan:note"),
    ];
    // remove the last toolGroup (c2)
    const out = applyRewind(msgs, [6, 7]);
    expect(out).toHaveLength(7);
    expect(out[3].role).toBe("user");
    expect(out[6].role).toBe("custom"); // mulligan:note survives
    const units = partitionIntoUnits(out);
    expectPairingInvariant(out, units);
  });

  it("empty remove → SAME ref (idempotent — spec/10 §1.4)", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(applyRewind(msgs, [])).toBe(msgs);
    expect(applyRewind(msgs, [])).toBe(msgs);
  });

  it("non-array messages → []", () => {
    expect(applyRewind(null as unknown as MessageLike[], [])).toEqual([]);
    expect(applyRewind(undefined as unknown as MessageLike[], [])).toEqual([]);
  });

  it("non-array remove → SAME ref (no throw)", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(applyRewind(msgs, null as unknown as number[])).toBe(msgs);
    expect(applyRewind(msgs, "x" as unknown as number[])).toBe(msgs);
  });

  it("remove with NaN / non-number → ignored (SAME ref)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    expect(applyRewind(msgs, [NaN])).toBe(msgs); // NaN excluded
    expect(applyRewind(msgs, ["x" as unknown as number])).toBe(msgs);
  });

  it("out-of-range indices are harmlessly skipped (new array but same content)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const out = applyRewind(msgs, [100]);
    expect(out).toEqual(msgs); // same content
    expect(out).not.toBe(msgs); // but new array (filter ran)
  });

  it("does not mutate input", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const snapshot = JSON.stringify(msgs);
    applyRewind(msgs, [1, 2]);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("output is contiguous (gap-closed, no holes)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("a"), result("a"), asst("b"), result("b"), user("u1")];
    const out = applyRewind(msgs, [2, 4]); // remove result(a) and result(b)
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
  });

  it("never throws on adversarial input (E13)", () => {
    const msgs = [null, undefined, 42] as unknown as MessageLike[];
    expect(() => applyRewind(msgs, [0, 1, 2])).not.toThrow();
    expect(() => applyRewind(msgs, [])).not.toThrow();
  });

  it("returns MessageLike[]", () => {
    expectTypeOf(applyRewind([] as MessageLike[], [])).toEqualTypeOf<MessageLike[]>();
  });
});

// ── resolveShrinkTarget (spec/06 §5; spec/04 §4) ──────────────────────────────────────────────────

describe("resolveShrinkTarget — three matcher strategies + null/no-match", () => {
  it("by_tool_call_id → first toolResult with that id", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asst("c2"), result("c2")];
    expect(resolveShrinkTarget(msgs, { by_tool_call_id: "c2" })).toBe(4);
    expect(resolveShrinkTarget(msgs, { by_tool_call_id: "c1" })).toBe(2);
  });

  it("by_tool_call_id → null when id not found", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(resolveShrinkTarget(msgs, { by_tool_call_id: "nope" })).toBeNull();
  });

  it("by_tool_name + last → last matching toolResult", () => {
    const msgs: MessageLike[] = [
      asst("r1"), result("r1", "read"),
      asst("r2"), result("r2", "read"),
      asst("r3"), result("r3", "bash"),
    ];
    expect(resolveShrinkTarget(msgs, { by_tool_name: "read", occurrence: "last" })).toBe(3); // second read result
  });

  it("by_tool_name + first → first matching toolResult", () => {
    const msgs: MessageLike[] = [
      asst("r1"), result("r1", "read"),
      asst("r2"), result("r2", "read"),
    ];
    expect(resolveShrinkTarget(msgs, { by_tool_name: "read", occurrence: "first" })).toBe(1);
  });

  it("by_tool_name occurrence missing → defaults to last", () => {
    const msgs: MessageLike[] = [
      asst("r1"), result("r1", "read"),
      asst("r2"), result("r2", "read"),
    ];
    expect(resolveShrinkTarget(msgs, { by_tool_name: "read" } as ShrinkTarget)).toBe(3);
  });

  it("by_content_includes → first message ANY role whose content includes substring (E19)", () => {
    const msgs: MessageLike[] = [
      user("find me"),
      asstText("thinking"),
      result("c1"),
    ];
    expect(resolveShrinkTarget(msgs, { by_content_includes: "find me" })).toBe(0); // user message
    expect(resolveShrinkTarget(msgs, { by_content_includes: "thinking" })).toBe(1); // assistant
  });

  it("by_content_includes works with array content (JSON stringify)", () => {
    const msgs: MessageLike[] = [
      { role: "assistant", content: [{ type: "text", text: "error: ENOSPC" }] } as MessageLike,
    ];
    expect(resolveShrinkTarget(msgs, { by_content_includes: "ENOSPC" })).toBe(0);
  });

  it("no match → null", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(resolveShrinkTarget(msgs, { by_tool_call_id: "x" })).toBeNull();
    expect(resolveShrinkTarget(msgs, { by_tool_name: "read" } as unknown as ShrinkTarget)).toBeNull();
    expect(resolveShrinkTarget(msgs, { by_content_includes: "nope" })).toBeNull();
  });

  it("non-array messages → null; non-record target → null", () => {
    expect(resolveShrinkTarget(null as unknown as MessageLike[], { by_tool_call_id: "x" })).toBeNull();
    expect(resolveShrinkTarget([], null as unknown as ShrinkTarget)).toBeNull();
  });

  it("empty/missing discriminator → null", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(resolveShrinkTarget(msgs, {} as unknown as ShrinkTarget)).toBeNull();
    expect(resolveShrinkTarget(msgs, { by_tool_call_id: "" })).toBeNull();
    expect(resolveShrinkTarget(msgs, { by_tool_name: "" } as unknown as ShrinkTarget)).toBeNull();
  });

  it("never throws (E13)", () => {
    const trap = new Proxy({}, { get() { throw new Error("trap"); } }) as unknown as MessageLike;
    expect(() => resolveShrinkTarget([trap], { by_tool_call_id: "x" })).not.toThrow();
    expect(() => resolveShrinkTarget([trap], { by_content_includes: "x" })).not.toThrow();
  });

  it("returns number | null", () => {
    expectTypeOf(resolveShrinkTarget([], { by_tool_call_id: "x" })).toEqualTypeOf<number | null>();
  });
});

// ── applyShrink (spec/06 §5; spec/08 E8/E17/E19) ──────────────────────────────────────────────────

describe("applyShrink — content substitution, field preservation, no-op, last-wins", () => {
  it("by_tool_call_id match → content replaced, role/toolCallId/toolName/isError PRESERVED", () => {
    const msgs: MessageLike[] = [asst("c1"), result("c1")];
    const out = applyShrink(msgs, { target: { by_tool_call_id: "c1" }, replacement: "[shrunk]" });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(msgs[0]); // assistant copied by reference
    expect(out[1]).not.toBe(msgs[1]); // result replaced
    expect(out[1].role).toBe("toolResult");
    expect(out[1].toolCallId).toBe("c1");
    expect(out[1].toolName).toBe("tool");
    expect(out[1].isError).toBe(false);
    expect(out[1].content).toEqual([{ type: "text", text: "[shrunk]" }]);
  });

  it("no match → SAME ref (toBe)", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(applyShrink(msgs, { target: { by_tool_call_id: "x" }, replacement: "r" })).toBe(msgs);
  });

  it("two shrinks same target → seq order LAST wins (E17)", () => {
    const msgs: MessageLike[] = [asst("c1"), result("c1")];
    const out1 = applyShrink(msgs, { target: { by_tool_call_id: "c1" }, replacement: "first" });
    const out2 = applyShrink(out1, { target: { by_tool_call_id: "c1" }, replacement: "second" });
    const text = (out2[1].content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("second"); // LAST wins
  });

  it("shrink on non-toolResult (by_content_includes hitting a user msg) → role preserved (E19)", () => {
    const msgs: MessageLike[] = [user("hello world")];
    const out = applyShrink(msgs, { target: { by_content_includes: "hello" }, replacement: "[shrunk]" });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user"); // role preserved
    expect(out[0].content).toEqual([{ type: "text", text: "[shrunk]" }]);
  });

  it("non-array messages → []", () => {
    expect(applyShrink(null as unknown as MessageLike[], { target: { by_tool_call_id: "x" }, replacement: "r" })).toEqual([]);
  });

  it("non-record marker → SAME ref (no throw)", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(applyShrink(msgs, null as unknown as { target: ShrinkTarget; replacement: string })).toBe(msgs);
  });

  it("throwing-Proxy matched msg → never throws (try/catch fallback)", () => {
    const trap: MessageLike = new Proxy(
      { role: "toolResult", toolCallId: "c1", toolName: "t", content: "x", isError: false } as MessageLike,
      new Proxy({}, { get() { throw new Error("trap"); } }),
    );
    // resolveShrinkTarget reads toolCallId — the Proxy throws on .toolCallId read → readOwn catches → no match → same ref
    expect(() => applyShrink([trap], { target: { by_tool_call_id: "c1" }, replacement: "r" })).not.toThrow();
  });

  it("does not mutate input", () => {
    const msgs: MessageLike[] = [asst("c1"), result("c1")];
    const snapshot = JSON.stringify(msgs);
    applyShrink(msgs, { target: { by_tool_call_id: "c1" }, replacement: "r" });
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("returns MessageLike[]", () => {
    expectTypeOf(applyShrink([], { target: { by_tool_call_id: "x" }, replacement: "r" })).toEqualTypeOf<MessageLike[]>();
  });
});
