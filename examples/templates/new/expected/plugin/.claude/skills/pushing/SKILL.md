---
name: cyanprint-pushing
description: Use before publishing this artifact with cyanprint push.
---

# Pushing this artifact

Pre-push checklist:

1. `cyanprint bundle` — builds the runtime into the declared `bundledEntry`.
2. `cyanprint test` — every fixture passes and all validation commands exit 0.
3. `cyanprint push` — runs bundle + test by default, then uploads. The registry assigns the next integer version and pins dependency versions during finalize.

- Pass `--no-bundle` / `--no-test` only when you have already run them.
- Never hand-edit the published version; the registry owns it.
