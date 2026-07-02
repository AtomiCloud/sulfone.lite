import { createProject } from '@cyanprint/core';
import type { PromptAdapter } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString, readAnswersFile } from '../args';
import { defaultRegistryUrl } from '../registry-defaults';
import { resolveTemplateInput } from '../registry-template';
import { info, kv, pathLabel, printJson, printSection, progressLine, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
  silent?: boolean;
};

export async function createCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const template = positional[0];
  if (!template) {
    throw new Error('create requires a template path or registry reference');
  }
  const answersPath = flagString(flags, 'answers');
  const answers = answersPath ? await readAnswersFile(answersPath) : {};
  const outDir = flagString(flags, 'out') ?? positional[1] ?? '.';
  const json = flagBool(flags, 'json');
  const headless = flagBool(flags, 'headless');
  const effectiveHeadless = headless || json;
  const promptAdapter = runtime.promptAdapterFactory?.(answers) ?? runtime.promptAdapter;
  if (!json && !runtime.silent) {
    console.log(info(`creating ${pathLabel(outDir)} from ${pathLabel(template)}`));
  }
  const resolvedTemplate = await resolveTemplateInput({
    template,
    registry: flagString(flags, 'registry') ?? defaultRegistryUrl(),
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
    trusted: flagBool(flags, 'trust'),
    trustFixture: flagString(flags, 'trust-fixture'),
    trustDir: flagString(flags, 'trust-dir'),
  });
  const result = await createProject({
    template: resolvedTemplate.templateDir,
    outDir,
    answers,
    headless: effectiveHeadless,
    json,
    localFallback: !resolvedTemplate.registryHydrated,
    promptAdapter: effectiveHeadless ? undefined : promptAdapter,
    onProgress: json || runtime.silent ? undefined : event => console.log(progressLine(event)),
  });
  if (json) {
    printJson({ ...result, cacheHydrated: resolvedTemplate.cacheHydrated });
  } else if (!runtime.silent) {
    console.log(success(`created ${pathLabel(result.outputPath)}`));
    printSection('Summary', [
      kv('files', result.files.length),
      kv('cache hydrated', resolvedTemplate.cacheHydrated),
      kv('local execution', !result.remoteExecution),
    ]);
  }
}
