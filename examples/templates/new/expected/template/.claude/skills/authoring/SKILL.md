---
name: cyanprint-template-authoring
description: Use when writing or editing this CyanPrint template's cyan.ts and composition.
---

# Authoring a CyanPrint template

A template asks prompts and returns a pure Cyan object describing which processors/plugins/resolvers to run. Templates stay declarative — no file I/O in `cyan.ts`.

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

- Declare every processor/plugin/resolver dependency in `cyan.yaml`; returned data may only reference declared dependencies.
- Keep prompts and the returned object pure — the CLI executes the artifacts locally.
- Template files live under `template/`; the default processor substitutes vars.

## Rules

- Deterministic given the same answers.
- Cover answer combinations in `cyan.test.yaml` (see the testing skill).
