# Research notes — P1.M1.T1.S1 (Scaffold package.json, tsconfig.json, dir tree, no-op index.ts)

Date: 2026-08-08. All facts verified against the live environment (Pi 0.84.1).

## 1. Project state (greenfield)
`pi-mulligan-hack` contains ONLY: `spec/` (SPEC.md + 01-12 + reference/), `.hack`, `plan/`.
No `src/`, no `package.json`, no `tsconfig.json`, no `node_modules`. This task creates the
skeleton. It is git worktree of sibling `/home/dustin/projects/pi-mulligan` (branch `main`,
complete reference impl — read-only oracle).

## 2. Canonical contract = spec/11 §1 (layout) + spec/11 §1.1 (package.json) + §1.2 (tsconfig)
The task CONTRACT DEFINITION defers to spec/11 §1 verbatim. Sibling `/home/dustin/projects/pi-mulligan`
implements it and is a verified oracle (its package.json/tsconfig.json match spec/11 §1.1/§1.2).

### package.json (verified sibling content; spec/11 §1.1)
- `name: pi-mulligan`, `version: 0.1.0`, `type: module`, `main: src/index.ts`
- `pi: { extensions: ["./src/index.ts"] }`
- deps: `@earendil-works/pi-coding-agent: "*"`, `typebox: "*"`
- devDeps: `typescript: "^5"`, `vitest: "^1"`, AND `@types/node: "^22"` (sibling adds this;
  REQUIRED by tsconfig `types:["node"]` for tsc resolution; not needed for jiti runtime load).
- scripts: `test: "vitest run"`, `smoke: ...` (spec shows `pi -e ./src/index.ts -p "$(cat ...)"`;
  sibling uses `node test/integration/run-smoke.mjs` — smoke harness wiring deferred to P1.M5.T3,
  so v1 script can be a placeholder; exact smoke body is NOT in this task's scope).

### tsconfig.json (verified sibling content == spec/11 §1.2 exactly)
`{ compilerOptions: { target:"ES2022", module:"ESNext", moduleResolution:"Bundler",
strict:true, noImplicitAny:true, types:["node"], skipLibCheck:true }, include:["src","test"] }`

## 3. Required file/directory set (spec/11 §1)
src/: index, config, log, runtime, markers, filter, transforms, ledger, tokens, notes, nudges (11 files)
src/tools/: rewind, shrink, checkpoint, audit (4 files)
test/ (dir), test/integration/ (dir) — empty dirs aren't git-tracked, so each needs a file.
Individual test/*.test.ts files are NOT this subtask (they land in M2+). For S1 the contract
IMPLICIT TDD offers "test/integration/load.test.ts OR scenarios.md step"; smoke harness wiring
is explicitly deferred to P1.M5.T3, so load.test.ts is a minimal stub only.

## 4. index.ts no-op factory (verified loadable via `pi -e`)
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {}
```
- `import type` is erased by jiti (no runtime dep on the module at load).
- CONTRACT: "DO NOT register anything yet." No pi.on / pi.registerTool. Empty stubs = `export {}`.

## 5. CRITICAL runtime model (verified in env)
- Extensions are jiti-transpiled ON THE FLY by Pi. NO build step at runtime.
- Pi resolves `@earendil-works/pi-coding-agent` + `typebox` from ITS OWN install
  (extensions load in pi's process). `node_modules` in the ext dir is ONLY for editor
  IntelliSense. Verified: `pi -e` on a no-op in /tmp (NO node_modules) loaded fine.

## 6. Verification gate — empirically confirmed BOTH directions
- `pi -e ./src/index.ts -p "hi"` with valid no-op → prints model response, EXIT 0. ✅
- Same with a syntax error → "Failed to load extension: ParseError..." EXIT 1. ✅
So the gate is meaningful (catches load/transpile errors via non-zero exit).

## 7. Scope boundaries (NOT this task — downstream)
- config.ts/log.ts/runtime.ts/markers.ts/filter.ts/transforms.ts/ledger.ts/tokens.ts/notes.ts/
  nudges.ts/tools/*.ts are EMPTY STUBS here (`export {}`). Their logic lands in M1.T2-T4, M2, M3, M4.
- session_start log line is the M1 MILESTONE goal (achieved once log.ts is wired in index.ts at
  M1.T3/Step-1); this S1 scaffold's factory is no-op and registers nothing, so no log line yet.
  S1 success = clean load + exit 0, NOT a printed log line.
- Smoke harness (test/integration/smoke.ts, scenarios.md, run-smoke.mjs) is P1.M5.T3.
- Real vitest unit tests land in M2+; `npm run test` needs `npm install` first.

## 8. Gotchas / pitfalls
- Empty .ts files under `strict`/ESM are scripts, not modules → use `export {}` in each stub.
- `main:"src/index.ts"` (not dist/index.ts) — jiti loads TS directly, no build.
- `pi` field's `extensions` array enables auto-discovery when the ext dir is linked under
  `.pi/extensions/` — NOT required for `pi -e` ad-hoc load, but part of the contract.
- Must run `pi -e ./src/index.ts -p hi` from project root (relative path).
- Global mulligan extension is already active in this env; `-e` ADDS our ext; both coexist, exit 0.
