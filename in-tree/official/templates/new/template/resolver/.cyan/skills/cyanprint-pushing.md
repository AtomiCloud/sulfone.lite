# CyanPrint Pushing Skill

Use this before publishing to a registry.

## Pre-Push Checklist

- `cyan.yaml` has the right `kind`, `owner`, `name`, `entry`, and `bundledEntry`.
- All dependencies are declared as friendly refs under the correct section.
- `README.md` explains behavior, config, tests, and compatibility.
- `bun run build` succeeds and writes the bundled entry.
- `bun run test` succeeds.
- No generated secrets, local cache files, or temporary output are included in the artifact folder.

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
