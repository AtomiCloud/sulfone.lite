---
name: typescript-quality
description: Set up and use TypeScript/Bun quality gates: bun:test with should assertions, loose two-pass Knip for agents, and conservative two-pass Knip for pre-commit.
invocation:
  - typescript-quality
  - bun-test
  - should
  - knip
  - dead-code
  - unused-code
---

# TypeScript/Bun Quality Gates

Reference: [docs/developer/standard/typescript-quality/](../../../docs/developer/standard/typescript-quality/)

## When To Use

Use this skill when setting up or reviewing TypeScript projects that use:

- Bun
- `bun:test`
- `should`
- Knip
- dead-code cleanup
- pre-commit quality gates

## Required Setup

Install the baseline dev dependencies:

```bash
bun add -D typescript @types/bun should @types/should knip
```

Use `bunfig.toml` to preload `should`:

```toml
[test]
preload = ["./test/setup.ts"]
coverageSkipTestFiles = true
```

Use `test/setup.ts`:

```typescript
import 'should';
```

The preload enables `.should` assertions. Import `should` directly in a test file
only when using function-form assertions like `should(value).be.null()`.

## Required Scripts

Use these package scripts unless the project has a stronger local convention:

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test test/unit",
    "test:integration": "bun test test/integration",
    "knip:agent": "bun scripts/knip-agent.ts",
    "knip:precommit": "bun scripts/knip-precommit.ts"
  }
}
```

Use helper scripts that run both Knip passes and return failure after both have
completed. Do not use `cmd1 && cmd2`, because that skips the production pass
when the default pass fails.

## Knip Rules For Agents

Always run the agent workflow twice through the script:

```bash
bun run knip:agent
```

This must perform:

1. default Knip analysis
2. production Knip analysis, where tests do not count as production usage

The agent config must be loose and noisy. It is the LLM's job to inspect each
finding and decide whether it is real.

Do **not** add agent false positives to `knip.json`, `ignore`, `ignoreFiles`,
`ignoreDependencies`, or any other suppression list. A finding that is false
today may become true later.

Only change Knip config for real project-boundary problems, such as missing
runtime entry points, generated output included as source, workspace boundaries,
or import aliases.

## Knip Rules For Pre-commit

Pre-commit must run the conservative script:

```bash
bun run knip:precommit
```

This must also run twice:

1. default mode
2. production mode

The pre-commit helper should include only `files` findings:

```bash
knip --config knip.precommit.json --include files
knip --config knip.precommit.json --production --include files
```

If this flags a file, treat it as real dead code unless the configured project
boundary is demonstrably wrong.

## Verification

After setup or changes, run:

```bash
bun test
bun run knip:agent
bun run knip:precommit
pre-commit run a-knip --all-files
```

If the repo does not have the `a-knip` hook yet, add it with the Nix skill and
the pattern in the reference standard.

## Related Skills

- [`/testing`](../testing/) - test structure and `should` assertion style
- [`/linting`](../linting/) - pre-commit hooks
- [`/nix`](../nix/) - adding Bun and pre-commit hooks through Nix
