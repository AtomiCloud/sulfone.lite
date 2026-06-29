import { updateProject } from '@cyanprint/core';
import type { PromptAdapter } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString } from '../args';
import { resolveTemplateInput } from '../registry-template';
import { failure, info, pathLabel, printJson, printSection, ReportedCliError, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
};

export async function updateCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const projectDir = positional[0];
  const template = flagString(flags, 'template');
  if (!projectDir || !template) {
    throw new Error('update requires <project> --template <template>');
  }
  const answersPath = flagString(flags, 'answers');
  const answers = answersPath ? (JSON.parse(await Bun.file(answersPath).text()) as Record<string, unknown>) : {};
  const json = flagBool(flags, 'json');
  const headless = flagBool(flags, 'headless');
  const effectiveHeadless = headless || json;
  const promptAdapter = runtime.promptAdapterFactory?.(answers) ?? runtime.promptAdapter;
  if (!json) {
    console.log(info(`updating ${pathLabel(projectDir)} with ${pathLabel(template)}`));
  }
  const resolvedTemplate = await resolveTemplateInput({
    template,
    registry: flagString(flags, 'registry'),
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
    trusted: flagBool(flags, 'trust'),
    trustFixture: flagString(flags, 'trust-fixture'),
    trustDir: flagString(flags, 'trust-dir'),
  });
  const result = await updateProject({
    projectDir,
    template: resolvedTemplate.templateDir,
    answers: Object.keys(answers).length > 0 ? answers : undefined,
    headless: effectiveHeadless,
    localFallback: !resolvedTemplate.registryHydrated,
    promptAdapter: effectiveHeadless ? undefined : promptAdapter,
  });
  if (json) {
    printJson(result);
    if (result.status !== 'done') {
      process.exitCode = 1;
    }
  } else {
    if (result.status === 'conflict') {
      console.error(failure(`update conflicted ${projectDir}`));
      for (const conflict of result.conflicts) {
        console.error(`- ${conflict.path}: ${conflict.reason}`);
      }
      throw new ReportedCliError(`update conflicted ${projectDir}`);
    }
    if (result.status === 'need_input') {
      console.error(failure(`update needs input: ${result.prompt.message}`));
      throw new ReportedCliError(`update needs input: ${result.prompt.name}`);
    }
    console.log(success(`updated ${pathLabel(projectDir)}`));
    printSection('Summary', [
      `reused answers: ${result.reusedAnswers.length}`,
      `conflicts: ${result.conflicts.length}`,
    ]);
  }
}
