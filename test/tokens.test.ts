import { describe, it, expect, expectTypeOf } from "vitest";
import {
  estimateTokens,
  CHARS_PER_TOKEN,
  resultBytes,
  approxTokens,
  type TokenEstimate,
  type TokenConfidence,
  type MessageLike,
  type ResultContentBlock,
} from "../src/tokens.js";

// No beforeEach needed: tokens.ts has NO module-scoped mutable state.

// ── estimateTokens — spec/10 §1.7 contract ───────────────────────────────────

describe("estimateTokens — spec/10 §1.7 contract (empty / monotonic / confidence / snapshot)", () => {
  it("empty message list → 0 tokens", () => {
    expect(estimateTokens([]).tokens).toBe(0);
  });

  it("null / undefined input → 0 tokens (defensive)", () => {
    expect(estimateTokens(null).tokens).toBe(0);
    expect(estimateTokens(undefined).tokens).toBe(0);
  });

  it("is monotonic in input length — a longer single message estimates strictly MORE (spec/10 §1.7)", () => {
    const short: MessageLike[] = [{ role: "user", content: "x".repeat(40) }];
    const long: MessageLike[] = [{ role: "user", content: "x".repeat(400) }];
    expect(estimateTokens(short).tokens).toBeLessThan(estimateTokens(long).tokens);
  });

  it("is monotonic — adding a message NEVER decreases the estimate", () => {
    const one: MessageLike[] = [{ role: "user", content: "hello world" }];
    const two: MessageLike[] = [
      ...one,
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    expect(estimateTokens(two).tokens).toBeGreaterThanOrEqual(estimateTokens(one).tokens);
  });

  it("reports a confidence flag (default 'medium')", () => {
    const r = estimateTokens([{ role: "user", content: "hi" }] as MessageLike[]);
    expect(r.confidence).toBe("medium");
    expect(["low", "medium", "high"]).toContain(r.confidence);
  });

  it("a known controlled-length string yields a stable estimate (inline snapshot — spec/10 §1.7)", () => {
    const known: MessageLike[] = [{ role: "user", content: "a".repeat(44) }];
    expect(estimateTokens(known).tokens).toMatchInlineSnapshot(`11`);
  });
});

describe("estimateTokens — chars-per-token heuristic (~4 chars ≈ 1 token)", () => {
  it("divides total stringified char length by CHARS_PER_TOKEN=4 with ceil", () => {
    const forty: MessageLike[] = [{ role: "user", content: "a".repeat(40) }];
    expect(estimateTokens(forty).tokens).toBe(10);
    const fortyOne: MessageLike[] = [{ role: "user", content: "a".repeat(41) }];
    expect(estimateTokens(fortyOne).tokens).toBe(11);
  });

  it("CHARS_PER_TOKEN is exported and equals 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

describe("estimateTokens — handles every message role", () => {
  it("user message with a plain string content", () => {
    const msgs: MessageLike[] = [{ role: "user", content: "abcd" }];
    expect(estimateTokens(msgs).tokens).toBe(1);
  });

  it("user message with content blocks (text + image)", () => {
    const msgs: MessageLike[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "abcd" },
          { type: "image", data: "abcdefgh", mimeType: "image/png" },
        ],
      },
    ];
    expect(estimateTokens(msgs).tokens).toBe(3); // ceil((4+8)/4) = 3
  });

  it("assistant message with text + thinking + toolCall", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "abcd" },
          { type: "thinking", thinking: "efgh" },
          { type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
        ],
      },
    ];
    expect(estimateTokens(msgs).tokens).toBe(6); // ceil((4+4+4+12)/4) = 6
  });

  it("toolResult message with text blocks", () => {
    const msgs: MessageLike[] = [
      {
        role: "toolResult", toolCallId: "1", toolName: "read", isError: false,
        content: [{ type: "text", text: "abcdefgh" }],
      },
    ];
    expect(estimateTokens(msgs).tokens).toBe(2);
  });

  it("custom message with plain string content", () => {
    const msgs: MessageLike[] = [
      { role: "custom", customType: "mulligan:note", content: "abcdefgh", display: true },
    ];
    expect(estimateTokens(msgs).tokens).toBe(2);
  });

  it("custom message with content blocks", () => {
    const msgs: MessageLike[] = [
      {
        role: "custom", customType: "mulligan:nudge", display: false,
        content: [{ type: "text", text: "abcd" }],
      },
    ];
    expect(estimateTokens(msgs).tokens).toBe(1);
  });

  it("a mix of roles sums correctly across the whole list (divide once at the top)", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "abcd" },
      { role: "assistant", content: [{ type: "text", text: "efgh" }] },
      { role: "toolResult", content: [{ type: "text", text: "ijkl" }] },
    ];
    expect(estimateTokens(msgs).tokens).toBe(3); // ceil(12/4) = 3
  });
});

describe("estimateTokens — defensive (NEVER throws)", () => {
  it("a message with no content contributes 0", () => {
    expect(estimateTokens([{ role: "user" }] as MessageLike[]).tokens).toBe(0);
  });

  it("a message with null content contributes 0", () => {
    expect(estimateTokens([{ role: "user", content: null }] as unknown as MessageLike[]).tokens).toBe(0);
  });

  it("an unknown content-block type contributes 0 (forward-compat)", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: [{ type: "mystery", payload: "ignored" }] as unknown as never[] },
    ];
    expect(estimateTokens(msgs).tokens).toBe(0);
  });

  it("does not throw on a malformed block array (non-record elements)", () => {
    const msgs: MessageLike[] = [{ role: "user", content: [null, 42, "raw", undefined] as unknown as never[] }];
    expect(() => estimateTokens(msgs)).not.toThrow();
    expect(estimateTokens(msgs).tokens).toBe(0);
  });

  it("does not throw on non-array, non-string content (defensive)", () => {
    const msgs: MessageLike[] = [{ role: "user", content: 12345 as unknown as string }];
    expect(() => estimateTokens(msgs)).not.toThrow();
    expect(estimateTokens(msgs).tokens).toBe(0);
  });

  it("toolCall with circular arguments is sized without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "x", arguments: circular }],
      },
    ];
    expect(() => estimateTokens(msgs)).not.toThrow();
    expect(estimateTokens(msgs).tokens).toBe(1); // name "x" = 1 char → ceil(1/4) = 1
  });

  it("does not throw on a throwing Proxy accessor (fail-open)", () => {
    const trap: MessageLike = new Proxy(
      { role: "user", content: "abcd" } as MessageLike,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => estimateTokens([trap])).not.toThrow();
    expect(estimateTokens([trap]).tokens).toBe(0);
  });
});

describe("estimateTokens — model parameter (v1-unused, forward-compat)", () => {
  it("accepts an optional model object without changing the v1 estimate", () => {
    const msgs: MessageLike[] = [{ role: "user", content: "abcd" }];
    const a = estimateTokens(msgs);
    const b = estimateTokens(msgs, { id: "claude-sonnet-4" });
    expect(b.tokens).toBe(a.tokens);
  });

  it("accepts undefined as the model argument", () => {
    const msgs: MessageLike[] = [{ role: "user", content: "abcd" }];
    expect(estimateTokens(msgs, undefined).tokens).toBe(1);
  });
});

// ── type-level checks ──────────────────────────────────────────────────────

describe("types", () => {
  it("returns { tokens: number; confidence: 'low'|'medium'|'high' }", () => {
    const r = estimateTokens([]);
    expectTypeOf(r.tokens).toEqualTypeOf<number>();
    expectTypeOf(r.confidence).toEqualTypeOf<"low" | "medium" | "high">();
  });

  it("CHARS_PER_TOKEN is a number", () => {
    expectTypeOf(CHARS_PER_TOKEN).toEqualTypeOf<number>();
  });

  it("TokenEstimate has the documented shape", () => {
    expectTypeOf<TokenEstimate>().toEqualTypeOf<{ tokens: number; confidence: "low" | "medium" | "high" }>();
  });

  it("TokenConfidence is the 3-value union", () => {
    expectTypeOf<TokenConfidence>().toEqualTypeOf<"low" | "medium" | "high">();
  });

  it("MessageLike accepts real-ish Pi message shapes (structural typing)", () => {
    const m1: MessageLike = { role: "user", content: "hi" };
    const m2: MessageLike = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    expectTypeOf(m1).toEqualTypeOf<MessageLike>();
    expectTypeOf(m2).toEqualTypeOf<MessageLike>();
  });
});

// ── resultBytes — spec/07 §1 ───────────────────────────────────────────────

describe("resultBytes — byte size of tool_result content (spec/07 §1: UTF-8 bytes)", () => {
  it("empty content → 0", () => {
    expect(resultBytes([])).toBe(0);
  });

  it("null / undefined content → 0 (defensive)", () => {
    expect(resultBytes(null)).toBe(0);
    expect(resultBytes(undefined)).toBe(0);
  });

  it("non-array content → 0 (defensive)", () => {
    expect(resultBytes("abcd" as unknown as ResultContentBlock[])).toBe(0);
    expect(resultBytes(12345 as unknown as ResultContentBlock[])).toBe(0);
  });

  it("a single ASCII text block yields its char count in bytes (ASCII: bytes == chars)", () => {
    expect(resultBytes([{ type: "text", text: "abc" }])).toBe(3);
    expect(resultBytes([{ type: "text", text: "a".repeat(8000) }])).toBe(8000);
  });

  it("a UTF-8 MULTIBYTE text block yields its BYTE count, not char count (load-bearing)", () => {
    expect(resultBytes([{ type: "text", text: "café" }])).toBe(5);
    expect(resultBytes([{ type: "text", text: "é".repeat(4) }])).toBe(8);
    expect(resultBytes([{ type: "text", text: "😀" }])).toBe(4);
  });

  it("empty text → 0", () => {
    expect(resultBytes([{ type: "text", text: "" }])).toBe(0);
  });

  it("an image block contributes its base64 CHAR length", () => {
    expect(resultBytes([{ type: "image", data: "abcdefgh", mimeType: "image/png" }])).toBe(8);
  });

  it("an image block with no data → 0 (defensive)", () => {
    expect(resultBytes([{ type: "image", mimeType: "image/png" }])).toBe(0);
  });

  it("an unknown block type contributes 0 (forward-compat)", () => {
    expect(resultBytes([{ type: "thinking", thinking: "abc" }])).toBe(0);
    expect(resultBytes([{ type: "toolCall", name: "read", arguments: {} }])).toBe(0);
  });

  it("a non-record block element is skipped → contributes 0 (defensive)", () => {
    expect(resultBytes([null, 42, "raw", undefined] as unknown as ResultContentBlock[])).toBe(0);
  });

  it("mixes text + image blocks and sums across the array", () => {
    const content: ResultContentBlock[] = [
      { type: "text", text: "ab" },
      { type: "image", data: "abcd", mimeType: "image/png" },
      { type: "text", text: "café" },
    ];
    expect(resultBytes(content)).toBe(11); // 2 + 4 + 5
  });

  it("accepts a real-ish Pi (TextContent | ImageContent)[] shape (structural typing)", () => {
    const content = [
      { type: "text", text: "hello world" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ] as const;
    expect(resultBytes(content as unknown as ResultContentBlock[])).toBe(15);
  });

  it("never throws on a throwing-Proxy block (fail-open)", () => {
    const trap = new Proxy(
      { type: "text", text: "abcd" },
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => resultBytes([trap as unknown as ResultContentBlock])).not.toThrow();
    expect(resultBytes([trap as unknown as ResultContentBlock])).toBe(0);
  });
});

// ── approxTokens — spec/04 §5, spec/07 §1 ──────────────────────────────────

describe("approxTokens — byte→token conversion (spec/04 §5, spec/07 §1 '8 KB ≈ 2k tokens')", () => {
  it("0 bytes → 0 tokens", () => {
    expect(approxTokens(0)).toBe(0);
  });

  it("divides bytes by CHARS_PER_TOKEN=4 with ceil", () => {
    expect(approxTokens(40)).toBe(10);
    expect(approxTokens(41)).toBe(11);
    expect(approxTokens(1)).toBe(1);
  });

  it("reproduces spec/07 §1's '8 KB ≈ 2k tokens' equivalence EXACTLY (load-bearing)", () => {
    expect(approxTokens(8192)).toBe(2048);
  });

  it("negative bytes → 0 (defensive)", () => {
    expect(approxTokens(-100)).toBe(0);
    expect(approxTokens(-1)).toBe(0);
  });

  it("NaN / Infinity → 0 (defensive)", () => {
    expect(approxTokens(Number.NaN)).toBe(0);
    expect(approxTokens(Number.POSITIVE_INFINITY)).toBe(0);
    expect(approxTokens(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("is monotonic non-decreasing in bytes", () => {
    expect(approxTokens(100)).toBeLessThanOrEqual(approxTokens(200));
    expect(approxTokens(8000)).toBe(2000);
    expect(approxTokens(8001)).toBe(2001);
  });

  it("composes end-to-end with resultBytes (the spec/07 §1 pipeline)", () => {
    const bytes = resultBytes([{ type: "text", text: "a".repeat(8000) }]);
    expect(bytes).toBe(8000);
    expect(approxTokens(bytes)).toBe(2000);
  });
});

describe("types (ResultContentBlock)", () => {
  it("ResultContentBlock accepts TextContent and ImageContent shapes (structural)", () => {
    const text: ResultContentBlock = { type: "text", text: "hi" };
    const image: ResultContentBlock = { type: "image", data: "AAAA", mimeType: "image/png" };
    expectTypeOf(text).toEqualTypeOf<ResultContentBlock>();
    expectTypeOf(image).toEqualTypeOf<ResultContentBlock>();
  });

  it("resultBytes returns a number; approxTokens returns a number", () => {
    expectTypeOf(resultBytes([])).toEqualTypeOf<number>();
    expectTypeOf(approxTokens(0)).toEqualTypeOf<number>();
  });
});
