---
name: cyanprint-processor-authoring
description: Use when writing or editing this CyanPrint processor's transform logic.
---

# Authoring a CyanPrint processor

A processor turns a folder of files into a new folder of files. CyanPrint runs it locally in a temp directory — no Docker, no server.

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

## Rules

- Deterministic: same input + `input.config` ⇒ same output.
- Folder-in / folder-out only; no global state.
- Add a fixture under `tests/` and keep `cyan.test.yaml` in sync (see the testing skill).
