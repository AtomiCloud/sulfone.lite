import { traceProject, type TraceNode } from '@cyanprint/core';
import type { PromptAdapter } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString, readAnswersFile } from '../args';
import { defaultRegistryUrl } from '../registry-defaults';
import { resolveTemplateInput } from '../registry-template';
import { kv, pathLabel, printJson, printSection, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
  silent?: boolean;
};

export async function traceCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const template = positional[0];
  if (!template) {
    throw new Error('trace requires a template path or registry reference');
  }
  const answersPath = flagString(flags, 'answers');
  const answers = answersPath ? await readAnswersFile(answersPath) : {};
  const json = flagBool(flags, 'json');
  const headless = flagBool(flags, 'headless') || json;
  const promptAdapter = runtime.promptAdapterFactory?.(answers) ?? runtime.promptAdapter;

  const resolved = await resolveTemplateInput({
    template,
    registry: flagString(flags, 'registry') ?? defaultRegistryUrl(),
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
    trusted: flagBool(flags, 'trust'),
    trustFixture: flagString(flags, 'trust-fixture'),
    trustDir: flagString(flags, 'trust-dir'),
  });

  const trace = await traceProject({
    template: resolved.templateDir,
    answers,
    headless,
    localFallback: !resolved.registryHydrated,
    promptAdapter: headless ? undefined : promptAdapter,
  });

  if (json) {
    printJson(trace);
    return;
  }

  console.log(success(`traced ${pathLabel(template)}`));
  printSection(
    'Provenance (winning source per file)',
    trace.provenance.map(entry => kv(entry.path, `${entry.source} [${entry.decision}]`)),
  );

  const templateRows: string[] = [];
  const walk = (node: TraceNode, indent: string): void => {
    templateRows.push(`${indent}${node.ref}  (${node.ownFiles.length} file(s))`);
    for (const own of node.ownFiles) {
      templateRows.push(`${indent}  - ${own.path}`);
    }
    for (const child of node.children) {
      walk(child, `${indent}  `);
    }
  };
  walk(trace.tree, '');
  printSection('Per-template output', templateRows);

  if (trace.diffs.length > 0) {
    console.log('\nDiffs (contribution vs final):');
    for (const entry of trace.diffs) {
      console.log(`\n-- ${entry.template} · ${entry.path} --`);
      console.log(entry.diff);
    }
  }
}
