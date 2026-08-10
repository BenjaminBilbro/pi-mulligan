import { describe, it, expect, expectTypeOf } from "vitest";
import { extractFileLedger, type FileLedger, type MessageLike } from "../src/ledger.js";

// No beforeEach needed: ledger.ts has NO module-scoped mutable state (pure over its arguments).

/** Build an assistant message whose content is a list of toolCall blocks. */
function asst(...calls: Array<{ name: string; arguments: Record<string, unknown> }>): MessageLike {
  return {
    role: "assistant",
    content: calls.map((c, idx) => ({
      type: "toolCall",
      id: `call_${idx}`,
      name: c.name,
      arguments: c.arguments,
    })),
  };
}

describe("extractFileLedger — spec/10 §1.6 PINNED contract (the load-bearing test)", () => {
  it("read(a.ts) + edit(b.ts) + bash(git commit) + bash(ls) → the exact pinned ledger", () => {
    const msgs: MessageLike[] = [
      asst({ name: "read", arguments: { path: "a.ts" } }),
      asst({ name: "edit", arguments: { path: "b.ts" } }),
      asst({ name: "bash", arguments: { command: "git commit" } }),
      asst({ name: "bash", arguments: { command: "ls" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2, 3])).toEqual({
      readFiles: ["a.ts"],
      modifiedFiles: ["b.ts"],
      bashSideEffects: ["git commit"], // ls is read-only → omitted
    });
  });

  it("empty span (range []) → all three arrays empty", () => {
    const msgs: MessageLike[] = [asst({ name: "read", arguments: { path: "a.ts" } })];
    expect(extractFileLedger(msgs, [])).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
  });

  it("empty messages → all empty", () => {
    expect(extractFileLedger([], [0, 1, 2])).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
  });

  it("null messages / null range → all empty (defensive)", () => {
    expect(extractFileLedger(null, [0])).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
    expect(extractFileLedger(undefined, null)).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
    expect(extractFileLedger([asst({ name: "read", arguments: { path: "x" } })], null)).toEqual({
      readFiles: [],
      modifiedFiles: [],
      bashSideEffects: [],
    });
  });
});

describe("readFiles classification (read/grep/rg/glob/find/ls → path ?? file_path)", () => {
  it("read with path", () => {
    expect(extractFileLedger([asst({ name: "read", arguments: { path: "src/a.ts" } })], [0]).readFiles).toEqual([
      "src/a.ts",
    ]);
  });

  it("read with file_path (Pi's read accepts either — read.js:39)", () => {
    expect(extractFileLedger([asst({ name: "read", arguments: { file_path: "b.ts" } })], [0]).readFiles).toEqual([
      "b.ts",
    ]);
  });

  it("grep/rg/glob/find/ls with a path arg → readFiles", () => {
    const msgs: MessageLike[] = [
      asst({ name: "grep", arguments: { pattern: "x", path: "g.ts" } }),
      asst({ name: "glob", arguments: { pattern: "*.ts", path: "lib" } }),
      asst({ name: "find", arguments: { pattern: "*.ts", path: "src" } }),
      asst({ name: "ls", arguments: { path: "dist" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2, 3]).readFiles).toEqual(["dist", "g.ts", "lib", "src"]);
  });

  it("read with NO path (missing/mistyped) → contributes nothing", () => {
    expect(extractFileLedger([asst({ name: "read", arguments: { pattern: "x" } })], [0]).readFiles).toEqual([]);
    expect(extractFileLedger([asst({ name: "read", arguments: { path: 42 } })], [0]).readFiles).toEqual([]);
  });

  it("de-duplicates repeated reads and sorts", () => {
    const msgs: MessageLike[] = [
      asst({ name: "read", arguments: { path: "z.ts" } }),
      asst({ name: "read", arguments: { path: "a.ts" } }),
      asst({ name: "read", arguments: { path: "z.ts" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2]).readFiles).toEqual(["a.ts", "z.ts"]);
  });
});

describe("modifiedFiles classification (write/edit path; bash high-confidence paths)", () => {
  it("write + edit paths", () => {
    const msgs: MessageLike[] = [
      asst({ name: "write", arguments: { path: "new.ts", content: "x" } }),
      asst({ name: "edit", arguments: { path: "old.ts", edits: [] } }),
    ];
    expect(extractFileLedger(msgs, [0, 1]).modifiedFiles).toEqual(["new.ts", "old.ts"]);
  });

  it("bash redirect → modifiedFiles (+ command in bashSideEffects)", () => {
    const r = extractFileLedger([asst({ name: "bash", arguments: { command: "echo x > out.txt" } })], [0]);
    expect(r.modifiedFiles).toEqual(["out.txt"]);
    expect(r.bashSideEffects).toEqual(["echo x > out.txt"]);
  });

  it("bash rm/mv/cp/sed → modifiedFiles", () => {
    const msgs: MessageLike[] = [
      asst({ name: "bash", arguments: { command: "rm file.ts" } }),
      asst({ name: "bash", arguments: { command: "mv a.ts b.ts" } }),
      asst({ name: "bash", arguments: { command: "sed -i 's/a/b/' f.ts" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2]).modifiedFiles).toEqual(["a.ts", "b.ts", "f.ts", "file.ts"]);
  });

  it("bash /dev/null redirect → NOT a modified file", () => {
    const r = extractFileLedger([asst({ name: "bash", arguments: { command: "echo x > /dev/null" } })], [0]);
    expect(r.modifiedFiles).toEqual([]);
    expect(r.bashSideEffects).toEqual(["echo x > /dev/null"]);
  });

  it("git commit (no parseable path) → bashSideEffects ONLY, modifiedFiles empty (the contract crux)", () => {
    const r = extractFileLedger(
      [asst({ name: "bash", arguments: { command: 'git commit -m "wip"' } })],
      [0],
    );
    expect(r.modifiedFiles).toEqual([]);
    expect(r.bashSideEffects).toEqual(['git commit -m "wip"']);
  });

  it("node/npm (path-like arg is a SCRIPT/TARGET, not a modified file) → modifiedFiles empty", () => {
    expect(extractFileLedger([asst({ name: "bash", arguments: { command: "node script.js" } })], [0]).modifiedFiles).toEqual([]);
    expect(extractFileLedger([asst({ name: "bash", arguments: { command: "npm install" } })], [0]).modifiedFiles).toEqual([]);
  });

  it("curl -o extracts the output file; curl to stdout does not (URL rejected)", () => {
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "curl -o out.txt https://x.com/y" } })], [0])
        .modifiedFiles,
    ).toEqual(["out.txt"]);
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "curl https://x.com/y" } })], [0])
        .modifiedFiles,
    ).toEqual([]);
  });

  it("de-duplicates modifiedFiles across write tool + bash", () => {
    const msgs: MessageLike[] = [
      asst({ name: "edit", arguments: { path: "z.ts" } }),
      asst({ name: "bash", arguments: { command: "rm z.ts" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1]).modifiedFiles).toEqual(["z.ts"]);
  });
});

describe("bashSideEffects classification — 'when in doubt, include' (high recall)", () => {
  it("read-only commands are OMITTED", () => {
    const msgs: MessageLike[] = [
      asst({ name: "bash", arguments: { command: "ls" } }),
      asst({ name: "bash", arguments: { command: "cat foo" } }),
      asst({ name: "bash", arguments: { command: "grep bar" } }),
      asst({ name: "bash", arguments: { command: "wc -l x" } }),
      asst({ name: "bash", arguments: { command: "find . -name '*.ts'" } }),
      asst({ name: "bash", arguments: { command: "echo done" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2, 3, 4, 5]).bashSideEffects).toEqual([]);
  });

  it("read-only pipelines are omitted (all segments read-only, no redirect)", () => {
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "cat foo | grep bar" } })], [0]).bashSideEffects,
    ).toEqual([]);
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "ls 2>&1 | cat" } })], [0]).bashSideEffects,
    ).toEqual([]); // 2>&1 is fd-dup, not a file write → read-only pipeline
  });

  it("non-read-only commands are INCLUDED (verbatim)", () => {
    const msgs: MessageLike[] = [
      asst({ name: "bash", arguments: { command: "git commit" } }),
      asst({ name: "bash", arguments: { command: "npm install" } }),
      asst({ name: "bash", arguments: { command: "node script.js" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1, 2]).bashSideEffects).toEqual([
      "git commit",
      "node script.js",
      "npm install",
    ]); // sorted
  });

  it("unknown command → included (when in doubt)", () => {
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "my-weird-tool --foo" } })], [0])
        .bashSideEffects,
    ).toEqual(["my-weird-tool --foo"]);
  });

  it("find with destructive flags → included (NOT read-only; GOTCHA #9)", () => {
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "find . -delete" } })], [0]).bashSideEffects,
    ).toEqual(["find . -delete"]);
    expect(
      extractFileLedger([asst({ name: "bash", arguments: { command: "find . -exec rm {} \\;" } })], [0])
        .bashSideEffects,
    ).toEqual(["find . -exec rm {} \\;"]);
  });

  it("tee via pipe → side effect (the pipe target is a write)", () => {
    const r = extractFileLedger([asst({ name: "bash", arguments: { command: "ls | tee out.txt" } })], [0]);
    expect(r.bashSideEffects).toEqual(["ls | tee out.txt"]);
    expect(r.modifiedFiles).toEqual(["out.txt"]);
  });

  it("de-duplicates identical bash commands", () => {
    const msgs: MessageLike[] = [
      asst({ name: "bash", arguments: { command: "git commit" } }),
      asst({ name: "bash", arguments: { command: "git commit" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1]).bashSideEffects).toEqual(["git commit"]);
  });

  it("bash with empty/missing command → ignored (no crash)", () => {
    expect(extractFileLedger([asst({ name: "bash", arguments: { command: "" } })], [0]).bashSideEffects).toEqual([]);
    expect(extractFileLedger([asst({ name: "bash", arguments: {} })], [0]).bashSideEffects).toEqual([]);
  });
});

describe("range iteration — index list, not tuple; only assistant messages scanned", () => {
  it("a toolResult message in the range is skipped (no toolCall blocks)", () => {
    const msgs: MessageLike[] = [
      asst({ name: "read", arguments: { path: "a.ts" } }),
      { role: "toolResult", toolCallId: "call_0", toolName: "read", content: [{ type: "text", text: "..." }] },
    ];
    // range includes the toolResult index [1] — it must be ignored
    expect(extractFileLedger(msgs, [0, 1]).readFiles).toEqual(["a.ts"]);
  });

  it("messages OUTSIDE the range are ignored even if they contain tool calls", () => {
    const msgs: MessageLike[] = [
      asst({ name: "read", arguments: { path: "in.ts" } }),
      asst({ name: "read", arguments: { path: "out.ts" } }),
    ];
    expect(extractFileLedger(msgs, [0]).readFiles).toEqual(["in.ts"]);
  });

  it("out-of-bounds indices are skipped defensively", () => {
    const msgs: MessageLike[] = [asst({ name: "read", arguments: { path: "a.ts" } })];
    expect(extractFileLedger(msgs, [0, 5, 99]).readFiles).toEqual(["a.ts"]);
  });

  it("garbage (non-integer) indices are skipped", () => {
    const msgs: MessageLike[] = [asst({ name: "read", arguments: { path: "a.ts" } })];
    expect(extractFileLedger(msgs, [0, -1, 1.5, Number.NaN] as unknown as number[]).readFiles).toEqual(["a.ts"]);
  });

  it("a user message in the range is skipped", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "please read a.ts" }, // not a toolCall — even though content mentions a file
      asst({ name: "read", arguments: { path: "a.ts" } }),
    ];
    expect(extractFileLedger(msgs, [0, 1]).readFiles).toEqual(["a.ts"]);
  });
});

describe("defensive — never throws (spec/08 E13; rewind-tool hot path)", () => {
  it("non-array content → skipped (no throw)", () => {
    const msgs: MessageLike[] = [
      { role: "assistant", content: "just a string" },
      { role: "assistant", content: undefined },
    ] as unknown as MessageLike[];
    expect(() => extractFileLedger(msgs, [0, 1])).not.toThrow();
    expect(extractFileLedger(msgs, [0, 1])).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
  });

  it("non-record / non-toolCall blocks → skipped", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          null,
          42,
          "raw",
          { type: "text", text: "hi" },
          { type: "thinking", thinking: "..." },
          { name: "read", arguments: { path: "a.ts" } }, // missing type:'toolCall' → ignored
        ],
      } as unknown as MessageLike,
    ];
    expect(() => extractFileLedger(msgs, [0])).not.toThrow();
    expect(extractFileLedger(msgs, [0]).readFiles).toEqual([]); // the block has no type:'toolCall'
  });

  it("a toolCall with non-record arguments → skipped (no throw)", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "read", arguments: "not-a-record" } as unknown as never],
      } as unknown as MessageLike,
    ];
    expect(() => extractFileLedger(msgs, [0])).not.toThrow();
    expect(extractFileLedger(msgs, [0]).readFiles).toEqual([]);
  });

  it("circular arguments → does not throw (we never JSON.stringify arguments)", () => {
    const args: Record<string, unknown> = { path: "a.ts" };
    args.self = args; // circular
    const msgs: MessageLike[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: args }] },
    ] as unknown as MessageLike[];
    expect(() => extractFileLedger(msgs, [0])).not.toThrow();
    expect(extractFileLedger(msgs, [0]).readFiles).toEqual(["a.ts"]); // .path read fine despite the cycle
  });

  it("a throwing-Proxy block → contributes nothing, never crashes (fail-open like tokens.ts)", () => {
    const trap = new Proxy(
      { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    const msgs = [{ role: "assistant", content: [trap] }] as unknown as MessageLike[];
    expect(() => extractFileLedger(msgs, [0])).not.toThrow();
    // every property read throws → readOwn swallows → block classified as non-toolCall → contributes nothing
    expect(extractFileLedger(msgs, [0])).toEqual({ readFiles: [], modifiedFiles: [], bashSideEffects: [] });
  });

  it("accepts a real-ish Pi AgentMessage[] shape (structural typing)", () => {
    const content = [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "real.ts" } }] as const;
    const msgs = [{ role: "assistant", content }] as unknown as MessageLike[];
    expect(extractFileLedger(msgs, [0]).readFiles).toEqual(["real.ts"]);
  });
});

describe("types (P1.M2.T2.S1)", () => {
  it("FileLedger has the spec/04 §2.2 shape", () => {
    const ledger: FileLedger = { readFiles: [], modifiedFiles: [], bashSideEffects: [] };
    expectTypeOf(ledger).toEqualTypeOf<FileLedger>();
    expectTypeOf(ledger.readFiles).toEqualTypeOf<string[]>();
    expectTypeOf(ledger.modifiedFiles).toEqualTypeOf<string[]>();
    expectTypeOf(ledger.bashSideEffects).toEqualTypeOf<string[]>();
  });

  it("extractFileLedger returns a FileLedger", () => {
    expectTypeOf(extractFileLedger([], [])).toEqualTypeOf<FileLedger>();
  });

  it("MessageLike accepts an assistant message with a toolCall content block", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: [{ type: "toolCall", id: "x", name: "read", arguments: { path: "a.ts" } }],
    };
    expectTypeOf(msg).toEqualTypeOf<MessageLike>();
  });
});
