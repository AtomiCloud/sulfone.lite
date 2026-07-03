# CyanPrint v4 E2E Coverage Matrix

Every requested parity case runs as a REAL named test in
`e2e/full-stack/run-full-e2e.test.ts` — the CLI executes against an in-process local
registry with committed fixture folders (`e2e/full-stack/fixtures/`) and expected-output
folder compares (`e2e/full-stack/expected/`, refresh with `E2E_UPDATE_EXPECTED=1`).
Run them with `bun run e2e:full`.

The suite covers the v4-simplification semantics end to end:

- **Update** floats every active installed template to its latest version (`--template
owner/name[@version]` filters or pins). Base is the OLD versions re-executed from the
  answers saved in `.cyan_state.yaml`, theirs the new versions, ours the disk; the three
  meet in a real git three-way merge. Conflicts stay IN-FILE as standard `<<<<<<<`
  markers and the command exits non-zero listing conflicted paths (`.cyan_conflicts/`
  no longer exists).
- **Local sources** re-execute the same directory for base and theirs, so `update` is a
  no-op for template content (user edits always survive). Moving a local project to a
  new template version is a RE-CREATE: `cyanprint create <new-dir> --out <project>` with
  the same owner/name upserts into state and three-way merges.
- **Multi-install**: creating a DIFFERENT template into an existing project layers both
  via tier-3 (installation order, most recent wins LWW) and tracks each in the state's
  `templates:` array with per-template history.
- **Merge decisions are provenance**: every create/update persists the full decision set
  (`added` / `resolver-merged` / `lww-override`, with segment `processor` / `dependency`
  / `sibling`, resolver ref, and contributors) to `.cyan_state.yaml`; the old per-path
  `conflicts:` reason strings are gone. `trace --json` emits `{provenance, tree, diffs}`.

|   # | Case as covered                                                                                                                                                                                                                                               | Status  | Owning coverage                               |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
|   1 | Template works.                                                                                                                                                                                                                                               | covered | `e2e/full-stack/run-full-e2e.test.ts` case 1  |
|   2 | Template works with all input types (text, confirm, select, multiselect, number; defaults and validation).                                                                                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 2  |
|   3 | Two templates can be installed (template group composes children; child answers bubble up).                                                                                                                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 3  |
|   4 | Template installs its own dependencies (processor, plugin, resolver pins under the installed template's `artifacts:`).                                                                                                                                        | covered | `e2e/full-stack/run-full-e2e.test.ts` case 4  |
|   5 | Templates update normally: push v1 → create @v1 → push v2 → update applies the new version's output and reports the version move (`updated: v1 → v2`); the unpinned float applies the same content.                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 5  |
|   6 | Templates update with a three-way merge: local sources re-execute identically (base == theirs), so the user's edit — ours — survives and state stays readable.                                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 6  |
|   7 | Templates update with conflict: moving a local project to a new version is a re-create upsert; genuine divergence leaves in-file `<<<<<<<` markers, exits non-zero, and keeps state at install #1 until the markers are resolved and the re-create is re-run. | covered | `e2e/full-stack/run-full-e2e.test.ts` case 7  |
|   8 | Templates update when the new version deletes files: a same-name version bump deletes a generated file and rewrites another — clean projects update silently, user-edited ones keep the conflict in-file.                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 8  |
|   9 | Multiple templates update with a three-way merge after a same-layer merge: tri-a/b/c's shared.txt merges via consensus resolver inside each generation; git then floats v1→v2 while keeping the user edit.                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 9  |
|  10 | Templates pass forced answers to dependencies (the `templates:` dictionary's embedded answers prefill child prompts).                                                                                                                                         | covered | `e2e/full-stack/run-full-e2e.test.ts` case 10 |
|  11 | Multiple processor output merges, later output overriding earlier — persisted as an `lww-override` provenance entry with segment `processor` and per-invocation contributors.                                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 11 |
|  12 | Same as #11, but a matching resolver (consensus) merges instead of overriding — provenance records `resolver-merged` with the resolver ref and no LWW.                                                                                                        | covered | `e2e/full-stack/run-full-e2e.test.ts` case 12 |
|  13 | Same-file templates without any resolver fall back to LWW (AllNone) — persisted as an `lww-override` provenance entry.                                                                                                                                        | covered | `e2e/full-stack/run-full-e2e.test.ts` case 13 |
|  14 | Same-file templates with different resolvers fall back to LWW (no consensus) — `lww-override`, no resolver runs.                                                                                                                                              | covered | `e2e/full-stack/run-full-e2e.test.ts` case 14 |
|  15 | Same resolver with different config falls back to LWW (ambiguous nomination) — `lww-override`, no resolver runs.                                                                                                                                              | covered | `e2e/full-stack/run-full-e2e.test.ts` case 15 |
|  16 | Same resolver and same config merge commutatively using the resolver (reversed order, byte-identical output).                                                                                                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 16 |
|  17 | Resolver subset plus no-resolver layers falls back to LWW across the whole variation set.                                                                                                                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 17 |
|  18 | Split resolver nominations fall back to LWW across every contributor (global consensus-or-LWW: no partial per-group merging).                                                                                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 18 |
|  19 | `try` works on template.                                                                                                                                                                                                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 19 |
|  20 | `try` works on templates with dependencies resolved on the fly.                                                                                                                                                                                               | covered | `e2e/full-stack/run-full-e2e.test.ts` case 20 |
|  21 | `test` works on processor with input and expected fixture.                                                                                                                                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 21 |
|  22 | Processor `validations` command runs expecting exit 0.                                                                                                                                                                                                        | covered | `e2e/full-stack/run-full-e2e.test.ts` case 22 |
|  23 | `test` works on plugin with input and expected fixture.                                                                                                                                                                                                       | covered | `e2e/full-stack/run-full-e2e.test.ts` case 23 |
|  24 | Plugin `validations` command runs expecting exit 0.                                                                                                                                                                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 24 |
|  25 | Resolver test accepts folders, resolver config, and expected fixture.                                                                                                                                                                                         | covered | `e2e/full-stack/run-full-e2e.test.ts` case 25 |
|  26 | `test` works on template with expected output directory.                                                                                                                                                                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 26 |
|  27 | Template `validations` command runs expecting exit 0.                                                                                                                                                                                                         | covered | `e2e/full-stack/run-full-e2e.test.ts` case 27 |
|  28 | `push` works on template.                                                                                                                                                                                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 28 |
|  29 | `push` works on template, bumping version.                                                                                                                                                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 29 |
|  30 | `push` works on plugin.                                                                                                                                                                                                                                       | covered | `e2e/full-stack/run-full-e2e.test.ts` case 30 |
|  31 | `push` works on plugin, bumping version.                                                                                                                                                                                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 31 |
|  32 | `push` works on processor.                                                                                                                                                                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 32 |
|  33 | `push` works on processor, bumping version.                                                                                                                                                                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 33 |
|  34 | `push` works on resolver.                                                                                                                                                                                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 34 |
|  35 | `push` works on resolver, bumping version.                                                                                                                                                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 35 |
|  36 | Three templates with upgraded resolver: full v2 tree compare (user edit intact), removals applied, updated provenance persisted, and a wholesale divergence leaving in-file conflict markers.                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 36 |
|  37 | Embedded dependency config seeds direct children (answers + deterministic state); deep influence reaches grandchildren via shared answer keys (D6 — no direct grandchild targeting).                                                                          | covered | `e2e/full-stack/run-full-e2e.test.ts` case 37 |
|  38 | Each template may appear only once in a composition; duplicates are rejected while shared processors/plugins/resolvers stay allowed.                                                                                                                          | covered | `e2e/full-stack/run-full-e2e.test.ts` case 38 |
|  39 | `trace` reports per-file provenance (`{provenance, tree, diffs}` in JSON), per-template isolated output, and contribution diffs — including the composition's single dependency-segment LWW override.                                                         | covered | `e2e/full-stack/run-full-e2e.test.ts` case 39 |

## Version bookkeeping the suite asserts

Hydrated registry manifests are versionless (the registry rejects `version:` at push), so
the CLI threads the registry-assigned version explicitly: `resolveTemplateInput` returns
it, `create` records it in `.cyan_state.yaml`, and `update` persists the resolved target
version on every move (entry version + a new history record). Case 5 asserts all three
ends: the created entry pins the old version, and both the pinned update and the unpinned
float land the new version with history length 2.

## Current Commands

```bash
pls e2e
```
