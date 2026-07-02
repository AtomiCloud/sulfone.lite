---
name: cyanprint-processor-authoring
description: Use when writing or editing this CyanPrint processor's transform logic. Covers every processor feature.
---

# Authoring a CyanPrint processor

A processor turns a folder of files into a new folder of files. CyanPrint runs it locally in a sandboxed temp directory — no Docker, no server, and no writes outside its output dir.

Where it runs in the pipeline: a **template** hands the processor a scoped slice of its archive (`files: [{ root, glob, type }]` on the template side), the processor transforms that slice, and the results merge into the template's own layer before plugins run. The official **default processor** (`cyan/default`, Eta-based variable substitution over contents _and_ paths) is the reference implementation — write a custom processor when templates need a transform beyond variable rendering (formatting, code-mods, manifest rewriting). This project was scaffolded by the meta template `cyan/new`; `cyanprint update . --template cyan/new` refreshes the scaffolding later.

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

## Rules

- **Deterministic**: same input + `input.config` ⇒ byte-identical output. Downstream `cyanprint update` does a three-way merge of generated output — nondeterminism creates phantom conflicts for every user of every template that depends on you.
- Folder-in / folder-out only; no network, no global state.
- Document any files a user is expected to edit afterwards, so templates can attach resolvers to those paths.
- Add a fixture under `tests/` and keep `cyan.test.yaml` in sync (see the testing skill).
