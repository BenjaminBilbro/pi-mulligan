# Research — P1.M2.T2.S1: protectedOk — add `latest:user` branch + unit tests

## Scope
BUG-003 FILTER layer (spec/06 §8 defense-in-depth). This subtask is the **filter** half;
the sibling **tool** half (rewind tool checkpoint pre-persist guard) is P1.M2.T2.S2 and is
OUT OF SCOPE here. This subtask touches ONLY:
- `src/transforms.ts` → `protectedOk` (add `latest:user` branch + refactor the early-return)
- `test/pipeline.test.ts` → `protectedOk` describe block (4 new tests + 1 existing test update)

It does NOT touch: `resolveCheckpoint`, `filterPipeline`'s dispatch, `tools/rewind.ts`,
`ProtectedConfig` type (already has the field), or config defaults (already include `latest:user`).

## Current `protectedOk` (src/transforms.ts:767, verbatim)
```ts
export function protectedOk(messages, remove, config): boolean {
  if (!Array.isArray(remove) || remove.length === 0) return true;
  if (!Array.isArray(messages)) return true;

  let protectFirstUser = true;
  const rewindCfg = isRecord(config) ? readOwn(config, "rewind") : undefined;
  const roles = isRecord(rewindCfg) ? readOwn(rewindCfg, "protectedRoles") : undefined;
  if (Array.isArray(roles) && roles.length > 0) {
    protectFirstUser = roles.some((r) => r === "first:user");
  }
  if (!protectFirstUser) return true;          // <<< THIS EARLY-RETURN MUST GO

  let iFirstUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") { iFirstUser = i; break; }
  }
  if (iFirstUser === -1) return true;

  let minRemove = Infinity;
  for (const r of remove) {
    if (typeof r === "number" && !Number.isNaN(r) && r < minRemove) minRemove = r;
  }
  if (!Number.isFinite(minRemove)) return true;
  return minRemove > iFirstUser;
}
```

## WHY the early-return `if (!protectFirstUser) return true;` MUST be refactored away
That early-return was safe when `first:user` was the ONLY selector. With TWO independent
selectors, an early `return true` when first:user is OFF would SHORT-CIRCUIT the latest:user
check. Concretely, config `{ rewind: { protectedRoles: ["latest:user"] } }` (first:user
omitted, latest:user present) sets `protectFirstUser=false` → old early-return → `true` →
latest:user NEVER enforced. The refactor computes BOTH booleans and checks each block
independently (fall-through, not early-return-true).

## Fail-safe defaults (mirror first:user EXACTLY)
- `roles` absent / empty / malformed → BOTH `protectFirstUser` and `protectLatestUser`
  default to **true** (enforce). This is the existing first:user discipline.
- `roles` present + non-empty → each selector is enforced IFF its string is in the array
  (`roles.some(r => r === "first:user")` / `"latest:user"`).

## Target refactored logic (verified by hand-trace against ALL existing + new tests)
```ts
// after the two top guards (empty remove → true; non-array messages → true) ...
const rewindCfg = isRecord(config) ? readOwn(config, "rewind") : undefined;
const roles = isRecord(rewindCfg) ? readOwn(rewindCfg, "protectedRoles") : undefined;
const hasRoles = Array.isArray(roles) && roles.length > 0;
const protectFirstUser  = !hasRoles || roles.some((r) => r === "first:user");
const protectLatestUser = !hasRoles || roles.some((r) => r === "latest:user");

// first:user block (semantics UNCHANGED — refuse if min(remove) <= iFirstUser)
if (protectFirstUser) {
  let iFirstUser = -1;
  for (let i = 0; i < messages.length; i++)
    if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") { iFirstUser = i; break; }
  if (iFirstUser !== -1) {
    let minRemove = Infinity;
    for (const r of remove)
      if (typeof r === "number" && !Number.isNaN(r) && r < minRemove) minRemove = r;
    if (Number.isFinite(minRemove) && minRemove <= iFirstUser) return false;   // refuse, don't fall through
  }
}

// latest:user block (NEW — spec/06 §8): refuse if remove CONTAINS iLatestUser
if (protectLatestUser) {
  let iLatestUser = -1;
  for (let i = 0; i < messages.length; i++)
    if (isRecord(messages[i]) && readOwn(messages[i], "role") === "user") iLatestUser = i; // LAST match
  if (iLatestUser !== -1 && remove.some((r) => r === iLatestUser)) return false;
}

return true;
```
NOTE on the first:user block: the original final `return minRemove > iFirstUser;` becomes a
`return false`-on-refuse-else-fall-through. Equivalent for first:user semantics; lets the
latest:user block run when first:user passes.

## EXISTING TEST THAT BREAKS — must update (test/pipeline.test.ts ~line 222)
```ts
it("protectedRoles omitting first:user → true (disabled)", () => {
  const cfgDisabled: ProtectedConfig = { rewind: { protectedRoles: ["latest:user"] } };
  const msgs: MessageLike[] = [user("u0"), asst("c"), result("c")];
  expect(protectedOk(msgs, [0], cfgDisabled)).toBe(true);   // <<< now FALSE: iLatestUser=0, remove contains 0
});
```
After the change this config ENABLES latest:user; the single-user fixture has iLatestUser=0;
remove=[0] contains it → returns false, not true. The test's INTENT (first:user disabled) is
preserved by switching to a TWO-user fixture whose `remove` targets iFirstUser but NOT
iLatestUser:
```ts
it("protectedRoles omitting first:user → first:user not enforced (true)", () => {
  const cfgDisabled: ProtectedConfig = { rewind: { protectedRoles: ["latest:user"] } };
  const msgs: MessageLike[] = [user("u0"), asst("c"), result("c"), user("u1")]; // iFirstUser=0, iLatestUser=3
  expect(protectedOk(msgs, [0], cfgDisabled)).toBe(true); // first:user off; latest:user on but remove misses iLatestUser
});
```

## Existing tests that STAY GREEN (hand-verified)
pipeline.test.ts protectedOk block: "min(remove) > iFirstUser → true", "remove including
iFirstUser → false", "remove at iFirstUser → false", "empty remove → true", "no user → true",
"non-array messages → true", "config undefined → enforce", "malformed config → enforce",
"non-number remove entries ignored", "returns boolean". edge-cases.test.ts E3 block (lines
385–420) all use single-user + remove=[0] → caught by first:user → false (unchanged).

## NEW tests (test/pipeline.test.ts, protectedOk describe block) — the 4 contract cases
(a) checkpoint-style remove containing iLatestUser → false
(b) remove NOT containing iLatestUser → true
(c) config omitting latest:user → not enforced (true)
(d) only one user message (iFirstUser===iLatestUser) and remove contains it → false

## NEVER-throws discipline
`isRecord`/`readOwn` swallow Proxy get-traps; non-array messages/remove handled at top;
non-number remove entries ignored by both `min` scan and `remove.some(r => r === iLatestUser)`.
No new throwing surface introduced.

## Validation (verified executable in this repo)
- `npx tsc --noEmit` (typecheck — sibling PRPs use this gate)
- `npx vitest run test/pipeline.test.ts` (the affected file; includes protectedOk block)
- `npx vitest run` (full suite — confirms edge-cases.test.ts + filter.test.ts stay green)

## Files referenced
- src/transforms.ts:754–795 (`protectedOk` + docstring)
- src/transforms.ts:731–735 (`ProtectedConfig` — already has `protectedRoles: string[]`)
- src/transforms.ts:867–890 (`filterPipeline` calls `protectedOk(m, remove, config)` — defense-in-depth wiring, unchanged)
- src/config.ts:82,108 (DEFAULT_CONFIG already lists `["first:user","latest:user"]`; KNOWN_PROTECTED_ROLES set — unchanged)
- test/pipeline.test.ts:191–247 (protectedOk describe block — edit target)
- test/edge-cases.test.ts:385–420 (E3 protectedOk tests — stay green, do NOT edit)
