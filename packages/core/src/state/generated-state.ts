import { join } from 'node:path';
import YAML from 'yaml';
import type { CyanManifest, GeneratedState, VfsFile } from '@cyanprint/contracts';
import { readText, sha256, writeText } from '../util';

export const STATE_FILE = '.cyan_state.yaml';

export function buildGeneratedState(args: {
  manifest: CyanManifest;
  source: string;
  answers: Record<string, unknown>;
  deterministicState: Record<string, unknown>;
  files: VfsFile[];
  artifacts?: Array<{ kind: string; owner: string; name: string; version?: string; integrity?: string }>;
  conflicts?: Array<{ path: string; reason: string }>;
}): GeneratedState {
  const artifacts =
    args.artifacts ??
    [...args.manifest.processors, ...args.manifest.plugins, ...args.manifest.resolvers, ...args.manifest.templates].map(
      ref => ({
        kind: ref.kind,
        owner: ref.owner ?? args.manifest.owner,
        name: ref.name,
        version: ref.version,
        integrity: undefined,
      }),
    );

  return {
    cyanprint: 4,
    template: {
      owner: args.manifest.owner,
      name: args.manifest.name,
      version: args.manifest.version ?? 'local',
      source: args.source,
    },
    answers: args.answers,
    deterministicState: args.deterministicState,
    files: args.files.map(file => ({
      path: file.path,
      sha256: sha256(file.bytesBase64 ? Buffer.from(file.bytesBase64, 'base64') : (file.content ?? '')),
      content: file.content,
      bytesBase64: file.bytesBase64,
    })),
    artifacts: artifacts.map(ref => ({
      kind: ref.kind,
      owner: ref.owner ?? args.manifest.owner,
      name: ref.name,
      version: ref.version ?? 'local',
      integrity:
        ref.integrity ??
        sha256(`${ref.kind}:${ref.owner ?? args.manifest.owner}:${ref.name}:${ref.version ?? 'local'}`),
    })),
    conflicts: args.conflicts ?? [],
  };
}

export async function writeGeneratedState(outDir: string, state: GeneratedState): Promise<void> {
  await writeText(join(outDir, STATE_FILE), YAML.stringify(state));
}

export async function loadGeneratedState(projectDir: string): Promise<GeneratedState> {
  return YAML.parse(await readText(join(projectDir, STATE_FILE))) as GeneratedState;
}
