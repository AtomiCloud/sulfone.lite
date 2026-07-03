import { updateProject, type UpdateTargetResolver } from '@cyanprint/core';
import type { InstalledTemplate, PromptAdapter } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString, readAnswersFile } from '../args';
import { defaultRegistryUrl } from '../registry-defaults';
import { registryTemplateSourceResolver, resolveTemplateInput } from '../registry-template';
import { failure, info, pathLabel, printJson, printSection, progressLine, ReportedCliError, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
};

/**
 * `cyanprint update <dir>` — every active template floats to latest.
 * `--interactive` prompts for the version per template; `--template <ref>` targets one.
 */
export async function updateCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const projectDir = positional[0];
  if (!projectDir) {
    throw new Error('update requires <project>');
  }
  const templateFilter = flagString(flags, 'template');
  const interactive = flagBool(flags, 'interactive');
  const answersPath = flagString(flags, 'answers');
  const answers = answersPath ? await readAnswersFile(answersPath) : {};
  const json = flagBool(flags, 'json');
  const headless = (flagBool(flags, 'headless') || json) && !interactive;
  const promptAdapter = runtime.promptAdapterFactory?.(answers) ?? runtime.promptAdapter;
  if (!json) {
    console.log(info(`updating ${pathLabel(projectDir)}${templateFilter ? ` (template ${templateFilter})` : ''}`));
  }

  const resolveSource = registryTemplateSourceResolver(flags);
  const resolveUpdateTarget: UpdateTargetResolver = async entry => {
    let requestedVersion: string | undefined = parsePinnedVersion(templateFilter);
    if (interactive && !requestedVersion && promptAdapter) {
      const picked = await promptAdapter.ask<string>({
        kind: 'text',
        name: `version:${entry.owner}/${entry.name}`,
        message: `Version for ${entry.owner}/${entry.name} (current ${entry.version})`,
        default: 'latest',
      });
      requestedVersion = picked && picked !== 'latest' ? picked : undefined;
    }
    const resolved = await resolveUpdateSource(entry, requestedVersion, flags, resolveSource);
    return { templateDir: resolved.templateDir, version: requestedVersion ?? resolved.version ?? entry.version };
  };

  const result = await updateProject({
    projectDir,
    template: templateFilter,
    answers: Object.keys(answers).length > 0 ? answers : undefined,
    headless,
    json,
    promptAdapter: headless ? undefined : promptAdapter,
    onProgress: json ? undefined : event => console.log(progressLine(event)),
    resolveTemplateSource: resolveSource,
    resolveUpdateTarget,
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
  });

  if (json) {
    printJson(result);
    if (result.status !== 'done') {
      process.exitCode = 1;
    }
  } else {
    if (result.status === 'conflict') {
      console.error(failure(`update conflicted ${projectDir}`));
      for (const path of result.conflicts) {
        console.error(`- ${path} (in-file conflict markers)`);
      }
      throw new ReportedCliError(`update conflicted ${projectDir}`);
    }
    console.log(success(`updated ${pathLabel(projectDir)}`));
    printSection('Summary', [
      `updated templates: ${result.updated.map(entry => `${entry.ref} ${entry.from} -> ${entry.to}`).join(', ') || 'none'}`,
      `reused answers: ${result.reusedAnswers.length}`,
      `conflicts: ${result.conflicts.length}`,
    ]);
  }
}

function parsePinnedVersion(templateFilter?: string): string | undefined {
  if (!templateFilter || !templateFilter.includes('@')) {
    return undefined;
  }
  return templateFilter.split('@')[1];
}

async function resolveUpdateSource(
  entry: InstalledTemplate,
  requestedVersion: string | undefined,
  flags: Record<string, string | boolean>,
  resolveSource: (args: { source: string; version?: string }) => Promise<string>,
): Promise<{ templateDir: string; version?: string }> {
  if (requestedVersion) {
    return { templateDir: await resolveSource({ source: entry.source, version: requestedVersion }) };
  }
  // Latest: resolve the unpinned source ref (local paths just pass through). The
  // registry-assigned version comes back so the float can be persisted to state.
  const resolved = await resolveTemplateInput({
    template: entry.source,
    registry: flagString(flags, 'registry') ?? defaultRegistryUrl(),
    cacheDir: flagString(flags, 'cache-dir'),
    bypassCache: flagBool(flags, 'bypass-cache'),
    trusted: flagBool(flags, 'trust'),
    trustFixture: flagString(flags, 'trust-fixture'),
    trustDir: flagString(flags, 'trust-dir'),
  });
  return { templateDir: resolved.templateDir, version: resolved.version };
}
