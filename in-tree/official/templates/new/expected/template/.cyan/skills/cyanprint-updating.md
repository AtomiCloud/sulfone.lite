# CyanPrint Updating Skill

Use this when changing behavior, fixtures, prompts, dependencies, or generated output.

## Update Checklist

1. Read `cyan.yaml` and identify the artifact kind.
2. Read `README.md` and the relevant `.cyan/skills/*` files before editing behavior.
3. Update source and fixture files together. Do not change behavior without a test fixture that shows the new output.
4. Run `bun run build` when `cyan.ts` or `src/index.ts` imports packages or when `bundledEntry` points into `dist/`.
5. Run `bun run test` or the equivalent `cyanprint test .` command.
6. Update README examples and dependency notes if the public behavior changed.

## Template Updates

For templates, update all three layers together:

- `cyan.ts` prompt and returned pure Cyan object
- files under `template/`
- expected output fixtures under `expected/`

Use snapshot updates only when the output change is intentional:

```bash
bun run build
cyanprint test . --answers answers.json --update-snapshots
```

Then inspect the changed expected files manually. A snapshot update is not a substitute for review.

## Processor and Plugin Updates

- Add or update `tests/<case>/input` and `tests/<case>/expected`.
- Use `config` in `cyan.test.yaml` for behavior that depends on options.
- Include command validations for behavior that is easier to assert with code, such as JSON parseability, package installability, or exact formatting.

## Resolver Updates

- Include fixtures that represent actual conflict shapes.
- Keep resolver config small and serializable.
- Verify expired assumptions: if a resolver used to receive two files, add a test for three or more files if multiple templates can now converge on the path.
