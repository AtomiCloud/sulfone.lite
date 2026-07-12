---
name: cyanprint-processor-authoring
description: Use when writing or editing this CyanPrint processor's transform logic. Covers every processor feature.
---

# Authoring a CyanPrint processor

**Search the registry before designing** — `cyanprint search <term> --kind processor` — and reuse an existing processor when one fits. Design for discoverability too: name, describe (`cyan.yaml` `description`), and document this processor so others searching for the need can find it.

A processor turns a folder of files into a new folder of files. CyanPrint runs it locally in a sandboxed temp directory — no Docker, no server, and no writes outside its output dir.

Where it runs in the pipeline: a **template** hands the processor a scoped slice of its archive (`files: [{ root, glob, type }]` on the template side). Each invocation sees ONLY its declared scopes — never a previous processor's output — and all processor outputs then merge into the template's own layer (tier-1 resolution) before plugins run. The official **default processor** (`cyan/default`, Eta-based variable substitution over contents _and_ paths) is the reference implementation — write a custom processor when templates need a transform beyond variable rendering (formatting, code-mods, manifest rewriting). This project was scaffolded by the meta template `cyan/new`; `cyanprint update . --template cyan/new` refreshes the scaffolding later.

## Hermeticity (the contract)

A processor is **hermetic**: its output is a pure function of (processor artifact version + integrity, config, input file set). No network, no clock, no randomness, no machine state. Anything random must be supplied by the template via `config`, sourced from deterministic state. Hermeticity is what makes `cyanprint update` reliable — its merge base is your old output re-created from recorded inputs.

Because outputs are hermetic they live in a **content-addressed cache** keyed on (artifact integrity, config, input files): repeated creates, template tests, and especially update's base regeneration become near-instant. `--bypass-cache` skips cache reads (it still writes).

## Signature

Import the types you use from `@cyanprint/sdk` (type-only, vendored — nothing to install; the runtime injects the `fs` helper):

```ts
import type { ProcessorInput, ProcessorFsHelper } from '@cyanprint/sdk';

export async function processor(input: ProcessorInput, fs: ProcessorFsHelper) {
  const files = await fs.read(); // VfsFile[] from inputDir; CyanPrint metadata is ignored
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}
```

Any valid export form loads (const arrow, function expression, re-export); the named function declaration is the convention. Declaring more than two parameters is rejected — the runtime only passes `(input, fs)`.

- `fs.read()` returns `{ path, content?, bytesBase64? }[]`. Text is `content`; binary is `bytesBase64` — pass binary through untouched (templates send binary via `type: 'Copy'` scopes).
- `fs.write(files)` persists the VFS to `outputDir` with the runtime's safe-path checks. Output paths must stay relative — absolute or `..` paths are rejected.
- `input.config` is the per-use config a template passes (`config: {...}` on the processor use). Validate it and document the contract in your README.
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

- **Hermetic**: same input file set + `input.config` ⇒ byte-identical output. `cyanprint update` re-executes old versions to build its merge base — nondeterminism creates phantom conflicts for every user of every template that depends on you.
- Folder-in / folder-out only; no network, no clock, no randomness, no global state.
- Add a fixture under `tests/` covering each meaningful config shape, and keep `cyan.test.yaml` in sync (see the testing skill).
