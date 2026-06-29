# CyanPrint Updating Skill

Use this when changing behavior, fixtures, prompts, dependencies, generated output, or merge behavior.

## Update Checklist

1. Read `cyan.yaml` and identify the artifact kind.
2. Read `README.md` and the relevant `.cyan/skills/*` files before editing behavior.
3. Update source and fixture files together. Do not change behavior without a test fixture that shows the new output.
4. Run `bun run build` when `cyan.ts` or `src/index.ts` imports packages or when `bundledEntry` points into `dist/`.
5. Run `bun run test` or the equivalent `cyanprint test .` command.
6. Update README examples and dependency notes if the public behavior changed.
7. Check whether the change creates new overlap on common files such as README, ignore files, Nix, package manifests, CI, or agent docs. Add resolvers when overlap is intentional.
8. Keep test assertions in the standard order: generate output, compare `expected` byte for byte, then run every command in `validations`.

## Template Updates

For templates, update all three layers together:

- `cyan.ts` prompt and returned pure Cyan object
- files under `template/`
- expected output fixtures under `expected/`

Before changing generated files, decide the processor and resolver plan:

- Which files are rendered with `Template` and which are copied with `Copy`?
- Which processor handles Markdown, JSON, YAML, Nix, TypeScript, package manifests, or generated code?
- Which files are likely to overlap with dependency templates?
- Does each overlapping file have a declared resolver with stable config?
- Are dependency answers deterministic and covered by a fixture?

Use snapshot updates only when the output change is intentional:

```bash
bun run build
cyanprint test . --answers answers.json --update-snapshots
```

Then inspect the changed expected files manually. A snapshot update is not a substitute for review.

## Processor Updates

- Add or update `tests/<case>/input` and `tests/<case>/expected`.
- Include at least one fixture that proves deterministic input to output behavior.
- Run the same processor test twice or inspect that no fixture changes after a second run.
- Use `config` in `cyan.test.yaml` for behavior that depends on options.
- Put command checks under `validations`. Each entry is either a shell command string or `{ command, args }`; it must exit 0.
- Include command validations for behavior that is easier to assert with code, such as JSON parseability, package installability, exact formatting, or generated lockfile absence.
- Do not add behavior that depends on time, random values, host paths, network access, or environment variables unless those values are explicit config inputs.

## Plugin Updates

- Treat plugins as deterministic finalizers.
- Add a fixture proving the plugin is idempotent. Running it twice should not duplicate hooks, ignore lines, package scripts, pre-commit config, or Git metadata.
- For `pre-commit run --all-files`, include config generation plus a `validations` command. Do not silently require global tools.
- For Git initialization, create missing files only and avoid overwriting remotes, user identity, branches, or existing history.
- Keep shell execution optional, explicit, and documented. Prefer modifying the Cyan file map.

## Resolver Updates

- Include fixtures that represent actual conflict shapes.
- Keep resolver config small, serializable, and stable.
- Verify expired assumptions: if a resolver used to receive two files, add a test for three or more files if multiple templates can now converge on the path.
- Prove commutativity when the resolver is intended to be order-independent by adding reversed-order fixtures.
- Prove idempotency by including duplicate or identical candidates.
- If order matters, document the metadata field used for ordering and add a fixture that proves the order policy.
- For text resolver cases, validation commands inspect `output.txt`. For folder/fold cases, commands inspect the generated output tree.
