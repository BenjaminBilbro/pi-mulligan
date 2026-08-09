# System Context — pi-mulligan-hack

> Produced by the Research Phase of plan 001. Read by every downstream PRP agent.
> Verified against the live environment on 2026-08-08.

## 1. What this project is

**pi-mulligan** is a Pi extension giving a coding agent autonomous, token-cheap
control over its own context window: *rewind* (shed a recent span + leave a
note), *shrink* (replace a message's content), *checkpoint* (named anchor), and
*audit* (filtered-view token breakdown) — plus two zero-extra-request nudges.

Mechanism (one-sentence): persist lightweight **markers** as Pi `CustomEntry`s
(not in LLM context), and a single **`context`-event handler** reads them on
every inference and rewrites the message copy sent to the model — hiding spans,
substituting content, injecting a nudge — without ever mutating the session tree
and without any extra model request.

## 2. Environment reality check

| Item | PRD claim | Verified reality | OK? |
|---|---|---|---|
| Pi version | `0.84.x` target | `pi --version` → **0.84.1** | ✅ |
| Project state | Greenfield build per spec/11 layout | `pi-mulligan-hack` is **greenfield** (only `spec/`, `.hack`, `plan/`); no `src/`, no `package.json` yet | ✅ matches |
| Runtime deps | `@earendil-works/pi-coding-agent`, `typebox`, `vitest` | resolvable from Pi's own install at load; `node_modules` only needed for editor IntelliSense | ✅ |
| Worktree model | (unstated) | **CRITICAL:** `pi-mulligan-hack` is a git worktree of `/home/dustin/projects/pi-mulligan` (`.git` → `…/pi-mulligan/.git/worktrees/pi-mulligan-hack`, branch `hack`; main checkout on branch `main`) | ⚠ see §3 |

## 3. CRITICAL FINDING — a complete reference implementation already exists

The **main worktree** `/home/dustin/projects/pi-mulligan/` (branch `main`,
HEAD `554a5f5`) contains a **complete, ~5.5k-LOC implementation** that matches
the spec's module layout **exactly**, plus a full test suite. This is decisive
de-risking evidence: every primitive the PRD specifies has been implemented and
survives a test suite. The implementer of `pi-mulligan-hack` SHOULD treat the
sibling main as a **read-only oracle/reference** (it even exhibits post-spec
refinements — see external_deps.md §3), while building fresh in the `hack`
worktree.

Sibling implementation inventory (all present, non-stub line counts):
```
src/index.ts (57)      src/config.ts (355)   src/log.ts (111)      src/runtime.ts (154)
src/markers.ts (376)   src/filter.ts (253)   src/transforms.ts(1185) src/ledger.ts (397)
src/tokens.ts (307)    src/notes.ts (398)    src/nudges.ts (357)
src/tools/rewind.ts(472) src/tools/shrink.ts(292) src/tools/checkpoint.ts(175) src/tools/audit.ts(600)
test/ — 15 unit suites + test/integration/{smoke.ts,run-smoke.mjs,scenarios.md}
```

**Implication for decomposition:** this is a *known-tractable* build. The risk is
NOT feasibility — it is (a) faithfully transcribing the spec's contracts (the
sibling is a guide, but the **PRD/spec is the canonical contract**), and (b) the
spec-vs-implemented divergence on bloat thresholds (see external_deps.md §3) —
resolve in favor of the PRD for v1, note the refinement.

## 4. Verified Pi surfaces (the load-bearing facts)

All confirmed against
`/home/dustin/projects/pi-mulligan/node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts`
(Pi 0.84.1). The `.d.ts` is authoritative; spec reproductions are accurate.

### 4.1 `ExtensionAPI` write methods (the ONLY write paths available to a tool)
- `appendEntry<T>(customType: string, data?: T): void` → **void, not an id**
  (spec C7 ✅). Capture a fresh marker's id via `ctx.sessionManager.getLeafId()`
  immediately after, same synchronous tick.
- `sendMessage<T>(msg: {customType; content; display; details?}, options?: {triggerTurn?; deliverAs?}): void`
- `setLabel(entryId: string, label: string | undefined): void` (on `pi`, NOT on
  ReadonlySessionManager — consistent with C1)
- `registerTool<…>(tool: ToolDefinition<…>): void` — `execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>`
- `on(event, handler): void`

Methods **deliberately unused**: `sendUserMessage` (bypasses command dispatch —
spec C2), `registerCommand` (no human commands — D8).

### 4.2 `ReadonlySessionManager` (read surface)
Exact `Pick` confirmed (spec C1 ✅):
`getCwd | getSessionDir | getSessionId | getSessionFile | getLeafId |
getLeafEntry | getEntry | getLabel | getBranch | buildContextEntries |
getHeader | getEntries | getTree | getSessionName`. **No mutators** (`branch`,
`appendMessage`, `setLabel`-mutator, etc. are physically absent).

### 4.3 Events (all confirmed present in `Events`)
`session_start`, `context`, `tool_result`, `turn_start`, `turn_end`,
`agent_settled`, `message_end`, `agent_start`/`agent_end`, compaction events.
Key payloads:
- `ContextEvent` = `{ type:"context"; messages: AgentMessage[] }` — return
  `{messages}` to replace for that one inference (spec C4 ✅).
- `TurnEndEvent` = `{ type:"turn_end"; turnIndex: number; message: AgentMessage;
  toolResults: ToolResultMessage[] }` — **NO `messages` array**, so the drift
  metric MUST use an in-memory token baseline (spec/07 §2 ✅).
- `ToolResultEvent` is a **per-tool discriminated union** (each variant has
  `toolName` as a string literal + shared `{toolCallId, input, content, isError,
  usage?}`). The bloat annotator reads `event.content` (shared) + `event.toolName`
  (narrowed); safe across all variants.

### 4.4 `AgentMessage` union (what transforms operate on)
Imported from `@earendil-works/pi-agent-core`; extended in pi-coding-agent with
`BashExecutionMessage` (`role:"bashExecution"`), `CustomMessage<T>`
(`role:"custom"; customType; content: string|(TextContent|ImageContent)[];
display; details`), `BranchSummaryMessage`, `CompactionSummaryMessage`. Base
roles: `user`, `assistant`, `toolResult` (`toolCallId`, `toolName`, `isError`,
`content`). Content blocks: `{type:"text"}`, `{type:"image"}`, `{type:"thinking"}`,
`{type:"toolCall", id, name, arguments}`. **Tool-pairing invariant** (spec/06 §2)
is real: the provider rejects an orphaned `toolCall` or `toolResult`.

### 4.5 `getContextUsage(): ContextUsage | undefined`
Confirmed; reflects Pi's bookkeeping including hidden messages → **must NOT be
used for honest token reporting** (D5). `mulligan_audit` computes from the
filtered view (`runtime.lastFiltered`) instead.

## 5. The hard constraints (do NOT re-attempt — spec/02, all verified)
- **C1** Tools cannot mutate `ctx.sessionManager` (ReadonlySessionManager).
- **C2** `pi.sendUserMessage("/cmd")` does NOT dispatch commands — it delivers
  the slash-string to the model as a user message. Kills tool→command→commandContext.
- **C3** `navigateTree`/`fork`/`newSession`/etc. are command-context-only →
  unreachable by the agent. Real tree-branching is human-only via native `/tree`.
- **C6** `tool_result`/`message_end` rewrites persist to JSONL but fire **only at
  production time** → retroactive shrink MUST be a view-substitution marker, not
  a JSONL rewrite.
- The whole design is built on `appendEntry` + `sendMessage` + `setLabel` only.

## 6. Decisions LOCKED by the spike (spec §9 decision log)
D1 soft retry only · D2 agent-authored note + deterministic ledger (no model
summarizer) · D3 advisory nudges (no auto-shrink) · D4 nudge rides `context`
(zero extra requests) · D5 audit from filtered view · D6 no undo (agent rewinds
permanent; human uses `/tree`) · D7 relative targeting (compaction-robust) · D8
no human command, no tree mutation.

## 7. Open question carried into the plan
**Bloat threshold: single (PRD) vs per-tool (sibling main).** The PRD/spec
specifies a single `nudges.bloatThresholdBytes: 8192`. The sibling main's git
log (`0ccb5d3`–`f7664aa`) shows it evolved to **per-tool bloat thresholds**. →
v1 follows the **PRD (single threshold)** as canonical; flag per-tool as a
documented refinement in M4's audit/shrink context and revisit after MVP.
