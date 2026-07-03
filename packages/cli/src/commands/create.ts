import { join } from 'node:path';
import { createProject, loadGeneratedState, mergedStateAnswers } from '@cyanprint/core';
import type { Answers, PromptAdapter } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString, readAnswersFile } from '../args';
import { defaultRegistryUrl } from '../registry-defaults';
import { registryTemplateSourceResolver, resolveTemplateInput } from '../registry-template';
import { failure, info, kv, pathLabel, printJson, printSection, progressLine, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>, suggestions?: Record<string, unknown>) => PromptAdapter;
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
  // Re-running a template over an existing project: the recorded answers carry over as
  // suggestions — free-form prompts prefill them, lists/confirm default to them.
  const priorAnswers = effectiveHeadless ? undefined : await readPriorAnswers(outDir);
  const promptAdapter = runtime.promptAdapterFactory?.(answers, priorAnswers) ?? runtime.promptAdapter;
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
    // Recorded so update can float this template later: the registry ref (unpinned) or
    // the local template path, plus the registry-assigned version (hydrated manifests
    // are versionless) so update's base regeneration can pin the old version.
    templateSource: resolvedTemplate.registryHydrated ? (template.split('@')[0] ?? template) : undefined,
    templateVersion: resolvedTemplate.version,
    resolveTemplateSource: registryTemplateSourceResolver(flags),
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
  });
  if (json) {
    printJson({ ...result, cacheHydrated: resolvedTemplate.cacheHydrated });
    if (result.status === 'conflict') {
      process.exitCode = 1;
    }
  } else if (!runtime.silent) {
    if (result.status === 'conflict') {
      console.error(failure(`created with conflicts in ${pathLabel(result.outputPath)}`));
      for (const path of result.conflicts) {
        console.error(`- ${path} (in-file conflict markers)`);
      }
      process.exitCode = 1;
    } else {
      console.log(success(`created ${pathLabel(result.outputPath)}`));
    }
    printSection('Summary', [
      kv('files', result.files.length),
      kv('cache hydrated', resolvedTemplate.cacheHydrated),
      kv('local execution', !result.remoteExecution),
    ]);
  }
}

async function readPriorAnswers(outDir: string): Promise<Answers | undefined> {
  if (!(await Bun.file(join(outDir, '.cyan_state.yaml')).exists())) {
    return undefined;
  }
  const state = await loadGeneratedState(outDir).catch(() => undefined);
  return state ? mergedStateAnswers(state) : undefined;
}
