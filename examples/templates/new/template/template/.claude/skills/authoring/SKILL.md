---
name: cyanprint-template-authoring
description: Use when writing or editing this CyanPrint template's cyan.ts and composition.
---

# Authoring a CyanPrint template

Search the registry before designing — `cyanprint search <term>` — reuse what exists, and name/describe this template so others searching for the need can find it.

A template asks prompts and returns a pure Cyan object describing which processors/plugins to run. Templates stay declarative — no file I/O in `cyan.ts`.

## Signature

```ts
export default async function cyan(prompt, ctx) {
  const project = await prompt.text('project', 'Project name');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { PROJECT: project } },
      },
    ],
  };
}
```

- Composition is static: declare child templates in `cyan.yaml`'s `templates:` dictionary (`owner/name[@version]` keys, optional embedded `answers`/`deterministicState`, no `kind`); returning templates from `cyan.ts` is a hard error. Children generate first, so their answers bubble up.
- Declare every processor/plugin dependency in `cyan.yaml`; returned data may only reference declared dependencies. Resolvers are `resolvers:` entries (`ref`, `config`, `files:` globs) — a same-path conflict merges through a resolver all contributors nominate, otherwise last-writer-wins.
- Keep prompts and the returned object pure — the CLI executes the artifacts locally.
- Template files live under `template/`; the default processor substitutes vars.

## Rules

- Deterministic given the same answers — `cyanprint update`'s git three-way merge regenerates old output from recorded answers.
- Cover answer combinations in `cyan.test.yaml` (see the testing skill).
