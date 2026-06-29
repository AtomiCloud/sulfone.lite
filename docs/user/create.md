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
