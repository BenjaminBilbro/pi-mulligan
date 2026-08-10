import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from "vitest";
import {
  runtime,
  nextSeq,
  resetRuntime,
  clearAll,
  type SessionRuntime,
  type AgentMessage,
} from "../src/runtime.js";

beforeEach(() => {
  clearAll();
});

afterEach(() => {
  clearAll();
});

const EXPECTED_KEYS = [
  "sessionId",
  "seq",
  "tokenBaseline",
  "lastTurnIndex",
  "lastFiltered",
  "lastFilterTs",
] as const;

describe("SessionRuntime shape (spec/04 §8 + spec/06 §7)", () => {
  it("fresh runtime has EXACTLY the 6 fields with correct defaults", () => {
    const rt = runtime("shape-test");
    expect(Object.keys(rt).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(rt).toEqual({
      sessionId: "shape-test",
      seq: 0,
      tokenBaseline: null,
      lastTurnIndex: null,
      lastFiltered: null,
      lastFilterTs: null,
    });
  });

  it("SessionRuntime field types are correct (compile-time)", () => {
    expectTypeOf<SessionRuntime>().toHaveProperty("sessionId").toEqualTypeOf<string>();
    expectTypeOf<SessionRuntime>().toHaveProperty("seq").toEqualTypeOf<number>();
    expectTypeOf<SessionRuntime>().toHaveProperty("tokenBaseline").toEqualTypeOf<number | null>();
    expectTypeOf<SessionRuntime>().toHaveProperty("lastTurnIndex").toEqualTypeOf<number | null>();
    expectTypeOf<SessionRuntime>().toHaveProperty("lastFiltered").toEqualTypeOf<AgentMessage[] | null>();
    expectTypeOf<SessionRuntime>().toHaveProperty("lastFilterTs").toEqualTypeOf<number | null>();
  });

  it("AgentMessage is Record<string, unknown> (compile-time)", () => {
    expectTypeOf<AgentMessage>().toEqualTypeOf<Record<string, unknown>>();
  });

  it("has NO pendingBloatHits key (out of scope — P1.M3.T3)", () => {
    const rt = runtime("no-bloat");
    expect(rt).not.toHaveProperty("pendingBloatHits");
    expect(Object.keys(rt)).toHaveLength(6);
  });
});

describe("get-or-create idempotency", () => {
  it("runtime('s1') === runtime('s1') — same live mutable object (reference equality)", () => {
    const a = runtime("s1");
    const b = runtime("s1");
    expect(a).toBe(b);
  });
});

describe("nextSeq is strictly increasing", () => {
  it("returns 1, 2, 3 in order and persists on rt.seq", () => {
    const rt = runtime("seq-test");
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(nextSeq(rt));
    }
    expect(results).toEqual([1, 2, 3]);
    expect(rt.seq).toBe(3);
  });

  it("fresh runtime starts at seq 0 before any nextSeq call", () => {
    const rt = runtime("seq-zero");
    expect(rt.seq).toBe(0);
  });
});

describe("distinct sessions are independent", () => {
  it("interleaved nextSeq on A and B counts independently with no cross-talk", () => {
    const a = runtime("A");
    const b = runtime("B");
    const aSeqs: number[] = [];
    const bSeqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      aSeqs.push(nextSeq(a));
      bSeqs.push(nextSeq(b));
    }
    expect(aSeqs).toEqual([1, 2, 3]);
    expect(bSeqs).toEqual([1, 2, 3]);
    expect(a).not.toBe(b);
    expect(a.seq).toBe(3);
    expect(b.seq).toBe(3);
  });
});

describe("ctx-vs-string input parity", () => {
  it("runtime({getSessionId: () => 's1'}) === runtime('s1')", () => {
    const ctx = { getSessionId: () => "s1" };
    const fromCtx = runtime(ctx);
    const fromStr = runtime("s1");
    expect(fromCtx).toBe(fromStr);
  });
});

describe("in-place mutation contract", () => {
  it("assigning rt.lastFiltered is observable via a subsequent runtime() call (no defensive copy)", () => {
    const rt = runtime("mut-test");
    const msgs: AgentMessage[] = [{ role: "user", content: "hello" }];
    rt.lastFiltered = msgs;
    // The runtime() call returns the same live object — no clone
    expect(runtime("mut-test").lastFiltered).toBe(msgs);
  });

  it("mutating rt.seq directly (not via nextSeq) is also observable", () => {
    const rt = runtime("direct-mut");
    rt.seq = 42;
    expect(runtime("direct-mut").seq).toBe(42);
  });
});

describe("resetRuntime", () => {
  it("makes the next runtime() call return a fresh object with seq 0", () => {
    const old = runtime("reset-test");
    nextSeq(old);
    nextSeq(old);
    expect(old.seq).toBe(2);

    resetRuntime("reset-test");

    const fresh = runtime("reset-test");
    expect(fresh.seq).toBe(0);
    expect(fresh).not.toBe(old);
  });

  it("is a no-op on an unknown sessionId and never throws", () => {
    expect(() => resetRuntime("never-existed")).not.toThrow();
  });
});

describe("clearAll", () => {
  it("wipes all sessions; subsequent runtime() returns fresh objects", () => {
    const a = runtime("a");
    const b = runtime("b");
    nextSeq(a);
    nextSeq(b);

    clearAll();

    const aFresh = runtime("a");
    const bFresh = runtime("b");
    expect(aFresh.seq).toBe(0);
    expect(bFresh.seq).toBe(0);
    expect(aFresh).not.toBe(a);
    expect(bFresh).not.toBe(b);
  });

  it("is a no-op on an empty map and never throws", () => {
    clearAll(); // already empty from beforeEach
    expect(() => clearAll()).not.toThrow();
  });
});

describe("resetRuntime and clearAll never throw on any input (fail-open)", () => {
  it("resetRuntime accepts empty string", () => {
    expect(() => resetRuntime("")).not.toThrow();
  });

  it("clearAll twice in a row does not throw", () => {
    clearAll();
    expect(() => clearAll()).not.toThrow();
  });
});
