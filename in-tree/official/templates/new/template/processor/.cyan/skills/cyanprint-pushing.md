# CyanPrint Pushing Skill

Use this before publishing to a registry.

## Pre-Push Checklist

- `cyan.yaml` has the right `kind`, `owner`, `name`, `entry`, and `bundledEntry`.
- All dependencies are declared as friendly refs under the correct section.
- `README.md` explains behavior, config, tests, merge policy, and compatibility.
- `bun run build` succeeds and writes the bundled entry.
- `bun run test` succeeds.
- No generated secrets, local cache files, or temporary output are included in the artifact folder.
- Processor and plugin output is deterministic for the same input and config.
- Resolver fixtures prove commutativity or clearly document ordered behavior.
- Template fixtures cover dependency answers, processor selection, common-file overlap, and resolver behavior.
- Plugin fixtures prove idempotency for finalizers such as pre-commit config and Git initialization.

## Publish

Use an API token minted from the CyanPrint web portal:

```bash
CYANPRINT_TOKEN='<token>' bun run push
```

The registry assigns the next integer version. Do not hand-edit registry-assigned versions. If dependency versions are omitted in `cyan.yaml`, push resolves and pins them during publish.

## Dry Run

Before publishing a new artifact shape, run:

```bash
cyanprint push . --dry-run
```

Dry run validates the manifest, bundle, dependencies, object model, and archive rules without committing a version.

## Final Review

Before the real push, inspect the diff against the previous version:

- For templates, confirm every new common path has a resolver decision.
- For processors, confirm generated output does not depend on clock, random, host, or network state.
- For plugins, confirm repeated execution is stable.
- For resolvers, confirm same resolver plus same config can safely merge all intended candidates.
