---
name: cyanprint-processor-authoring
description: Use when writing or editing this CyanPrint processor's transform logic.
---

# Authoring a CyanPrint processor

Search the registry before designing — `cyanprint search <term>` — reuse what exists, and name/describe this processor so others searching for the need can find it.

A processor turns a folder of files into a new folder of files. CyanPrint runs it locally in a temp directory — no Docker, no server.

A processor is **hermetic**: output is a pure function of (artifact version + integrity, config, input file set) — no network, clock, randomness, or machine state; anything random comes from the template via `config` (sourced from deterministic state). Each invocation sees only its declared `files:` scopes, never another processor's output, and outputs are cached content-addressed (`--bypass-cache` skips reads).

## Signature

Import the types you use from `@cyanprint/sdk` (type-only — the runtime injects the `fs` helper):

```ts
import type { ProcessorInput, ProcessorFsHelper } from '@cyanprint/sdk';

export async function processor(input: ProcessorInput, fs: ProcessorFsHelper) {
  const files = await fs.read(); // VfsFile[] from inputDir; CyanPrint metadata is ignored
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}
```

- `fs.read()` returns `{ path, content?, bytesBase64? }[]`. Text is `content`; binary is `bytesBase64` — pass binary through untouched.
- `fs.write(files)` persists the VFS to `outputDir` with the runtime's safe-path checks. Reuse the same relative paths.
- Escape hatch: `input.inputDir` / `input.outputDir` are real paths when you need raw filesystem access.

## How templates use this processor

A consuming template declares this processor in its `cyan.yaml` (the declaration is what gets downloaded, and it carries the version pin) and invokes it from `cyan.ts` with file scopes and per-use `config` — design both halves as your public API and show them verbatim in the README:

```yaml
# consumer's cyan.yaml
processors:
  - acme/uppercase@1
```

```ts
// consumer's cyan.ts return
processors: [
  {
    name: 'acme/uppercase',
    files: [{ root: 'template', glob: '**/*.md', type: 'Template' }],
    config: { locale: 'en-US' },
  },
],
```

`input.config` receives exactly that `config` object; the file scopes decide what lands in `fs.read()`. Reference config shape: the official `cyan/default` takes `vars` (the substitution map, rendered into contents AND paths) plus optional `parser.varSyntax` (the substitution tag pair) — option-like variability lives in config, while the files themselves arrive through the `files:` scopes.

## What makes a good processor

- **One transform**: a single, nameable mapping over the scoped files (render variables, format, code-mod, rewrite a manifest). Templates compose processors in declared order — small beats sprawling.
- **Validate `input.config` first** and fail with an error naming the offending key and the expected shape — a template author should never have to read your source to fix their config.
- **Leave what you don't transform untouched**: files outside your concern pass through byte-identical; binary (`bytesBase64`) is never mangled. (`cyan/default` models this: unknown placeholders are left as-is.)
- **Tolerate any scope**: templates choose the `files:` globs, so handle empty scopes and unexpected file kinds gracefully instead of crashing.
- **Errors name the file**: when a transform fails, say which path and why — the consumer debugs with your message, not your stack trace.

## Rules

- Hermetic: same input + `input.config` ⇒ same output.
- Folder-in / folder-out only; no global state.
- Add a fixture under `tests/` and keep `cyan.test.yaml` in sync (see the testing skill).
