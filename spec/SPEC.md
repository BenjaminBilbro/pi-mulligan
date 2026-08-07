# pi-mulligan — Specification

**Status:** Draft 1.0 · **Target:** Pi `0.84.x` · **License:** MIT · **Name origin:** a *mulligan* is a courtesy do-over in golf — a second shot after a bad one, without penalty. That is exactly what this extension gives the agent.

---

## 0. How to read this document

This is the **master document**. It contains the full Product Requirements Document (PRD) and the architectural overview — enough to understand *what* we are building and *why*. The detailed engineering sections live in companion documents and are linked from the **Index** at the bottom of this document. A build tool may concatenate the master plus every linked file, in index order, to produce one omnibus specification.

This spec is written so that a **naive dev agent can one-shot the implementation**. That means it does not assume prior knowledge of Pi internals: the prerequisite knowledge is included (see `@01-pi-context-internals.md`), the dead-ends discovered during the feasibility spike are called out so they are not repeated (see `@02-proven-constraints.md`), and the build order is prescribed step-by-step (see `@11-build-order.md`).

Throughout, **MUST / SHOULD / MAY** are used in the RFC 2119 sense.

---

## 1. Executive summary

**pi-mulligan** is a Pi extension that gives a coding agent **autonomous, token-cheap control over its own context window** — the ability to shed context it produced by mistake (a giant un-suppressed command output, a too-large file read, a wrong-direction exploration) and to *redo* a turn with a self-authored note, without a human in the loop.

The core insight, established empirically during the feasibility spike (see `@reference/HANDOFF.md`), is that Pi's conversation is an **append-only tree** that an agent *cannot* structurally mutate from a tool, but the agent **can** drop persisted "view instructions" that the `context` event honors on every subsequent inference. Mulligan exploits this: a rewind is not a deletion — it is a **permanent soft-delete**: a persisted instruction that hides a span of messages from every future copy sent to the model, while the originals remain on disk and visible in `/tree` as an audit trail.

The extension is deliberately minimal. It adds **one mechanism** (persisted markers driving a `context`-event view transform) and **two operations** on top of it (*rewind* = remove a span; *shrink* = replace a message's content), plus two cheap, ride-along *nudges* that help the agent notice when it should use them. It does **not** add any human-facing command, any session-tree mutation, or any new model request — all of which were evaluated and rejected as redundant with Pi's existing `/tree`, `/compact`, and `/fork`.

---

## 2. Problem statement (PRD)

### 2.1 The pain

Agents waste context tokens in predictable, recoverable ways:

1. **Unbounded output capture.** The agent runs a command or search whose output is far larger than it needs (`grep -r foo .` over a monorepo, `cat` on a log, a test runner with verbose output). Even though Pi's built-in tools truncate individual results at ~50 KB / 2000 lines, that is still ~10k tokens per result, and several such results in one turn cause real bloat that persists in every subsequent turn.
2. **Wrong-direction work.** The agent pursues an approach across one or more turns, accumulating tool calls and reasoning, then reaches an insight that invalidates the approach. The work is sunk, but its context footprint continues to tax every future inference and distract the model.
3. **Silent accumulation.** No single result is catastrophic, but the turn grew the context substantially. The agent has no built-in signal that it is drifting toward an auto-compaction it would rather avoid.

### 2.2 Why Pi's existing tools don't solve this

Pi already has powerful context machinery: auto-compaction, manual `/compact`, `/tree` branching with summaries, and `/fork`. These are all **either non-autonomous or wrong-direction for this use case**:

- **Compaction summarizes the *head* and *keeps the tail*.** It sheds *old* context to make room. It cannot shed *recent* wrong-direction work — which is the thing the agent actually wants to undo. (Verified: see `@02-proven-constraints.md`.)
- **`/tree`, `/compact`, `/fork` are human-driven.** The agent **cannot** invoke them. The spike proved that an extension-injected message (`pi.sendUserMessage`) bypasses command dispatch entirely (verified twice), so an agent tool has no route to `navigateTree` or command context. See `@02-proven-constraints.md`.
- **There is no agent-callable primitive** for "forget what I just did and try again." The agent's only self-managed recovery today is to keep going and let auto-compaction eventually kick in — which loses the agent's *intent* (what it would do differently) and operates on whatever is oldest, not on what the agent knows was the mistake.

### 2.3 What we build

Mulligan gives the agent that missing primitive. Concretely, the agent gains the ability to:

- **Rewind** — hide either its *last tool-call group* or its *last full turn*, and leave itself a structured note so the resumed attempt is better-informed.
- **Shrink** — replace a specific past tool result (or message) with a compact summary, persistently, in the view.
- **Checkpoint** — tag the current position with a name, so a later rewind can target it precisely.
- **Audit** — see a token breakdown of its own context (computed from the *filtered* view, not Pi's bookkeeping), so its rewind decisions are informed.
- **Be nudged** — automatically, at near-zero token cost, when a tool result is bloated or a turn grew sharply.

### 2.4 Target users

- **Primary:** the agent itself (Mulligan's "user" is the LLM calling its tools).
- **Secondary:** the human operator, who benefits from cheaper, less-distracted agent runs and can inspect any rewind via Pi's native `/tree`.

### 2.5 Success criteria

1. An agent that captures a bloated tool result can, **autonomously and within the same agent loop**, shed it so that no subsequent inference sees it — proven end-to-end.
2. The total token cost of a rewind (the note + any overhead) is **smaller than** the tokens shed, for any rewind of material size; rewinds of trivial size are discouraged by the audit/nudge logic.
3. The extension **adds zero extra model requests** in steady state (the per-turn nudge rides the existing inference).
4. Hidden content is **never silently lost**: it remains in the session JSONL and is visible in `/tree`.
5. The extension is **non-fatal**: any internal error degrades to a no-op + a log line, never breaking the agent loop.

### 2.6 Non-goals (explicitly out of scope)

- **Hard deletion** of messages. Mulligan never removes anything from disk; it only filters the view.
- **Real tree branching** from an agent tool. Proven impossible (and redundant with `/tree`); see `@02-proven-constraints.md`.
- **Hard retry / replay** of prior tool calls. Mulligan supports *soft* retry only (rewind + note + re-plan). Replaying tool calls is dangerous because hidden tool calls' **side effects persist on disk** (files written, commands run) and replay would compound them. See `@08-edge-cases.md`.
- **Undo / un-rewind.** Agent-initiated rewinds are permanent. (A human who wants to explore hidden content uses Pi's native `/tree`.) See decision log in `@reference/HANDOFF.md`.
- **Human-facing commands.** None. The human side is fully served by `/tree` + `/compact` + `/fork`; a Mulligan command would duplicate built-ins.
- **Cross-session or cross-project rewind.** Mulligan operates within a single session only.
- **Auto-summarization of content via a model call.** Mulligan's notes are agent-authored and its file-ledger is extracted deterministically. It does not spend a model request to summarize. (Optional model-summarization of *very large* rewinds is left as a documented future extension, not v1.)

---

## 3. Design principles

1. **Minimal surface.** One mechanism, two operations, two nudges, a few tools. If a feature can be done with Pi's existing UI, Mulligan does not add it.
2. **Soft over hard.** Never mutate the session tree. Hide from the view; persist the originals. Recoverability and auditability are free byproducts.
3. **Zero extra requests.** Anything that nudges the agent must ride an inference that was already happening. A feature that costs a model call per turn is, by definition, counter to the project's purpose.
4. **Fail open.** Every handler is wrapped so that an exception becomes a logged no-op, never a broken agent turn.
5. **The agent is the user.** Tool names, descriptions, and note contracts are optimized for the LLM's reliable use, not for human ergonomics.
6. **Honest bookkeeping.** Token accounting reported to the agent reflects the *filtered* view (what the model actually sees), never Pi's raw `getContextUsage()` which counts hidden tokens.

---

## 4. High-level architecture

Mulligan is a single Pi extension (one entry file, possibly split into internal modules) that registers:

- **4 agent-callable tools:** `mulligan_rewind`, `mulligan_shrink`, `mulligan_checkpoint`, `mulligan_audit`.
- **1 event-driven context filter:** a `context` handler that is the heart of the extension — it reads persisted *markers* and rewrites the message copy sent to the model.
- **2 preventive hooks:** a `tool_result` annotator (bloated-result reminder) and a `turn_end`→`context` per-turn nudge.

All persistent state is stored as **Pi `CustomEntry`s** (via `pi.appendEntry`) — these do *not* participate in LLM context, which is exactly what we want for control state. The agent's self-authored notes are stored as **`CustomMessage`s** (via `pi.sendMessage`) — these *do* participate in context, which is what we want for the note the resumed model must read.

The data flow on a rewind:

```
agent calls mulligan_rewind(note, granularity)
   │
   ├─ pi.appendEntry("mulligan:rewind", { spec, noteRef, ts })   ← control state (NOT in context)
   ├─ pi.sendMessage({ customType:"mulligan:note", content })     ← the note (IN context)
   └─ tool returns a short confirmation

agent loop continues → next inference fires the `context` event
   │
   └─ context handler:
        1. read event.messages (deep copy of the active branch)
        2. read all mulligan:* markers from ctx.sessionManager.getEntries()
        3. resolve each marker's spec against event.messages
           (rewind → remove a span;  shrink → replace a message's content)
        4. return { messages: transformed }
   │
   └─ model sees [kept prefix] + [note] + [rewind confirmation],
      resumes work — auto-prompt is just the normal agent loop
```

The same `context` handler is also where the per-turn nudge injects its one-line annotation (computed at the previous `turn_end`), and where the audit tool could read the filtered set. There is exactly **one** transform pipeline; operations compose as ordered passes over the message copy.

The architecture is fully detailed in `@03-architecture.md`.

---

## 5. The two operations (plain-language summary)

> Full detail: `@05-tools.md` and `@06-context-filter.md`.

- **Rewind** — the "mulligan." The agent hides a recent span and leaves itself a note. Two granularities:
  - **`last_tool_call_group`** — hide the most recent assistant message that issued tool calls, *together with* its tool-result messages. Surgical: keeps the agent's surrounding reasoning, sheds only the bad tool interaction and its output.
  - **`last_turn`** — hide all agent work (assistant + tool-result messages) produced *after* the most recent user message, leaving that user message in place. The model lands back at the current user prompt, ready to re-attempt the turn with the note. (An option, `to_previous_prompt`, discards the most recent user message too, for the nuclear case.)
- **Shrink** — replace the content of one specific past message (typically a bloated `toolResult`) with a compact replacement, in the view. The replacement persists for as long as the marker exists (permanent soft substitution).

Both are **permanent until... nothing** — there is no undo. They persist across reload and `/resume`.

---

## 6. The two nudges (plain-language summary)

> Full detail: `@07-preventive-and-nudges.md`.

- **Bloated-result reminder.** A `tool_result` hook measures each result; if it exceeds a configurable threshold, the hook appends a short reminder to that result's content telling the agent a rewind is available. This rides the result itself — no extra request.
- **Per-turn drift nudge.** At `turn_end`, Mulligan records how much the context grew that turn and whether it crossed a drift threshold. On the *next* inference, the `context` handler injects a one-line annotation into the message copy (e.g. `[mulligan: last turn +4.2k tokens; rewind available]`). This rides the inference that was already going to happen — **zero extra requests**, ~20 tokens when it fires.

---

## 7. Configuration surface (summary)

> Full detail: `@09-configuration.md`.

Mulligan reads `mulligan` from Pi `settings.json` (global or project-local). Key knobs: bloat threshold, drift threshold, protected roles (messages that can never be rewound past — default: system, first user task, latest user prompt), max rewind depth, and on/off toggles for each nudge. All have safe defaults; the extension works with zero configuration.

---

## 8. Verification strategy (summary)

> Full detail: `@10-testing.md`.

The feasibility spike already produced a proven smoke harness (`@reference/looper-smoke.proto.ts`) that demonstrates every primitive. The testing plan mirrors it: a deterministic command-based suite for the data layer, and model-driven integration runs that prove the `context`-filter takes effect on the next inference and the model auto-continues. Pass/fail criteria are tied to the same observables used in the spike (message counts in the filtered payload, persisted entry shapes in session JSONL).

---

## 9. Decision log (condensed)

The full reasoning lives in `@reference/HANDOFF.md`. The locked decisions:

| # | Decision | Rationale |
|---|---|---|
| D1 | Soft retry only; granularities = `last_tool_call_group` and `last_turn` | Hard replay compounds persisted side effects |
| D2 | Roll-our-own structured note + deterministic file ledger; no model summarizer | Summarizer describes (abandonment); we need to redirect (retry) |
| D3 | Advisory preventive reminders (not auto-shrink) | Auto-shrink risks discarding data the model needs |
| D4 | Per-turn nudge via `context`-event annotation | Zero extra requests — the project's central constraint |
| D5 | Audit tokens computed from filtered view, not `getContextUsage()` | `getContextUsage()` counts hidden tokens (bookkeeping drift) |
| D6 | No undo; agent rewinds are permanent; human uses `/tree` | Simplicity; `/tree` already serves human recovery |
| D7 | Relative targeting for the two granularities | Robust across compaction (which renumbers entries) |
| D8 | No human command; no session-tree mutation | Redundant with Pi's built-in `/tree`/`/compact`/`/fork` |

---

## 10. Glossary (summary)

Full glossary in `@12-glossary.md`. Key terms: **marker** (a persisted `CustomEntry` that instructs the context filter), **view transform** (the rewriting of `event.messages`), **soft-delete** (hidden from model view, retained on disk), **granularity** (the unit a rewind targets), **nudge** (a cheap, ride-along reminder), **ledger** (the deterministic file read/modified record extracted from tool calls).

---

## Index

Read in order for a complete specification. The omnibus = this master + every linked file below.

1. Prerequisite knowledge — how Pi's context actually works — `@01-pi-context-internals.md`
2. Proven constraints from the feasibility spike (do not repeat these dead-ends) — `@02-proven-constraints.md`
3. Architecture — the unified marker + context-event design — `@03-architecture.md`
4. Data model — markers, notes, ledgers, schemas — `@04-data-model.md`
5. Tools — the agent-callable API — `@05-tools.md`
6. The context filter — the core algorithm (granularities, pairing, composition) — `@06-context-filter.md`
7. Preventive layer & nudges — bloated-result reminder + per-turn drift nudge — `@07-preventive-and-nudges.md`
8. Edge cases & failure modes — `@08-edge-cases.md`
9. Configuration — settings schema & defaults — `@09-configuration.md`
10. Testing & verification — `@10-testing.md`
11. File layout & build order — `@11-build-order.md`
12. Glossary & references — `@12-glossary.md`

Reference artifacts (not part of the narrative, but proven and authoritative):

- Feasibility spike handoff (compressed findings) — `@reference/HANDOFF.md`
- Proven smoke harness (prototype; uses `looper_*` names, the precursor to `mulligan_*`) — `@reference/looper-smoke.proto.ts`
