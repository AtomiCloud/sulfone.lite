---
name: cyanprint-pushing
description: Use before publishing this artifact with cyanprint push.
---

# Pushing this artifact

Pre-push checklist:

1. Check `cyan.yaml`'s name and description (and the README) — they are what `cyanprint search` matches, so describe the need this artifact serves.
2. `cyanprint bundle` — builds the runtime into the declared `bundledEntry`.
3. `cyanprint test` — every fixture passes and all validation commands exit 0.
4. `cyanprint push` — runs bundle + test by default, then uploads. The CLI resolves dependency pins against the registry before upload, and the registry validates them and assigns the next integer version.

- Pass `--no-bundle` / `--no-test` only when you have already run them.
- Never hand-edit the published version; the registry owns it.
