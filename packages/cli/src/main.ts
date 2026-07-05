#!/usr/bin/env bun
import type { PromptAdapter } from '@cyanprint/contracts';
import { PROBE_RUNNER_SUBCOMMAND, runProbeRunner } from '@cyanprint/core';
import { Command, CommanderError } from 'commander';
import { bundleCommand } from './commands/bundle';
import { cacheCommand } from './commands/cache';
import { createCommand } from './commands/create';
import { probeCommand } from './commands/probe';
import { pushCommand } from './commands/push';
import { searchCommand } from './commands/search';
import { testCommand } from './commands/test';
import { traceCommand } from './commands/trace';
import { tryCommand } from './commands/try';
import { trustCommand } from './commands/trust';
import { updateCommand } from './commands/update';
import { inquirerPromptAdapter } from './inquirer-prompt-adapter';
import { RELEASE_REGISTRY_URL } from './registry-defaults';
import { brand, failure, ReportedCliError } from './ui';
import { VERSION } from './version';

type OptionValues = Record<string, string | boolean | undefined>;

type ProgramRuntime = {
  jsonErrors?: boolean;
  promptAdapterFactory?: (answers: Record<string, unknown>, suggestions?: Record<string, unknown>) => PromptAdapter;
  silent?: boolean;
};

type CliOptionSpec = {
  flag: string;
  value?: string;
  description: string;
  defaultValue?: string;
  required?: boolean;
};

export function createProgram(runtime: ProgramRuntime = {}): Command {
  const promptAdapterFactory =
    runtime.promptAdapterFactory ??
    ((answers: Record<string, unknown>, suggestions?: Record<string, unknown>) =>
      inquirerPromptAdapter(answers, undefined, suggestions));
  const program = new Command();
  program
    .name('cyanprint')
    .description('CyanPrint v4 local-first template runtime')
    .version(`cyanprint ${VERSION}`, '-v, --version', 'print the CyanPrint version')
    .exitOverride()
    .configureOutput({
      outputError: message => {
        if (!runtime.jsonErrors) {
          console.error(failure(message.trimEnd()));
        }
      },
    })
    .addHelpText('beforeAll', `${brand()}\nFast Bun-native templates, resolvers, processors, and plugins.\n`)
    .addHelpText(
      'afterAll',
      `
Examples:
  cyanprint create cyanprint/nextjs-app --out ./app
  cyanprint create ./examples/templates/hello --out ./app --headless --answers answers.json
  cyanprint search nextjs --kind template
  cyanprint test ./examples/templates/hello
  cyanprint probe ./app --probes ./my-template --features features.json
  cyanprint push ./in-tree/official/processors/default --dry-run
`,
    );
  if (!runtime.jsonErrors) {
    program.showHelpAfterError();
  }

  withOptions(
    program
      .command('create')
      .argument('<template>', 'template path or registry reference')
      .argument('[out]', 'output directory; defaults to the current directory')
      .description('create a project from a template'),
    CREATE_OPTIONS,
  ).action(async (template: string, out: string | undefined, options: OptionValues) => {
    await createCommand([template, ...(out ? [out] : []), ...optionArgv(options, CREATE_OPTIONS)], {
      promptAdapterFactory,
      silent: runtime.silent,
    });
  });

  withOptions(
    program
      .command('try')
      .argument('<template>', 'template path or registry reference')
      .argument('[out]', 'optional output directory; defaults to a temp scratch folder')
      .description('try a template locally'),
    TRY_OPTIONS,
  ).action(async (template: string, out: string | undefined, options: OptionValues) => {
    await tryCommand([template, ...(out ? [out] : []), ...optionArgv(options, TRY_OPTIONS)], {
      promptAdapterFactory,
    });
  });

  withOptions(
    program
      .command('update')
      .argument('<project>', 'project directory to update')
      .description('float every active template to latest (git three-way merge with local edits)'),
    UPDATE_OPTIONS,
  ).action(async (project: string, options: OptionValues) => {
    await updateCommand([project, ...optionArgv(options, UPDATE_OPTIONS)], {
      promptAdapterFactory,
    });
  });

  withOptions(
    program
      .command('test')
      .argument('<target>', 'template, processor, plugin, or resolver directory')
      .description('run standard artifact tests and expected output fixtures'),
    TEST_OPTIONS,
  ).action(async (target: string, options: OptionValues) => {
    await testCommand([target, ...optionArgv(options, TEST_OPTIONS)]);
  });

  withOptions(
    program
      .command('probe')
      .argument('[repo]', 'materialized project directory to probe')
      .description('prove template feature promises against a materialized repo (probe matrix)'),
    PROBE_OPTIONS,
  ).action(async (repo: string | undefined, options: OptionValues) => {
    await probeCommand([...(repo ? [repo] : []), ...optionArgv(options, PROBE_OPTIONS)]);
  });

  withOptions(
    program
      .command('trace')
      .argument('<target>', 'template path, registry reference, or generated project directory')
      .description('trace which template/dependency contributed each file (provenance + diffs)'),
    TRACE_OPTIONS,
  ).action(async (target: string, options: OptionValues) => {
    await traceCommand([target, ...optionArgv(options, TRACE_OPTIONS)], { promptAdapterFactory });
  });

  withOptions(
    program
      .command('bundle')
      .argument('<artifact>', 'processor, plugin, or resolver directory')
      .description('bundle an artifact runtime into its declared bundledEntry')
      .option('--no-install', 'skip installing dependencies before bundling'),
    BUNDLE_OPTIONS,
  ).action(async (artifact: string, options: OptionValues) => {
    await bundleCommand([
      artifact,
      ...optionArgv(options, BUNDLE_OPTIONS),
      ...(options.install === false ? ['--no-install'] : []),
    ]);
  });

  withOptions(
    program
      .command('push')
      .argument('<artifact>', 'artifact directory')
      .description('test, bundle, and publish an artifact')
      .option('--no-bundle', 'skip bundling before publish')
      .option('--no-test', 'skip tests before publish'),
    PUSH_OPTIONS,
  ).action(async (artifact: string, options: OptionValues) => {
    await pushCommand([
      artifact,
      ...optionArgv(options, PUSH_OPTIONS),
      ...(options.bundle === false ? ['--no-bundle'] : []),
      ...(options.test === false ? ['--no-test'] : []),
    ]);
  });

  withOptions(
    program
      .command('search')
      .argument('[query]', 'artifact name, owner/name, or README text')
      .description('search templates, template groups, processors, plugins, and resolvers'),
    SEARCH_OPTIONS,
  ).action(async (query: string | undefined, options: OptionValues) => {
    await searchCommand([...(query ? [query] : []), ...optionArgv(options, SEARCH_OPTIONS)]);
  });

  withOptions(
    program
      .command('cache')
      .argument('[action]', 'inspect or clean', 'inspect')
      .description('inspect or clean the local artifact cache'),
    CACHE_OPTIONS,
  ).action(async (action: string, options: OptionValues) => {
    await cacheCommand([action, ...optionArgv(options, CACHE_OPTIONS)]);
  });

  withOptions(
    program
      .command('trust')
      .argument('[action]', 'inspect or approve', 'inspect')
      .argument('[scope]', 'organization, template, or version trust scope')
      .argument('[ref]', 'artifact reference to approve')
      .description('inspect or approve trusted artifacts'),
    TRUST_OPTIONS,
  ).action(async (action: string, scope: string | undefined, ref: string | undefined, options: OptionValues) => {
    await trustCommand([
      action,
      ...[scope, ref].filter((value): value is string => Boolean(value)),
      ...optionArgv(options, TRUST_OPTIONS),
    ]);
  });

  program
    .command('version')
    .description('print the CyanPrint version')
    .action(() => {
      console.log(`cyanprint ${VERSION}`);
    });

  return program;
}

export async function main(argv: string[] = Bun.argv.slice(2), runtime: ProgramRuntime = {}): Promise<void> {
  // Hidden re-entry point for the isolated probe runner. A compiled single-file
  // binary cannot spawn an embedded runner `.ts` path directly, so the probe
  // executor re-invokes THIS binary with the subcommand + JSON payload. Dispatch
  // it here, before commander — which would otherwise reject the unknown command
  // — and exit with the runner's own outcome exit code (see probe-process.ts).
  if (argv[0] === PROBE_RUNNER_SUBCOMMAND) {
    process.exit(await runProbeRunner(argv[1]));
  }
  const jsonErrors = runtime.jsonErrors ?? hasJsonFlag(argv);
  try {
    await createProgram({ ...runtime, jsonErrors }).parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    if (error instanceof CommanderError && !jsonErrors) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof ReportedCliError && !jsonErrors) {
      process.exitCode = 1;
      return;
    }
    printCliError(error, jsonErrors);
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  }
}

function withOptions(command: Command, specs: CliOptionSpec[]): Command {
  for (const spec of specs) {
    const declaration = `--${spec.flag}${spec.value ? ` ${spec.value}` : ''}`;
    if (spec.required) {
      command.requiredOption(declaration, spec.description, spec.defaultValue);
    } else {
      command.option(declaration, spec.description, spec.defaultValue);
    }
  }
  return command;
}

function optionArgv(options: OptionValues, specs: CliOptionSpec[]): string[] {
  const argv: string[] = [];
  for (const spec of specs) {
    const value = options[optionKey(spec.flag)];
    if (value === true) {
      argv.push(`--${spec.flag}`);
    } else if (typeof value === 'string') {
      // `=` form survives the re-parse even when the value is empty or starts with `--`.
      argv.push(`--${spec.flag}=${value}`);
    }
  }
  return argv;
}

function optionKey(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function hasJsonFlag(argv: string[]): boolean {
  return argv.includes('--json');
}

function printCliError(error: unknown, json: boolean): void {
  const problem =
    error && typeof error === 'object' && 'problem' in error ? (error as { problem: unknown }).problem : undefined;
  const message =
    problem && typeof problem === 'object' && 'message' in problem
      ? String(problem.message)
      : error instanceof Error
        ? error.message
        : String(error);
  if (json) {
    console.error(
      JSON.stringify(
        {
          status: 'error',
          problem: problem ?? (error instanceof CommanderError ? { code: error.code, message } : { message }),
        },
        null,
        2,
      ),
    );
  } else {
    console.error(failure(message));
  }
}

const CREATE_OPTIONS: CliOptionSpec[] = [
  { flag: 'out', value: '<dir>', description: 'output directory; overrides positional out' },
  { flag: 'answers', value: '<file>', description: 'JSON answers file for headless or prefilled runs' },
  { flag: 'headless', description: 'disable prompts and require supplied/default answers' },
  { flag: 'json', description: 'print machine-readable JSON' },
  { flag: 'registry', value: '<url>', description: 'registry base URL' },
  { flag: 'cache-dir', value: '<dir>', description: 'cache directory' },
  { flag: 'bypass-cache', description: 'download fresh registry artifacts' },
  { flag: 'trust', description: 'trust the resolved template for this run' },
  { flag: 'trust-fixture', value: '<name>', description: 'local trust fixture name' },
  { flag: 'trust-dir', value: '<dir>', description: 'trust store directory' },
];

const TRY_OPTIONS: CliOptionSpec[] = [
  { flag: 'out', value: '<dir>', description: 'output directory; defaults to a temp scratch folder' },
  ...CREATE_OPTIONS.slice(1),
];

// Same as create, minus --out (trace generates into a throwaway temp dir and reports),
// plus --template to override the recorded template when tracing a generated project.
const TRACE_OPTIONS: CliOptionSpec[] = [
  ...CREATE_OPTIONS.slice(1),
  { flag: 'template', value: '<template>', description: 'template override when tracing a generated project' },
];

const UPDATE_OPTIONS: CliOptionSpec[] = [
  {
    flag: 'template',
    value: '<template>',
    description: 'only update the installed template matching this owner/name[@version]',
  },
  { flag: 'interactive', description: 'pick the version per template' },
  { flag: 'answers', value: '<file>', description: 'JSON answers file for headless or prefilled runs' },
  { flag: 'headless', description: 'disable prompts and require supplied/default answers' },
  { flag: 'json', description: 'print machine-readable JSON' },
  { flag: 'registry', value: '<url>', description: 'registry base URL' },
  { flag: 'cache-dir', value: '<dir>', description: 'cache directory' },
  { flag: 'bypass-cache', description: 'download fresh registry artifacts' },
  { flag: 'trust', description: 'trust the resolved template for this run' },
  { flag: 'trust-fixture', value: '<name>', description: 'local trust fixture name' },
  { flag: 'trust-dir', value: '<dir>', description: 'trust store directory' },
];

const TEST_OPTIONS: CliOptionSpec[] = [
  { flag: 'answers', value: '<file>', description: 'JSON answers file for template tests' },
  { flag: 'out', value: '<dir>', description: 'template test output directory' },
  { flag: 'snapshot', value: '<file>', description: 'legacy snapshot file for template output' },
  { flag: 'update-snapshots', description: 'rewrite expected output fixtures' },
  { flag: 'tests', value: '<dir>', description: 'artifact-specific tests directory' },
  { flag: 'parallel', value: '<n>', description: 'run up to N test cases concurrently' },
  { flag: 'report', value: '<file>', description: 'write JSON report to a file' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const PROBE_OPTIONS: CliOptionSpec[] = [
  { flag: 'probes', value: '<dir>', description: 'explicit probe source: a template dir or its probes/ folder' },
  { flag: 'features', value: '<file>', description: 'JSON feature set for explicit-source runs' },
  { flag: 'template', value: '<dir>', description: 'template dir for declaration-mode runs and --update-manifest' },
  { flag: 'feature', value: '<names>', description: 'select features to run (comma-separated; name or template#name)' },
  { flag: 'probe', value: '<names>', description: 'select probes to run (a mutation pulls in its feature baseline)' },
  { flag: 'keep-sandbox', description: 'retain run sandboxes and the snapshot for debugging' },
  { flag: 'parallel', value: '<n>', description: 'run up to N matrix runs concurrently' },
  { flag: 'timeout', value: '<seconds>', description: 'default per-probe timeout in seconds' },
  { flag: 'update-manifest', description: 'generate/regenerate the committed probes.yaml (requires --template)' },
  { flag: 'report', value: '<file>', description: 'write JSON report to a file' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const PUSH_OPTIONS: CliOptionSpec[] = [
  { flag: 'registry', value: '<url>', description: 'registry base URL' },
  { flag: 'dry-run', description: 'validate without publishing' },
  { flag: 'script-only', description: 'publish a script-only template' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const BUNDLE_OPTIONS: CliOptionSpec[] = [
  { flag: 'dry-run', description: 'bundle to a temp directory without writing bundledEntry' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const SEARCH_OPTIONS: CliOptionSpec[] = [
  // No commander defaultValue: searchCommand falls back to defaultRegistryUrl(), which honors
  // CYANPRINT_REGISTRY_URL/CYANPRINT_REGISTRY like every other command.
  { flag: 'registry', value: '<url>', description: `registry base URL (default: ${RELEASE_REGISTRY_URL})` },
  { flag: 'kind', value: '<kind>', description: 'template, template-group, processor, plugin, or resolver' },
  { flag: 'query', value: '<text>', description: 'query text; overrides empty positional query' },
  { flag: 'limit', value: '<number>', description: 'maximum results', defaultValue: '20' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const CACHE_OPTIONS: CliOptionSpec[] = [
  { flag: 'cache-dir', value: '<dir>', description: 'cache directory' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

const TRUST_OPTIONS: CliOptionSpec[] = [
  { flag: 'scope', value: '<scope>', description: 'organization, template, or version trust scope' },
  { flag: 'ref', value: '<ref>', description: 'artifact reference to approve' },
  { flag: 'kind', value: '<kind>', description: 'artifact kind', defaultValue: 'template' },
  { flag: 'trust-dir', value: '<dir>', description: 'trust store directory' },
  { flag: 'owner', value: '<owner>', description: 'artifact owner' },
  { flag: 'name', value: '<name>', description: 'artifact name' },
  { flag: 'version', value: '<version>', description: 'registry-assigned integer version' },
  { flag: 'integrity', value: '<sha>', description: 'artifact integrity' },
  { flag: 'pins-fingerprint', value: '<hash>', description: 'dependency pins fingerprint' },
  { flag: 'json', description: 'print machine-readable JSON' },
];

if (import.meta.main) {
  await main();
}
