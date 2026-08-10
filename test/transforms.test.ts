import { describe, it, expect, expectTypeOf } from "vitest";
import { partitionIntoUnits, type Unit, type MessageLike } from "../src/transforms.js";

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

/** Build a toolResult message for the given toolCallId. */
function result(toolCallId: string): MessageLike {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "tool",
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
