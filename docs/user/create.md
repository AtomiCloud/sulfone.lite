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

Templates compose child templates (declared in `cyan.yaml` `templates:` or returned from `cyan.ts`). Answers and deterministic state are shared across the whole composition — a question answered by a deep dependency is reused by every ancestor.

- **Presets cascade.** A parent's `presets.templates` can preset answers and deterministic state for any descendant, transitively. When ancestors disagree, the outermost (root) template wins.
- **Each template appears once.** A template (`owner/name`, version ignored) may appear only once in the whole composition; a second occurrence anywhere is an error. Processors, plugins, and resolvers may be shared freely.
- **Same-path files merge.** When two templates emit the same path, a resolver both sides declare merges them; otherwise the later layer wins and a conflict is recorded.

## Trace

To see which template contributed each file — and the diff between a template's isolated output and the final merged result — run:

```bash
cyanprint trace examples/template-groups/basic --headless --answers examples/template-groups/basic/answers.json
```

`--json` prints the machine-readable report; generation happens in a throwaway temp directory.
