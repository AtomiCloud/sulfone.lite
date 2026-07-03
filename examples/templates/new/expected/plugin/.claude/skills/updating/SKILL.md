---
name: cyanprint-updating
description: Use to keep this artifact current without fighting upstream-managed files.
---

# Updating this artifact

- Run `cyanprint update <project>` to float the project to the latest upstream output — CI workflows, the CI script, these skills, and the vendored `@cyanprint/sdk` types (`--interactive` to pick versions; `--template <ref>` to target one template). Let update own those files; do not hand-edit them, or you will create update conflicts.
- You own: `src/`, `cyan.yaml` metadata, your `package.json` dependencies, and your tests. Bump those yourself (e.g. `bun update`), then re-run `cyanprint test`.
- After any change, run `cyanprint test` — every case must pass and validations must exit 0.
- Update is a git three-way merge; if files conflict, resolve the in-file `<<<<<<<` markers and re-test.
