import { describe, it, expect, expectTypeOf } from "vitest";
import {
  filterPipeline,
  protectedOk,
  stableSortBySeq,
  type RewindMarkerLike,
  type ShrinkMarkerLike,
  type MarkerBundle,
  type ProtectedConfig,
  type MessageLike,
  type BranchEntry,
  type ShrinkTarget,
} from "../src/transforms.js";

// No beforeEach: transforms.ts has NO module-scoped mutable state.

// ── local fixture builders (per-file convention — mirror transforms.test.ts) ───────────────────────

function asst(...callIds: string[]): MessageLike {
  return {
    role: "assistant",
    content: callIds.map((id) => ({ type: "toolCall", id, name: "tool", arguments: {} })),
  };
}

function asstText(text: string): MessageLike {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function result(toolCallId: string, toolName?: string): MessageLike {
  return {
    role: "toolResult",
    toolCallId,
    toolName: toolName ?? "tool",
    content: [{ type: "text", text: "..." }],
    isError: false,
  };
}

function user(text: string): MessageLike {
  return { role: "user", content: text };
}

function custom(customType: string): MessageLike {
  return { role: "custom", customType, content: "x", display: true };
}

function entry(id: string, type: BranchEntry["type"], extra: Record<string, unknown> = {}): BranchEntry {
  return { type, id, parentId: null, timestamp: "t", ...extra };
}

function labelEntry(id: string, targetId: string, name: string): BranchEntry {
  return { type: "label", id, parentId: null, timestamp: "t", targetId, label: `mulligan:checkpoint:${name}` };
}

/** Default config with first:user + latest:user protection. */
const cfg: ProtectedConfig = { rewind: { protectedRoles: ["first:user", "latest:user"] } };

/** Build a minimal RewindMarkerLike. */
function mkRewind(seq: number, granularity: RewindMarkerLike["granularity"], extra?: Partial<RewindMarkerLike>): RewindMarkerLike {
  return { seq, granularity, ...extra };
}

/** Build a minimal ShrinkMarkerLike. */
function mkShrink(seq: number, target: ShrinkTarget, replacement: string, extra?: Partial<ShrinkMarkerLike>): ShrinkMarkerLike {
  return { seq, target, replacement, ...extra };
}

/** Extract first text block's text from a message (convenience). */
function textOf(m: MessageLike): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const block = m.content.find((b: any) => b?.type === "text");
    return (block as any)?.text ?? "";
  }
  return "";
}

/** Pairing invariant: every toolCall has a matching toolResult and vice versa. */
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

// ── seeded PRNG (mulberry32 — no external dep; reproducible) ─────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a WELL-FORMED message list (2..9 entries) with ADJACENT fully-paired groups. */
function genMessages(rng: () => number): MessageLike[] {
  const count = 2 + Math.floor(rng() * 8); // 2..9
  const msgs: MessageLike[] = [];
  let i = 0;
  // Always start with a user message.
  msgs.push(user(`u${i++}`));
  while (msgs.length < count) {
    const r = rng();
    const remaining = count - msgs.length;
    if (r < 0.35 && remaining >= 2) {
      // A fully-paired assistant + 1 result (ADJACENT, minimal).
      const id = `c${i++}`;
      msgs.push(asst(id));
      msgs.push(result(id));
    } else if (r < 0.5 && remaining >= 4) {
      // A fully-paired assistant + 2 results (parallel tool, ADJACENT).
      const id1 = `c${i++}`;
      const id2 = `c${i++}`;
      msgs.push(asst(id1, id2));
      msgs.push(result(id1));
      msgs.push(result(id2));
    } else if (r < 0.65) {
      // A text-only assistant.
      msgs.push(asstText(`thinking${i++}`));
    } else if (r < 0.78) {
      // Another user message.
      msgs.push(user(`u${i++}`));
    } else if (r < 0.88) {
      // A custom mulligan note.
      msgs.push(custom("mulligan:note"));
    } else if (remaining >= 2) {
      // Fallback: single fully-paired call+result.
      const id = `c${i++}`;
      msgs.push(asst(id));
      msgs.push(result(id));
    } else {
      // Not enough room for a pair; add a text-only assistant.
      msgs.push(asstText(`t${i++}`));
    }
  }
  return msgs;
}

// ── stableSortBySeq ──────────────────────────────────────────────────────────────────────────────

describe("stableSortBySeq", () => {
  it("sorts ascending by seq", () => {
    const markers = [{ seq: 3 }, { seq: 1 }, { seq: 2 }] as const;
    const sorted = stableSortBySeq([...markers]);
    expect(sorted.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("is stable for equal seq", () => {
    const a = { seq: 1, label: "a" };
    const b = { seq: 1, label: "b" };
    const sorted = stableSortBySeq([b, a]);
    expect(sorted).toEqual([b, a]); // input order preserved for ties
  });

  it("non-mutating (new array, input unchanged)", () => {
    const markers = [{ seq: 2 }, { seq: 1 }];
    const sorted = stableSortBySeq(markers);
    expect(sorted).not.toBe(markers);
    expect(markers[0].seq).toBe(2); // unchanged
  });

  it("non-array → []", () => {
    expect(stableSortBySeq(null as unknown as any[])).toEqual([]);
  });

  it("non-finite/missing seq → treated as 0", () => {
    const markers = [{ seq: NaN }, { seq: Infinity }, { seq: 1 }, {}] as any[];
    const sorted = stableSortBySeq(markers);
    // NaN/Infinity/undefined all → 0; they stay in input order (stable), then seq:1 at end
    expect(sorted[3].seq).toBe(1);
  });
});

// ── protectedOk (spec/06 §8) ──────────────────────────────────────────────────────────────────────

describe("protectedOk — spec/06 §8", () => {
  it("min(remove) > iFirstUser → true", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c"), user("u1")];
    expect(protectedOk(msgs, [4], cfg)).toBe(true);
  });

  it("remove including iFirstUser → false", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [0], cfg)).toBe(false);
  });

  it("remove at iFirstUser → false", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [0, 1, 2], cfg)).toBe(false);
  });

  it("empty remove → true (vacuous)", () => {
    expect(protectedOk([user("u")], [], cfg)).toBe(true);
  });

  it("no user → true", () => {
    const msgs: MessageLike[] = [asstText("t")];
    expect(protectedOk(msgs, [0], cfg)).toBe(true);
  });

  it("non-array messages → true", () => {
    expect(protectedOk(null as unknown as MessageLike[], [0], cfg)).toBe(true);
  });

  it("protectedRoles omitting first:user → true (disabled)", () => {
    const cfgDisabled: ProtectedConfig = { rewind: { protectedRoles: ["latest:user"] } };
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [0], cfgDisabled)).toBe(true);
  });

  it("config undefined → enforce first:user (fail safe)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [0], undefined)).toBe(false);
  });

  it("malformed config → enforce first:user (fail safe)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [0], null as unknown as ProtectedConfig)).toBe(false);
    expect(protectedOk(msgs, [0], "bad" as unknown as ProtectedConfig)).toBe(false);
  });

  it("non-number remove entries ignored", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
    expect(protectedOk(msgs, [NaN, "x" as unknown as number], cfg)).toBe(true); // all non-numeric → vacuous
  });

  it("returns boolean", () => {
    expectTypeOf(protectedOk([], [], undefined)).toEqualTypeOf<boolean>();
  });
});

// ── filterPipeline composition (spec/10 §1.9) ──────────────────────────────────────────────────────

describe("filterPipeline — spec/10 §1.9 composition", () => {
  it("two rewinds with DISTINCT excludeToolCallIds → both remove (spec/06 §11)", () => {
    // §11 fixture: u0, aM(cM), rM, aR1(cR1), resR1, aR2(cR2), resR2, note
    // rewind#1 (excludeToolCallId=cR1): last_tool_call_group → removes aR2+resR2 (last group not excluded)
    // rewind#2 (excludeToolCallId=cR2): last_tool_call_group → removes aM+rM (after first rewind removed R2 group)
    const msgs: MessageLike[] = [
      user("u0"),
      asst("cM"), result("cM"),
      asst("cR1"), result("cR1"),
      asst("cR2"), result("cR2"),
      custom("mulligan:note"),
    ];
    const markers: MarkerBundle = {
      rewinds: [
        mkRewind(1, "last_tool_call_group", { excludeToolCallId: "cR1" }),
        mkRewind(2, "last_tool_call_group", { excludeToolCallId: "cR2" }),
      ],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // After rw#1: removes [5,6] (aR2+resR2) → [u0, aM, rM, aR1, resR1, note]
    // After rw#2: last_tool_call_group with exclude cR2 (not present) → removes [1,2] (aM+rM)
    // Final: [u0, aR1, resR1, note]
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "custom"]);
    expectNoOrphans(out);
  });

  it("two rewinds SAME excludeToolCallId → 1st removes, 2nd no-ops", () => {
    const msgs: MessageLike[] = [
      user("u0"),
      asst("A"), result("A"),
      asst("B"), result("B"),
      asst("C"), result("C"),
    ];
    const markers: MarkerBundle = {
      rewinds: [
        mkRewind(1, "last_tool_call_group", { excludeToolCallId: "C" }),
        mkRewind(2, "last_tool_call_group", { excludeToolCallId: "C" }),
      ],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // rw#1: exclude C → removes B+resB [3,4]
    // rw#2: on reduced [u0, aA, rA, aC, rC], exclude C → removes aA+rA [1,2]
    // Final: [u0, aC, rC]
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
    expectNoOrphans(out);
  });

  it("rewind-then-shrink-on-removed target → shrink no-ops (E8)", () => {
    const msgs: MessageLike[] = [
      user("u0"),
      asst("c1"), result("c1"),
      asst("c2"), result("c2"),
    ];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_tool_call_group", { excludeToolCallId: "c1" })],
      shrinks: [mkShrink(2, { by_tool_call_id: "c2" }, "[shrunk]")],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // rewind removes c2 group [3,4]; shrink targets c2 → not found → no-op
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]); // only c1 group + user
    expect(out).toHaveLength(3);
    expectNoOrphans(out);
  });

  it("protected (last_turn on single-user session) → resolveLastTurn refuses → nothing removed", () => {
    const msgs: MessageLike[] = [user("only"), asst("c"), result("c")];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_turn", { options: { to_previous_prompt: true } })],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // resolveLastTurn refuses nuclear on single-user → remove=[] → protectedOk vacuous → nothing removed
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("user"); // first user kept
  });

  it("shrinks compose oldest-first", () => {
    const msgs: MessageLike[] = [user("u"), asst("c1"), result("c1"), asst("c2"), result("c2")];
    const markers: MarkerBundle = {
      rewinds: [],
      shrinks: [
        mkShrink(1, { by_tool_call_id: "c1" }, "first"),
        mkShrink(2, { by_tool_call_id: "c2" }, "second"),
      ],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // by_tool_call_id targets the toolResult, not the assistant
    expect(textOf(out[2])).toBe("first");  // result(c1) shrunk
    expect(textOf(out[4])).toBe("second"); // result(c2) shrunk
  });

  it("last_turn through pipeline keeps the rewind's own unit + the note", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("c0"), result("c0"),
      user("u1"), asst("prev"), result("prev"), asst("REW"), result("REW"),
      custom("mulligan:note"),
    ];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_turn", { excludeToolCallId: "REW" })],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg);
    const roles = out.map((m) => m.role);
    // resolveLastTurn: keep u1, remove after u1 except own unit [6,7] and note [8]
    expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult", "custom"]);
    expectNoOrphans(out);
  });

  it("checkpoint through pipeline removes after checkpoint point", () => {
    const msgs: MessageLike[] = [user("u1"), asst("c1"), result("c1"), asstText("junk")];
    const branch: BranchEntry[] = [
      entry("e1", "message"), entry("e2", "message"), labelEntry("eL", "e2", "ckpt"),
      entry("e3", "message"), entry("e4", "message"),
    ];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "checkpoint", { checkpoint: "ckpt" })],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg, branch);
    // UNIT-SNAP: iTarget snapped 1→2; remove [3]
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
    expect(out[2].role).toBe("toolResult");
  });

  it("by_tool_name shrink (unpinned/live) matches last", () => {
    const msgs: MessageLike[] = [
      asst("r1"), result("r1", "read"),
      asst("r2"), result("r2", "read"),
    ];
    const markers: MarkerBundle = {
      rewinds: [],
      shrinks: [mkShrink(1, { by_tool_name: "read", occurrence: "last" }, "[shrunk]")],
    };
    const out = filterPipeline(msgs, markers, cfg);
    // last read result is at index 3
    expect(textOf(out[3])).toBe("[shrunk]");
    expect(out[3].toolCallId).toBe("r2"); // preserved
  });

  it("no markers / non-record markers / empty markers → SAME ref (toBe)", () => {
    const msgs: MessageLike[] = [user("u")];
    expect(filterPipeline(msgs, undefined, cfg)).toBe(msgs);
    expect(filterPipeline(msgs, null as unknown as MarkerBundle, cfg)).toBe(msgs);
    expect(filterPipeline(msgs, { rewinds: [], shrinks: [] }, cfg)).toBe(msgs);
  });

  it("non-array messages → []", () => {
    expect(filterPipeline(null as unknown as MessageLike[], undefined, cfg)).toEqual([]);
  });

  it("unknown granularity + malformed markers → skipped (never throws)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const markers: MarkerBundle = {
      rewinds: [{ seq: 1, granularity: "unknown" as any } as any],
      shrinks: [],
    };
    expect(() => filterPipeline(msgs, markers, cfg)).not.toThrow();
    expect(filterPipeline(msgs, markers, cfg)).toHaveLength(3); // no-op
  });

  it("purity (input msgs + markers untouched)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c")];
    const markers: MarkerBundle = {
      rewinds: [mkRewind(1, "last_tool_call_group")],
      shrinks: [mkShrink(1, { by_tool_call_id: "c" }, "r")],
    };
    const snapMsgs = JSON.stringify(msgs);
    const snapMarkers = JSON.stringify(markers);
    filterPipeline(msgs, markers, cfg);
    expect(JSON.stringify(msgs)).toBe(snapMsgs);
    expect(JSON.stringify(markers)).toBe(snapMarkers);
  });

  it("types", () => {
    expectTypeOf(filterPipeline([], undefined, undefined)).toEqualTypeOf<MessageLike[]>();
    expectTypeOf(protectedOk([], [], undefined)).toEqualTypeOf<boolean>();
  });

  it("RewindMarkerLike.hideEntryIds type is string[] | undefined", () => {
    expectTypeOf<RewindMarkerLike>().toHaveProperty("hideEntryIds").toEqualTypeOf<string[] | undefined>();
  });

  it("hideEntryIds is carried but not consumed (S1 behavioral no-op)", () => {
    const msgs: MessageLike[] = [user("u"), asst("c"), result("c"), asstText("after")];
    const branchEntries: BranchEntry[] = [];
    // Marker WITH the pinned field
    const rwPinned = mkRewind(1, 'last_tool_call_group', { hideEntryIds: ['e1', 'e2'], excludeToolCallId: 'c' });
    // Marker WITHOUT the pinned field
    const rwPlain = mkRewind(1, 'last_tool_call_group', { excludeToolCallId: 'c' });
    const outPinned = filterPipeline(msgs, { rewinds: [rwPinned], shrinks: [] }, cfg, branchEntries);
    const outPlain = filterPipeline(msgs, { rewinds: [rwPlain], shrinks: [] }, cfg, branchEntries);
    expect(outPinned).toEqual(outPlain);
  });
});

// ── filterPipeline property/invariant tests (spec/10 §3) ──────────────────────────────────────────

describe("filterPipeline — property/invariant (spec/10 §3)", () => {
  /** Generate a random marker bundle for property testing. */
  function genMarkers(rng: () => number, msgs: MessageLike[]): MarkerBundle {
    const rewinds: RewindMarkerLike[] = [];
    const shrinks: ShrinkMarkerLike[] = [];
    const numRewinds = Math.floor(rng() * 3); // 0..2
    for (let i = 0; i < numRewinds; i++) {
      const gran = rng() < 0.5 ? "last_tool_call_group" as const : "last_turn" as const;
      // sometimes a real excludeToolCallId, sometimes undefined
      const toolResults = msgs.filter((m) => m.role === "toolResult");
      const exclude = rng() < 0.5 && toolResults.length > 0
        ? (toolResults[Math.floor(rng() * toolResults.length)].toolCallId as string)
        : undefined;
      rewinds.push(mkRewind(rewinds.length + 1, gran, { excludeToolCallId: exclude }));
    }
    // Maybe add a shrink
    if (rng() < 0.3) {
      const toolResults = msgs.filter((m) => m.role === "toolResult");
      if (toolResults.length > 0) {
        const target = toolResults[Math.floor(rng() * toolResults.length)];
        shrinks.push(mkShrink(
          100 + shrinks.length,
          { by_tool_call_id: target.toolCallId as string },
          "[shrunk]",
        ));
      }
    }
    return { rewinds, shrinks };
  }

  it("pairing invariant (300 iters) — NEVER orphans", () => {
    const rng = mulberry32(42);
    for (let iter = 0; iter < 300; iter++) {
      const msgs = genMessages(rng);
      const markers = genMarkers(rng, msgs);
      const out = filterPipeline(msgs, markers, cfg);
      expectNoOrphans(out);
    }
  });

  it("monotonic shrinkage (300 iters) — out.length <= msgs.length", () => {
    const rng = mulberry32(123);
    for (let iter = 0; iter < 300; iter++) {
      const msgs = genMessages(rng);
      const markers = genMarkers(rng, msgs);
      const out = filterPipeline(msgs, markers, cfg);
      expect(out.length).toBeLessThanOrEqual(msgs.length);
    }
  });

  it("idempotency — SHRINKS only (200 iters)", () => {
    const rng = mulberry32(456);
    for (let iter = 0; iter < 200; iter++) {
      const msgs = genMessages(rng);
      // SHRINK-ONLY markers (rewinds empty per GOTCHA #8)
      const toolResults = msgs.filter((m) => m.role === "toolResult");
      const shrinks: ShrinkMarkerLike[] = [];
      if (toolResults.length > 0) {
        const t = toolResults[Math.floor(rng() * toolResults.length)];
        shrinks.push(mkShrink(1, { by_tool_call_id: t.toolCallId as string }, "[shrunk]"));
      }
      const markers: MarkerBundle = { rewinds: [], shrinks };
      const first = filterPipeline(msgs, markers, cfg);
      const second = filterPipeline(first, markers, cfg);
      expect(second).toEqual(first); // shrinks are idempotent
    }
  });

  it("determinism (200 iters) — same input twice → equal", () => {
    const rng = mulberry32(789);
    for (let iter = 0; iter < 200; iter++) {
      const msgs = genMessages(rng);
      const markers = genMarkers(rng, msgs);
      const a = filterPipeline(msgs, markers, cfg);
      const b = filterPipeline(msgs, markers, cfg);
      expect(a).toEqual(b);
    }
  });
});

// ── filterPipeline — hideEntryIds pin resolution (BUG-002; P1.M2.T1.S4) ──────────────────────────────

describe("filterPipeline — hideEntryIds pin resolution (BUG-002; P1.M2.T1.S4)", () => {
  /** Content-bearing toolResult for absence/presence assertions. */
  function resultText(toolCallId: string, text: string): MessageLike {
    return { role: "toolResult", toolCallId, toolName: "tool", content: [{ type: "text", text }], isError: false };
  }

  it("single pin removes its target (pin output differs from live output — pin is consumed)", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("cRead"), resultText("cRead", "READ"), asstText("mid"), asst("cOther"), resultText("cOther", "OTHER"),
    ];
    const branch: BranchEntry[] = [
      entry("e-u", "message"), entry("e-r-a", "message"), entry("e-r-r", "message"),
      entry("e-mid", "message"), entry("e-o-a", "message"), entry("e-o-r", "message"),
    ];
    const rwPin = mkRewind(1, "last_tool_call_group", { hideEntryIds: ["e-r-a", "e-r-r"] });
    const rwLive = mkRewind(1, "last_tool_call_group", {});
    const outPin = filterPipeline(msgs, { rewinds: [rwPin], shrinks: [] }, cfg, branch);
    const outLive = filterPipeline(msgs, { rewinds: [rwLive], shrinks: [] }, cfg, branch);
    expect(JSON.stringify(outPin)).not.toContain("READ");
    expect(JSON.stringify(outPin)).toContain("OTHER");
    expect(JSON.stringify(outLive)).toContain("READ");
    expect(JSON.stringify(outLive)).not.toContain("OTHER");
    expect(JSON.stringify(outPin)).not.toEqual(JSON.stringify(outLive));
    expectNoOrphans(outPin);
  });

  it("COMPOSITION — two stacked pins each hide their own target (BUG-002 unit essence; FAILS on literal contract)", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("cA"), resultText("cA", "AAA"), asst("cB"), resultText("cB", "BBB"),
    ];
    const branch: BranchEntry[] = [
      entry("e-u", "message"), entry("e-a-a", "message"), entry("e-a-r", "message"),
      entry("e-b-a", "message"), entry("e-b-r", "message"),
    ];
    const markers: MarkerBundle = {
      rewinds: [
        mkRewind(1, "last_tool_call_group", { hideEntryIds: ["e-a-a", "e-a-r"] }),
        mkRewind(2, "last_tool_call_group", { hideEntryIds: ["e-b-a", "e-b-r"] }),
      ],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg, branch);
    expect(JSON.stringify(out)).not.toContain("AAA");
    expect(JSON.stringify(out)).not.toContain("BBB");
    expect(out.map((m) => m.role)).toEqual(["user"]);
    expectNoOrphans(out);
  });

  it("pinned entry absent from branch -> no-op (out === msgs, same ref)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("cS"), resultText("cS", "SURVIVE")];
    const branch: BranchEntry[] = [entry("e-u", "message"), entry("e-s-a", "message"), entry("e-s-r", "message")];
    const rw = mkRewind(1, "last_tool_call_group", { hideEntryIds: ["e-gone-a", "e-gone-r"] });
    const out = filterPipeline(msgs, { rewinds: [rw], shrinks: [] }, cfg, branch);
    expect(out).toBe(msgs);
    expect(JSON.stringify(out)).toContain("SURVIVE");
  });

  it("protectedOk gates the pin (pin targeting first:user -> refused; out unchanged)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c"), resultText("c", "TOOL")];
    const branch: BranchEntry[] = [entry("e-u", "message"), entry("e-a", "message"), entry("e-r", "message")];
    const firstOnly: ProtectedConfig = { rewind: { protectedRoles: ["first:user"] } };
    const rw = mkRewind(1, "last_tool_call_group", { hideEntryIds: ["e-u"] });
    const out = filterPipeline(msgs, { rewinds: [rw], shrinks: [] }, firstOnly, branch);
    expect(out).toBe(msgs);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("pin + live interleave (origIdxOfM bookkeeping across mixed removal types)", () => {
    const msgs: MessageLike[] = [
      user("u0"), asst("cA"), resultText("cA", "AAA"), asst("cB"), resultText("cB", "BBB"),
    ];
    const branch: BranchEntry[] = [
      entry("e-u", "message"), entry("e-a-a", "message"), entry("e-a-r", "message"),
      entry("e-b-a", "message"), entry("e-b-r", "message"),
    ];
    const markers: MarkerBundle = {
      rewinds: [
        mkRewind(1, "last_tool_call_group", { hideEntryIds: ["e-a-a", "e-a-r"] }),
        mkRewind(2, "last_tool_call_group", {}),
      ],
      shrinks: [],
    };
    const out = filterPipeline(msgs, markers, cfg, branch);
    expect(JSON.stringify(out)).not.toContain("AAA");
    expect(JSON.stringify(out)).not.toContain("BBB");
    expect(out.map((m) => m.role)).toEqual(["user"]);
    expectNoOrphans(out);
  });

  it("backward compat — marker without hideEntryIds uses live resolution (existing behavior)", () => {
    const msgs: MessageLike[] = [user("u0"), asst("c1"), resultText("c1", "ONE"), asst("c2"), resultText("c2", "TWO")];
    const rw = mkRewind(1, "last_tool_call_group");
    const out = filterPipeline(msgs, { rewinds: [rw], shrinks: [] }, cfg);
    expect(JSON.stringify(out)).toContain("ONE");
    expect(JSON.stringify(out)).not.toContain("TWO");
    expectNoOrphans(out);
  });
});
