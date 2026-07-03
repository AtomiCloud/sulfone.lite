import { join } from 'node:path';
import YAML from 'yaml';
import type {
  Answers,
  GeneratedState,
  InstalledTemplate,
  Provenance,
  TemplateHistoryEntry,
  VfsFile,
} from '@cyanprint/contracts';
import { assertRootSafeWrite, fileSha, readText, writeText } from '../util';

export const STATE_FILE = '.cyan_state.yaml';

export function buildGeneratedState(args: {
  templates: InstalledTemplate[];
  files: VfsFile[];
  provenance: Provenance[];
}): GeneratedState {
  return {
    cyanprint: 4,
    templates: args.templates,
    files: args.files.map(file => ({ path: file.path, sha256: fileSha(file) })),
    provenance: args.provenance,
  };
}

export async function writeGeneratedState(outDir: string, state: GeneratedState): Promise<void> {
  // `writeText` follows an existing `.cyan_state.yaml` symlink or hard link, so a planted link
  // would push CyanPrint state outside the project root — the same escape class the managed-file
  // writer guards. Refuse either before persisting so state stays inside root.
  await assertRootSafeWrite(outDir, STATE_FILE);
  await writeText(join(outDir, STATE_FILE), YAML.stringify(state));
}

export async function loadGeneratedState(projectDir: string): Promise<GeneratedState> {
  const parsed = YAML.parse(await readText(join(projectDir, STATE_FILE))) as unknown;
  return migrateGeneratedState(parsed);
}

export async function hasGeneratedState(projectDir: string): Promise<boolean> {
  return await Bun.file(join(projectDir, STATE_FILE)).exists();
}

export function activeTemplates(state: GeneratedState): InstalledTemplate[] {
  return state.templates.filter(template => template.active);
}

/** The latest history entry — the current install of the template. */
export function currentHistoryEntry(template: InstalledTemplate): TemplateHistoryEntry {
  const entry = template.history[template.history.length - 1];
  if (!entry) {
    throw new Error(`Installed template ${template.owner}/${template.name} has no history`);
  }
  return entry;
}

/** Union of every active template's current answers (later installs win). */
export function mergedStateAnswers(state: GeneratedState): Answers {
  const answers: Answers = {};
  for (const template of activeTemplates(state)) {
    Object.assign(answers, currentHistoryEntry(template).answers);
  }
  return answers;
}

/** Union of every active template's current deterministic state (first install wins per key). */
export function mergedDeterministicState(state: GeneratedState): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const template of activeTemplates(state)) {
    for (const [key, value] of Object.entries(currentHistoryEntry(template).deterministicState)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Upsert a template into the project state (iridium parity): an existing entry keeps its
 * installedAt slot and gains a history entry; a new template is appended.
 */
export function upsertInstalledTemplate(
  templates: InstalledTemplate[],
  entry: {
    owner: string;
    name: string;
    version: string;
    source: string;
    time: string;
    answers: Answers;
    deterministicState: Record<string, unknown>;
    artifacts: InstalledTemplate['artifacts'];
  },
): InstalledTemplate[] {
  const historyEntry: TemplateHistoryEntry = {
    version: entry.version,
    time: entry.time,
    answers: entry.answers,
    deterministicState: entry.deterministicState,
  };
  const existing = templates.find(template => template.owner === entry.owner && template.name === entry.name);
  if (existing) {
    return templates.map(template =>
      template === existing
        ? {
            ...template,
            version: entry.version,
            source: entry.source,
            active: true,
            history: [...template.history, historyEntry],
            artifacts: entry.artifacts,
          }
        : template,
    );
  }
  return [
    ...templates,
    {
      owner: entry.owner,
      name: entry.name,
      version: entry.version,
      source: entry.source,
      active: true,
      installedAt: entry.time,
      history: [historyEntry],
      artifacts: entry.artifacts,
    },
  ];
}

type LegacyGeneratedState = {
  cyanprint: 4;
  template: { owner: string; name: string; version: string; source: string };
  answers: Answers;
  deterministicState: Record<string, unknown>;
  files: Array<{ path: string; sha256: string; content?: string; bytesBase64?: string }>;
  artifacts: InstalledTemplate['artifacts'];
};

/** Accept single-template state files written before multi-install and lift them in place. */
export function migrateGeneratedState(parsed: unknown): GeneratedState {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('.cyan_state.yaml is not a valid state file');
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.templates)) {
    return parsed as GeneratedState;
  }
  const legacy = parsed as LegacyGeneratedState;
  const time = new Date(0).toISOString();
  return {
    cyanprint: 4,
    templates: [
      {
        owner: legacy.template.owner,
        name: legacy.template.name,
        version: legacy.template.version,
        source: legacy.template.source,
        active: true,
        installedAt: time,
        history: [
          {
            version: legacy.template.version,
            time,
            answers: legacy.answers ?? {},
            deterministicState: legacy.deterministicState ?? {},
          },
        ],
        artifacts: legacy.artifacts ?? [],
      },
    ],
    files: (legacy.files ?? []).map(file => ({ path: file.path, sha256: file.sha256 })),
    provenance: [],
  };
}
