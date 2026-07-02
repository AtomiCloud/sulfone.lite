# CyanPrint v4 E2E Coverage Matrix

Every requested parity case runs as a REAL named test in
`e2e/full-stack/run-full-e2e.test.ts` — the CLI executes against an in-process local
registry with committed fixture folders (`e2e/full-stack/fixtures/`) and expected-output
folder compares (`e2e/full-stack/expected/`, refresh with `E2E_UPDATE_EXPECTED=1`).
Run them with `bun run e2e:full`.

|   # | Required case                                                                                                                             | Status  | Owning coverage                               |
| --: | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
|   1 | Template works.                                                                                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 1  |
|   2 | Template works with all input types.                                                                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 2  |
|   3 | Two templates can be installed.                                                                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 3  |
|   4 | Template installs its own dependencies.                                                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 4  |
|   5 | Templates update normally.                                                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 5  |
|   6 | Templates update with a three-way merge.                                                                                                  | covered | `e2e/full-stack/run-full-e2e.test.ts` case 6  |
|   7 | Templates update with conflict.                                                                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 7  |
|   8 | Templates update when the new version deletes files.                                                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 8  |
|   9 | Multiple templates update with three-way merge after same-layer merge.                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 9  |
|  10 | Templates pass forced answers or deterministic state to dependencies.                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 10 |
|  11 | Multiple processor output merges, later output overriding newer.                                                                          | covered | `e2e/full-stack/run-full-e2e.test.ts` case 11 |
|  12 | Same as #11, but matching resolver uses resolver instead of overriding.                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 12 |
|  13 | Same-file templates without resolver record conflict state with LWW reason `no_resolver`.                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 13 |
|  14 | Same-file templates with different resolvers record LWW reason `different_resolver`.                                                      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 14 |
|  15 | Same resolver with different config records LWW reason `same_resolver_different_config`.                                                  | covered | `e2e/full-stack/run-full-e2e.test.ts` case 15 |
|  16 | Same resolver and same config merge commutatively using resolver.                                                                         | covered | `e2e/full-stack/run-full-e2e.test.ts` case 16 |
|  17 | Resolver subset plus no-resolver layers falls back to LWW.                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 17 |
|  18 | Different resolver groups fall back to LWW.                                                                                               | covered | `e2e/full-stack/run-full-e2e.test.ts` case 18 |
|  19 | `try` works on template.                                                                                                                  | covered | `e2e/full-stack/run-full-e2e.test.ts` case 19 |
|  20 | `try` works on templates with dependencies resolved on the fly.                                                                           | covered | `e2e/full-stack/run-full-e2e.test.ts` case 20 |
|  21 | `test` works on processor with input and expected fixture.                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 21 |
|  22 | Processor `validations` command runs expecting exit 0.                                                                                    | covered | `e2e/full-stack/run-full-e2e.test.ts` case 22 |
|  23 | `test` works on plugin with input and expected fixture.                                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 23 |
|  24 | Plugin `validations` command runs expecting exit 0.                                                                                       | covered | `e2e/full-stack/run-full-e2e.test.ts` case 24 |
|  25 | Resolver test accepts folders, resolver config, and expected fixture.                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 25 |
|  26 | `test` works on template with expected output directory.                                                                                  | covered | `e2e/full-stack/run-full-e2e.test.ts` case 26 |
|  27 | Template `validations` command runs expecting exit 0.                                                                                     | covered | `e2e/full-stack/run-full-e2e.test.ts` case 27 |
|  28 | `push` works on template.                                                                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 28 |
|  29 | `push` works on template, bumping version.                                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 29 |
|  30 | `push` works on plugin.                                                                                                                   | covered | `e2e/full-stack/run-full-e2e.test.ts` case 30 |
|  31 | `push` works on plugin, bumping version.                                                                                                  | covered | `e2e/full-stack/run-full-e2e.test.ts` case 31 |
|  32 | `push` works on processor.                                                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 32 |
|  33 | `push` works on processor, bumping version.                                                                                               | covered | `e2e/full-stack/run-full-e2e.test.ts` case 33 |
|  34 | `push` works on resolver.                                                                                                                 | covered | `e2e/full-stack/run-full-e2e.test.ts` case 34 |
|  35 | `push` works on resolver, bumping version.                                                                                                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 35 |
|  36 | Three templates with dependencies and upgraded resolver merge previous VFS, updated VFS, removals, conflicts, and clean three-way output. | covered | `e2e/full-stack/run-full-e2e.test.ts` case 36 |
|  37 | Parent presets cascade answers and deterministic state to all descendant templates; the outermost ancestor wins conflicts.                | covered | `e2e/full-stack/run-full-e2e.test.ts` case 37 |
|  38 | Each template may appear only once in a composition; duplicates are rejected while shared processors/plugins/resolvers stay allowed.      | covered | `e2e/full-stack/run-full-e2e.test.ts` case 38 |
|  39 | `trace` reports per-file provenance, per-template isolated output, and contribution diffs in human and JSON views.                        | covered | `e2e/full-stack/run-full-e2e.test.ts` case 39 |

## Current Commands

```bash
pls e2e
```
