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
- Declare every processor/plugin dependency in `cyan.yaml`; returned data may only reference declared dependencies (`undeclared_artifact` otherwise). `cyan.yaml` is the install manifest — running a template downloads only declared dependencies before `cyan.ts` executes, so anything the returned Cyan object can reference (including answer-dependent branches) must be declared or its invocation fails. Resolvers are `resolvers:` entries (`ref`, `config`, `files:` globs) — a same-path conflict merges through a resolver all contributors nominate, otherwise last-writer-wins.
- `cyan.yaml` is also the pin record; the runtime resolves returned uses against it: unpinned return inherits the declared pin; pinned return + pinned declaration must match exactly; pinned return + unpinned declaration fails (the declaration leads); both unpinned is fine while authoring — `cyanprint push` pins the declaration (version + integrity) and runtime matches against that.
- Keep prompts and the returned object pure — the CLI executes the artifacts locally.
- Template files live under `template/`; the default processor substitutes vars.
- The return may also declare `features: ['tests', 'ci', ...]` — each name is a promise about the generated repo, scoped to this template; prove every declared feature with probes (see the probing skill). Alter the template ⇒ update tests AND probes in the same change.
- Resolvers act at layering time only — update's three-way merge of user edits happens after resolution, so user-editability is irrelevant to attaching one. Don't attach resolvers reflexively (asserted LWW is fine), but for common files many templates touch (`package.json`, `.gitignore`, nix files, `CLAUDE.md`, `README.md`) you SHOULD search the registry and attach an existing resolver.

## Hermeticity

`answers` + deterministic state are a complete replay tape — `cyanprint update` regenerates old output from them, so the template must be hermetic. Pin every value that can differ between runs (randomness, time, network/CLI queries) with `await ctx.deterministic.load(key, produce)` BEFORE it influences control flow, prompt options, or output. First run executes the producer once and persists to `.cyan_state.yaml`; replay returns the pinned value and never re-executes:

```ts
const port = await ctx.deterministic.load('port', () => 3000 + Math.floor(Math.random() * 1000));
// External data feeding a prompt — pin first, then ask; replay never hits the network:
const repoList = await ctx.deterministic.load('repoList', () => listOrgRepos('AtomiCloud'));
const repo = await prompt.select('repo', 'Which repo?', { options: repoList });
```

Producers may be async; never branch on a raw nondeterministic value — pin it, then branch.

## Rules

- Hermetic given the same answers + deterministic state — `cyanprint update`'s git three-way merge regenerates old output from recorded state; pin external values via `ctx.deterministic.load`.
- Cover answer combinations in `cyan.test.yaml` (see the testing skill).
