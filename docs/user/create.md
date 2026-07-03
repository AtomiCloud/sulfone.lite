# Create

Run a local template:

```bash
cyanprint create examples/templates/hello app --headless --answers examples/templates/hello/answers.json
```

Create uses local execution only. Docker, coordinator daemons, and server-side execution are not used. The output path is the next argument; omit it to write into the current directory.

Interactive mode is the default:

```bash
cyanprint create examples/templates/hello app
```

Headless mode wraps the same core execution:

```bash
cyanprint create examples/templates/hello app --headless --answers answers.json
```

Templates stay folder-first. A `cyan.ts` script asks questions through `prompt`, then returns a plain Cyan object. Template files are referenced through processor/plugin `files` specs, for example `{ root: 'template', glob: '**/*', type: 'Template' }`, so the CLI loads archive files and runs artifacts.

## Composition

Composition is **static**: child templates are declared only in `cyan.yaml`'s `templates:` dictionary. Returning `templates` from `cyan.ts` is a hard error (`templates cannot be returned from cyan.ts; declare them in cyan.yaml`). Per-dependency config is embedded directly in the dictionary entry:

```yaml
templates:
  cyanprint/tri-a@5: {} # pinned to version 5, no config
  cyanprint/tri-b: # unpinned = latest at create; floats on update
    answers:
      flavor: batteries
    deterministicState:
      port: 4180
```

- **Embedded config, one configuring parent.** `answers` seed the child's answer bag before it generates, so they also reach the child's own descendants through normal answer sharing. `deterministicState` seeds shared deterministic state when the key is not already present. There is no separate presets block and no root-to-grandchild targeting — deep influence happens via shared answer keys only.
- **No `kind` field anywhere.** The `cyan.yaml` section (`templates:` / `processors:` / `plugins:` / `resolvers:`) implies the artifact kind; dependency entries are plain `owner/name[@version]` refs.
- **Children generate first.** Dependencies run deepest-first, so child answers always bubble up before the parent's `cyan.ts` runs. Answers and deterministic state are shared across the whole composition — a question answered by a deep dependency is reused by every ancestor.
- **Each template appears once.** A template (`owner/name`, version ignored) may appear only once in the whole composition; a second occurrence anywhere is an error. Processors, plugins, and resolvers may be shared freely.
- **Same-path files merge in three tiers.** When several layers emit the same path, each contributor nominates a resolver from its `resolvers:` list (first entry whose `files:` globs match). Unanimous nominations invoke that resolver once with all variations; otherwise the highest layer wins and an `lww-override` is recorded. See [the pipeline](pipeline.md) for the exact execution order and the determinism contract.

## Installing into an existing project (multi-install)

Running `cyanprint create <template> <dir>` into a directory that already has `.cyan_state.yaml` **upserts** the template into the project state — no separate command. The project then tracks N templates, each with its own answers, versions, and history. The new template's output is layered over the existing installation via tier-3 sibling resolution (ordered by installation time, most recent wins last-write-wins), then three-way merged with your local files through git — so your edits survive, and real conflicts surface as in-file `<<<<<<<` markers. Like [update](update.md), this path needs `git` on PATH. `cyanprint update <dir>` later floats all installed templates together.

## Progress

`create`, `try`, and `update` print each generation step live — the template being generated and every processor, plugin, resolver, and post-generation command as it starts (suppressed with `--json`).

## Prompts

Template authors can polish every prompt: a `description` renders as dim help text at the bottom of every prompt kind, a `placeholder` renders as a dim backdrop inside empty free-form inputs (typing replaces it; it is never submitted), a `default` is submitted on plain enter, and select/multiselect options may be objects (`{ value, label, description }`) whose description renders below the list and follows the highlighted option (with the prompt description stacked beneath it).

Re-running `create` over an existing project carries the recorded answers forward as each prompt's default — press enter to keep everything as-is, or answer to change it.

A `validate` function on `text`, `select`, `multiselect`, and `number` prompts (return `true` or an error message) guards answers: interactive runs re-prompt until the answer passes; headless answers that fail validation abort the run with the message.

## Trace

To see which template contributed each file — and the diff between a template's isolated output and the final merged result — run:

```bash
cyanprint trace examples/template-groups/basic --headless --answers examples/template-groups/basic/answers.json
```

`--json` prints the machine-readable report; generation happens in a throwaway temp directory.

Trace also accepts a **generated project** directory: it reuses the answers and deterministic state recorded in `.cyan_state.yaml` so the trace reflects exactly what produced the project. The template resolves from the recorded ref, or pass `--template` to override (e.g. for projects generated from a local path):

```bash
cyanprint trace my-project --headless
cyanprint trace my-project --template ./templates/my-template --headless
```
