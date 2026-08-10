# Research Notes — P1.M4.T3.S1 — `mulligan_checkpoint` execute()

## Work item
Implement the `mulligan_checkpoint` tool's `execute()` in `src/tools/checkpoint.ts`
(currently `export {};` stub): validate name → `setCheckpoint` → return text. Never throw.

## Codebase state (verified)

### The stub to replace
- `src/tools/checkpoint.ts` = `export {};` (single line). Sibling `src/tools/audit.ts` is also
  `export {};`. `src/tools/rewind.ts` + `src/tools/shrink.ts` are FULLY SHIPPED — they are the
  structural templates.

### Dependency already shipped: `markers.ts` → `setCheckpoint(pi, ctx, name): string | null`
Verified at `src/markers.ts`:
- Gets `ctx.sessionManager.getLeafId()`; if `null` → `logError` + return `null`.
- Calls `pi.setLabel(leafId, "mulligan:checkpoint:" + name)`.
- Returns `leafId` (the labeled entry id) or `null` (fail-open, never throws — wrapped in try/catch).
- **The wrapper ONLY prefixes**; name validation (`/^[a-z0-9_-]{1,40}$/`, E10) is the TOOL's job
  (stated in its doc comment). → The checkpoint tool MUST validate the regex BEFORE calling setCheckpoint.
- `setLabel` Pi signature (dist/types.d.ts:942): `setLabel(entryId: string, label: string | undefined): void`.

### Sibling tool template (shrink.ts is the closest — no note/ledger/K-preview needed)
Pattern (identical across rewind.ts + shrink.ts):
- `import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent"`
- `import { Type } from "typebox"; import type { Static } from "typebox";`
- Exported `const XParams = Type.Object({...})` (VERBATIM spec/05 field descriptions).
- Exported `type XArgs = Static<typeof XParams>;`
- Exported `const X_DESC = "..."` (spec/05 §5 VERBATIM).
- Exported `interface XDetails {...}` (the `details` payload — MUST be present on EVERY return path).
- Private `function refusal(reason): AgentToolResult<XDetails>` returning
  `{ content:[{type:"text", text:"Mulligan: refused — <reason>."}], details:{...} }`.
- Private `async function xExecute(pi, toolCallId, params, signal, onUpdate, ctx)` — WHOLE body in
  ONE try/catch (E13 never-throws). `pi` is a closure param (NOT an execute arg).
- Exported `function makeXTool(pi): ToolDefinition<typeof XParams, XDetails>` → `defineTool({ name,
  label, description, parameters, async execute(toolCallId,params,signal,onUpdate,ctx){ return xExecute(pi,...) } })`.
- All intra-project imports use `.js` extensions (ESM + vitest).
- `defineTool<TParams,TDetails,TState>` (dist/types.d.ts:385).

### Config: NO `checkpoint.enabled` sub-gate
`MulliganConfig` (src/config.ts) has `enabled` (master) + `rewind.enabled` + `shrink.enabled` +
`nudges.*` + `audit.*` + `log.*`. There is **no** `checkpoint` sub-object. The checkpoint tool
therefore gates ONLY on the master `config.enabled` (E14: master-disable → tools refuse with
"Mulligan is disabled"). This differs from rewind/shrink which also check their sub-feature gate.
`getConfig()` returns a fresh clone each call (read it ONCE per execute).

## spec/05 §3 contract (VERBATIM, verified by reading spec/05-tools.md)

### Parameter schema
```ts
const CheckpointParams = Type.Object({
  name: Type.String({ description:
    "Checkpoint name. lowercase, digits, hyphen, underscore only; max 40 chars. e.g. 'before-refactor-experiment'." }),
});
```

### Return shape
```ts
{ content: [{ type:"text", text: "Mulligan: checkpoint '<name>' set at entry <id>. Rewind to it with mulligan_rewind(granularity:'checkpoint', checkpoint:'<name>')." }] }
```

### Behavior
1. Validate `name` matches `/^[a-z0-9_-]{1,40}$/`. Else refuse.
2. `const leafId = ctx.sessionManager.getLeafId();`
3. `pi.setLabel(leafId, \`mulligan:checkpoint:${name}\`);` (overwrites prior same-name checkpoint — acceptable.)
4. Return text with the entry id.

## spec/05 §5 Description (VERBATIM, verified)
`"Name the current position so a later mulligan_rewind can jump straight back to it. Use before a speculative sub-task you might want to undo in one shot."`

## Edge cases (spec/08)
- **E10**: checkpoint name invalid (fails regex) → refuse. (mulligan_checkpoint validates format at
  creation; mulligan_rewind validates existence — this tool only does FORMAT validation.)
- **E13**: never throw — whole body in try/catch; any exception → refusal text.
- **E14**: master `config.enabled === false` → refuse "Mulligan is disabled".

## spec/04 §6 — checkpoint is a LabelEntry, NOT a CustomEntry
- Created via `pi.setLabel` (not `appendEntry`). NOT in LLM context. No `seq` bump (checkpoints are
  not markers). Consumed by `filter.resolveCheckpoint` (P1.M2.T5 — already shipped) which scans
  `getBranch()` for a `label === mulligan:checkpoint:<name>` entry and maps it to a message position.

## Test idiom (test/tools/{rewind,shrink}.test.ts — verified)
- vitest: `{describe,it,expect,expectTypeOf,beforeEach,afterEach}`.
- `beforeEach`/`afterEach`: `clearAll()` (runtime.js) + `setConfig(undefined)` (config.js) — resets
  shared module-scoped runtime map + config cache (nextSeq mutates the shared map).
- Hand-rolled fakes (NO `vi.fn`): `makePi(opts)` captures `setLabel` calls; `makeCtx(opts)` exposes
  a `sessionManager` fake with `getSessionId`/`getLeafId`/`getLabel` (backed by a `Map`).
- `run(pi,ctx,params,toolCallId="call-1")` helper; `firstText(res)` extracts `res.content[0].text`.
- markers.test.ts already proves the setLabel/getLabel round-trip (C9): the checkpoint tool test
  should assert `pi.setLabel` was called with `(leafId, "mulligan:checkpoint:<name>")` AND that the
  returned `details.entryId === leafId`.

## Integration scenario F-checkpoint (spec/10 §2.1 — DEFERRED, not this task)
`mulligan_checkpoint("x")` then `mulligan_rewind(granularity:"checkpoint", checkpoint:"x")` → label
exists; rewind hides back to labeled point. Requires wiring (P1.M7.T1.S1) + a driven model loop /
deterministic command. This task ships ONLY the tool + its unit tests; F-checkpoint is a manual
L4 gate here (the executor skips it).

## DOCS impact
Mode A: tool description from spec/05 §5 — the `CKPT_DESC` string IS the LLM-facing doc, copied
VERBATIM into `src/tools/checkpoint.ts`. No separate doc file is touched.

## Out of scope (hard boundaries)
- Do NOT modify `src/index.ts` (wiring = P1.M7.T1.S1).
- Do NOT modify `src/markers.ts` (setCheckpoint already shipped — P1.M3.T1.S1).
- Do NOT re-implement label prefixing / null-leaf handling / seq (markers.ts owns all writes).
- Do NOT import runtime.js / filter.js / notes.js / ledger.js / audit.js.
- Do NOT add a `checkpoint` sub-config knob.
- Do NOT validate checkpoint EXISTENCE (that's mulligan_rewind's job — this tool only validates FORMAT).
