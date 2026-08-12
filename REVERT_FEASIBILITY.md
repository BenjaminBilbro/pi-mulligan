# Feasibility Analysis: File Revert for `mulligan_rewind`

> Analysis of adding optional file revert to `mulligan_rewind` (granularity `last_tool_call_group`) that undoes file modifications made during that tool call group.

**Status:** Approved for implementation. Refined design below supersedes initial analysis.

**Branch:** `feature/revert-file-changes` on `BenjaminBilbro/pi-mulligan` (fork of `dabstractor/pi-mulligan`).

---

## 1. Current Architecture Summary

**pi-mulligan** is a Pi coding-agent extension that manages context/token budget through "rewind" and "shrink" operations. Key components:

| Module | Responsibility |
|--------|----------------|
| `src/tools/rewind.ts` | The `mulligan_rewind` tool — validates params, persists a rewind marker, leaves an in-context note |
| `src/markers.ts` | Thin wrappers around `pi.appendEntry` / `pi.sendMessage` / `pi.setLabel` — the only write path |
| `src/transforms.ts` | Pure context-filter transforms — `partitionIntoUnits`, `resolveLastToolCallGroup`, `filterPipeline` |
| `src/filter.ts` | The `context` event handler — reads markers, delegates to `filterPipeline`, returns filtered messages |
| `src/ledger.ts` | Deterministic file-ledger extraction — scans tool calls in a message span, classifies read/modified/bash |
| `src/nudges.ts` | Preventive nudges — `tool_result` bloat reminder, `turn_end` metrics |
| `src/runtime.ts` | Per-session in-memory state (SessionRuntime map with seq counter, lastFiltered cache) |

**How rewind currently works:**

1. Agent calls `mulligan_rewind(granularity: "last_tool_call_group", note: {...})`
2. Tool validates note, builds a read-only preview of messages to hide (`resolvePreview`)
3. `extractFileLedger` scans tool calls in that span → produces `{ readFiles[], modifiedFiles[], bashSideEffects[] }`
4. A `mulligan:rewind` marker is persisted (via `pi.appendEntry`) with granularity, note, ledger
5. A `mulligan:note` CustomMessage is sent into context with the rendered note
6. On the NEXT inference, `contextHandler` reads markers, `filterPipeline` hides the targeted messages
7. The hidden span's file changes **persist on disk** — the agent is warned via `MUTATION_WARNING`

**What "sub-agent aware" means here:**

The extension is designed for Pi's serial, cache-stable sub-agent stack (main → manager → worker). Each role gets its own `SessionRuntime` keyed by `sessionId`. Tools are callable at any depth. The "cache-stable" aspect means:
- Markers are persisted to the session JSONL (via `pi.appendEntry`), not held in process memory
- Context transforms are applied fresh each inference from persisted markers
- A child agent's rewind/shrink markers survive when its context is discarded (they're in the session, not the agent's ephemeral state)

This is relevant to revert: if a worker modifies files then rewinds with revert, the revert must happen in the same process (the worker's execution context) before it exits.

---

## 2. Proposed Feature Spec (Refined)

### 2.1. What is `last_tool_call_group`?

A `toolGroup` is one assistant message (with one or more `toolCall` blocks) plus ALL corresponding `toolResult` messages. If an assistant calls `read`, `read`, `edit` in parallel and gets 3 results, that's **one toolGroup**: 1 assistant + 3 toolResults.

Revert applies to the entire group — the model decides what goes in one group, and it's the natural atomic unit.

### 2.2. Two Parameters (Explicit and Pedantic)

Two separate boolean params to make destructive actions explicit:

```typescript
revert_file_changes: Type.Optional(
  Type.Boolean({
    description:
      "When true (with granularity last_tool_call_group), restore files that existed before the tool group. " +
      "Only affects write/edit tools. Best-effort: failures logged but do not block rewind.",
  }),
),
delete_created_files: Type.Optional(
  Type.Boolean({
    description:
      "When true (with granularity last_tool_call_group), DELETE files that were newly created by write tool calls " +
      "in the hidden span (files that did not exist before). DESTRUCTIVE. Best-effort.",
  }),
),
```

- **`revert_file_changes: true`** — restore files that existed before the tool group (modifications undone)
- **`delete_created_files: true`** — delete files that were newly created (didn't exist before)
- Agent can set one, both, or neither. Explicit opt-in for each behavior.

### 2.3. Behavior

When revert flags are set with `granularity: "last_tool_call_group"`:

1. Tool executes normal rewind flow (validate, persist marker, leave note)
2. **Additionally**, for each file-modifying tool call in the hidden span:
   - **`write(path, content)` where file existed**: restore previous contents (if `revert_file_changes`)
   - **`write(path, content)` where file didn't exist**: delete the file (if `delete_created_files`)
   - **`edit(path, edits)`**: reverse edits using oldText/newText swap, in reverse order
3. Bash side effects are **not** reverted
4. Revert is **best-effort**: failures log but don't block rewind
5. Success text reports counts: "Reverted X file(s), deleted Y file(s)"

### 2.4. Scope Constraints

- Only `last_tool_call_group` granularity (surgical scope, single turn)
- Only `write` and `edit` built-in tools
- Not `bash`, not `last_turn`, not `checkpoint`
- Ephemeral: snapshots/edits cleared after each tool group completes
- "Oops just now, let me fix it" — not "oops 20 min ago"

---

## 3. How to Capture Pre-Modification State (Refined)

### Core Insight: Two Different Strategies

**Edit tool calls** carry `oldText`/`newText` — we can reverse them without snapshots.
**Write tool calls** carry only `content` — we need snapshots.

### For `edit`: Reverse Using oldText/newText Swap (No Snapshot)

The edit tool requires `oldText` to be unique in the file. On revert:
1. Collect all edits for the tool call
2. Reverse the array (last edit first)
3. For each edit: read current file, replace `newText` with `oldText`, write back

```typescript
// During tool_call event: record edit info
rt.editStack.push({ toolCallId, path, edits: [...event.input.edits] });

// During rewind revert:
const edits = rt.editStack.filter(e => toolCallIds.includes(e.toolCallId));
for (const edit of edits) {
  for (const e of [...edit.edits].reverse()) {
    const current = fs.readFileSync(edit.path, "utf-8");
    const reverted = current.replace(e.newText, e.oldText);
    fs.writeFileSync(edit.path, reverted);
  }
}
```

**Why this works:** The `newText` was just written by the original edit, so it's unique and matches exactly. Reverse order handles overlapping edits.

### For `write`: Snapshot Before Execution

```typescript
pi.on("tool_call", (event, ctx) => {
  if (event.toolName === "write") {
    const path = resolvePath(event.input.path, ctx.cwd);
    const existed = fs.existsSync(path);
    rt.fileSnapshots.set(event.toolCallId, {
      path,
      existed,
      before: existed ? fs.readFileSync(path, "utf-8") : undefined,
    });
  }
});
```

**During rewind revert:**
- If `existed=true` and `revert_file_changes=true`: restore from `before`
- If `existed=false` and `delete_created_files=true`: delete the file

### Ephemeral: Clear After Each Tool Group

On `tool_result` event, after all results for a tool group complete, clear snapshots/edits for that group. Mulligan is "oops just now" — no long-term TTL complexity needed.

### Pi Does NOT Expose Tool Invocation

Pi's ExtensionAPI has no `invokeTool("edit", {...})` method. Revert uses Node's `fs` module directly — simpler, no overhead.

---

## 4. Files That Would Change

| File | Changes | Rationale |
|------|---------|-----------|
| **NEW: `src/fileSnapshots.ts`** | `registerSnapshotHandler(pi)` — snapshots writes, records edits. `revertFileChanges()` — restores/deletes/reverses. | Dedicated module for file snapshot/revert operations |
| `src/runtime.ts` | Add `fileSnapshots: Map` and `editStack: Array` to `SessionRuntime`. Clear in `freshRuntime`/`resetRuntime`. | In-memory store for snapshots (writes) and edit records |
| `src/index.ts` | Import and call `registerSnapshotHandler(pi)` in factory | Wire the proactive snapshot handler |
| `src/tools/rewind.ts` | Add `revert_file_changes` + `delete_created_files` to schema. Call `revertFileChanges` after marker persist. Update success text + `RewindDetails`. | Tool entry point — accept params, orchestrate revert, report results |
| `src/markers.ts` | Add `revertedFiles?: string[]` and `deletedFiles?: string[]` to `RewindMarker`/`RewindMarkerInput` | Persist revert results in marker for auditability |
| `test/fileSnapshots.test.ts` | New: pure revert logic tests, handler tests with fakes | Maintain test coverage |
| `test/tools/rewind.test.ts` | Add tests for rewind with revert params using existing `makePi`/`makeCtx` pattern | Verify tool integration |

**Not changed (for MVP):** `src/config.ts` (no config yet), `src/notes.ts` (revert info in success text, not note)

---

## 5. Feasibility Assessment

### 5.1. What's Easy ✅

| Item | Assessment |
|------|------------|
| Adding `revert_file_changes` param to rewind tool | Trivial — one TypeBox field |
| Registering a `tool_call` event handler | Trivial — Pi API supports it natively |
| Snapshotting file contents before write/edit | Straightforward — `fs.readFileSync` on `event.input.path` |
| Restoring files during rewind | Straightforward — `fs.writeFileSync` with stored contents |
| Best-effort semantics | Natural fit — wrap each revert in try/catch, log failures |
| Persisting revert results in marker | Trivial — extend `RewindMarker` interface |
| Updating success text / note | Trivial — string interpolation |

### 5.2. What's Moderate ⚠️

| Item | Assessment |
|------|------------|
| Memory management for snapshots | Need size limits, TTL, eviction policy. Must not OOM on large files or long sessions. |
| Path resolution | `event.input.path` may be relative; need `ctx.cwd` to resolve. Must match how Pi's tools resolve paths. |
| Concurrent tool calls | Pi supports parallel tool execution. Snapshot handler must be async-safe (Map operations are fine, but file reads are I/O). |
| Edit tool specifics | `edit` reads the file, applies edits, writes back. Snapshotting before edit gives us the true before-state. Straightforward but must handle the case where edit fails (snapshot exists but file wasn't modified). |
| Sub-agent scope | A worker's snapshots are in its own SessionRuntime. If the worker rewinds with revert, it works. If the worker exits and the main agent rewinds, snapshots are gone. Must document this limitation. |

### 5.3. What's Hard / Blocked 🚧

| Item | Assessment |
|------|------------|
| **Bash revert** | Blocked — impossible to reliably parse all mutation patterns from bash commands. `sed -i`, `echo >> file`, `git commit`, `npm install` all mutate files in unpredictable ways. **Recommendation: explicitly exclude bash from revert.** |
| **Cross-tool revert ordering** | If a turn does `read(A) → edit(A) → write(B referencing A)`, reverting A may leave B inconsistent. This is inherent to the problem — we can only revert mechanically, not semantically. **Recommendation: document this as a known limitation.** |
| **Newly created files** | For `write` on a new file, we need to delete it on revert. Must track whether file existed before. **Solvable: `fs.existsSync` before snapshot.** |
| **Permissions / locked files** | Revert write may fail if file is locked or permissions changed. **Solvable: best-effort with logging.** |
| **Large file snapshots** | A 10MB file snapshot eats RAM. **Solvable: configurable maxSnapshotBytes with logging.** |

### 5.4. Open Questions

1. **Should revert be opt-in per-session or per-rewind?**
   - Current proposal: per-rewind (`revert_file_changes: true`). More explicit, agent controls.
   - Alternative: config flag `revert.autoRevertOnRewind` — agent forgets to ask.

2. **Should revert apply to `last_turn` granularity?**
   - Current proposal: no — too broad, complex.
   - Counter: agent might want it. Risk: more files, more blast radius.

3. **What about custom tools that modify files?**
   - Current proposal: only built-in `write`/`edit`. Custom tools are opaque.
   - Alternative: if a custom tool's `toolCallId` has a snapshot, revert it. But we'd need the custom tool to cooperate.

4. **Should revert be undoable?**
   - If agent rewinds with revert, then realizes it wanted the changes, can it get them back?
   - Current proposal: no — the old contents are overwritten. Document this.
   - Alternative: store reverted contents somewhere (complex).

5. **Sub-agent visibility:**
   - If a worker snapshots files, then rewinds with revert, then exits — does the main agent see the reverted files? Yes (they're on disk). Does the main agent know revert happened? Only if the worker's note/ledger mentions it.

---

## 6. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Snapshot OOM on large files | Medium | High (Pi crash) | `maxSnapshotBytes` config (default 100KB), skip with log |
| Revert fails silently | Medium | Medium (agent trusts revert, file not actually reverted) | Log all failures, report count in success text, note in rewind note |
| Revert deletes important file | Low | High | Only revert files we explicitly `write` with no prior existence; log deletions |
| Concurrent snapshot/revert race | Low | Medium | Map operations are atomic; file I/O is sequential per tool call |
| Agent over-relies on revert | Medium | Medium (risky behavior) | Mutation warning still applies; revert is best-effort; document limitations |
| Sub-agent snapshot loss | High | Medium (revert silently no-ops) | Document: "revert only works within the same agent process that made the changes" |

---

## 7. Recommended Approach (Approved for Implementation)

**Go ahead, scoped conservatively.**

### Phase 1 (MVP) — Implementation Plan

**New file: `src/fileSnapshots.ts`**
- `registerSnapshotHandler(pi)`: registers two event handlers:
  - `pi.on("tool_call", ...)`: on `write`, snapshot file if exists. On `edit`, push edit info to stack.
  - `pi.on("tool_result", ...)`: after all results for a tool group, clear snapshots/edits for that group (ephemeral).
- `revertFileChanges(runtime, toolCallIds, revertFileChanges, deleteCreatedFiles)`: returns `{reverted: string[], deleted: string[], failed: string[]}`:
  - For writes: restore from snapshot or delete
  - For edits: reverse edits in reverse order using fs.replace

**Modify: `src/runtime.ts`**
- Add to `SessionRuntime`:
  - `fileSnapshots: Map<string, {path: string, before?: string, existed: boolean}>`
  - `editStack: Array<{toolCallId: string, path: string, edits: Array<{oldText: string, newText: string}>}>`
- Clear both in `freshRuntime` and `resetRuntime`

**Modify: `src/index.ts`**
- Import and call `registerSnapshotHandler(pi)` in factory

**Modify: `src/tools/rewind.ts`**
- Add `revert_file_changes` and `delete_created_files` optional booleans to `RewindParams` schema
- After persisting marker, if either flag is true and granularity is `last_tool_call_group`:
  - Collect toolCallIds from the tool group
  - Call `revertFileChanges`
  - Update success text: "Reverted X file(s), deleted Y file(s)"
  - Update `RewindDetails` to include revert results

**Modify: `src/markers.ts`**
- Add `revertedFiles?: string[]` and `deletedFiles?: string[]` to `RewindMarker` and `RewindMarkerInput`
- Pass through in `appendRewindMarker`

**No config changes for MVP** — keep it simple, hardcoded behavior.

### Phase 2 (Hardening)

1. Add `revertedFiles` to `RewindMarker` for auditability (already in MVP)
2. Add `mulligan_audit` visibility into active snapshots
3. Add config toggle `revert.enabled` to disable entirely
4. Consider size limits for write snapshots

### Phase 3 (Nice-to-have)

1. Extend to `last_turn` granularity (with extra warnings)
2. Consider bash revert for high-confidence patterns
3. Consider snapshot persistence to disk

---

## 9. Testing Requirements

### Testing Approach (Follow Existing Patterns)

**Cannot test full integration** (agent calling rewind with revert) — Pi agent sessions can't be triggered from unit tests. Tests follow existing repo patterns:

1. **Pure function tests** (like `test/ledger.test.ts`): test `revertFileChanges` directly using real `fs` on temp files. No mocks needed.
2. **Handler tests** (like `test/tools/rewind.test.ts`): test `registerSnapshotHandler` with hand-rolled `makePi()`/`makeCtx()` fakes. Simulate `tool_call` events.
3. **Tool integration tests** (extend `test/tools/rewind.test.ts`): test rewind tool with revert params using same `makePi()`/`makeCtx()` pattern. Verify marker payload includes revert results.

**No `vi.fn()`** — use hand-rolled fakes (objects with arrays that capture calls). Use `clearAll()`/`setConfig(undefined)` in beforeEach/afterEach for stateful tests.

### New Test File: `test/fileSnapshots.test.ts`

Use `fs.mkdtempSync` for isolated temp dirs per test. Clean up with `fs.rmSync` in afterEach.

#### Write Revert Tests
- **File existed**: write overwrites existing file → revert restores original content
- **File didn't exist + delete_created_files=true**: write creates new file → revert deletes it
- **File didn't exist + delete_created_files=false**: write creates new file → revert leaves it
- **File didn't exist + revert_file_changes=true**: no-op (nothing to revert, file is new)
- **Non-existent path during revert**: file was deleted externally → best-effort, no crash, logged in `failed`

#### Edit Revert Tests
- **Single edit**: one edit on a file → revert restores original
- **Multiple edits same file**: two+ edits on same file in one tool group → revert in reverse order
- **Multiple edits different files**: edits on different files → all reverted correctly
- **Empty edits array**: no-op, no crash
- **File modified externally**: file changed between edit and revert → best-effort (may fail to match), logged in `failed`

#### Handler Tests
- **tool_call for write (file exists)**: snapshot captured with `existed=true`, `before` populated
- **tool_call for write (file doesn't exist)**: snapshot captured with `existed=false`
- **tool_call for edit**: edit info pushed to editStack
- **tool_result cleanup**: snapshots/edits cleared after tool group completes

#### Rewind Tool Integration Tests (in `test/tools/rewind.test.ts`)
- **Rewind without revert flags**: existing behavior unchanged, no revert happens
- **Rewind with revert_file_changes=true**: marker includes `revertedFiles`, success text reports count
- **Rewind with delete_created_files=true**: marker includes `deletedFiles`
- **Rewind with both flags**: both arrays populated correctly
- **Rewind with revert flags but no file-modifying tools**: success, 0 files, empty arrays

### Verification Approach
- Use `fs.readFileSync` to verify actual file contents on disk after revert
- Use `fs.existsSync` to verify file deletions
- Verify return value `{reverted, deleted, failed}` matches actual operations
- All tests must pass: `npx vitest run`
- No existing tests broken

### Phase 3 (Nice-to-have)

1. Extend to `last_turn` granularity (with extra warnings)
2. Consider bash revert for high-confidence patterns (e.g., `echo "x" > file`)
3. Consider snapshot persistence to disk (survives Pi restart)

---

## 8. Conclusion

**Feasible with clear boundaries.**

The Pi Extension API provides everything needed:
- `tool_call` event fires before execution with full input (path, content)
- `SessionRuntime` gives per-session in-memory storage
- `fs` module is available for read/write
- Existing rewind infrastructure (markers, notes, ledger) integrates cleanly

The key design decisions:
- **Only `write`/`edit`, never `bash`** — bash is too unpredictable
- **Only `last_tool_call_group`** — surgical scope, bounded blast radius
- **Best-effort with loud logging** — never let revert failure block rewind
- **In-memory snapshots only** — matches existing SessionRuntime semantics
- **Document sub-agent limitation** — snapshots don't survive process boundary

Estimated effort: **3-5 hours** for a competent contributor familiar with the codebase (new module + changes to 4-5 existing files + tests).
