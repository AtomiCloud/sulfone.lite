import { z } from 'zod';

export const PromptKindSchema = z.enum(['text', 'confirm', 'select', 'multiselect', 'number']);
export type PromptKind = z.infer<typeof PromptKindSchema>;

/**
 * Optional per-prompt validation. Return `true` to accept, or an error message (or `false`)
 * to reject. Interactive adapters re-prompt on rejection; headless answers fail the run.
 */
export type PromptValidator = (value: unknown) => boolean | string;

export type PromptRequest =
  | { kind: 'text'; name: string; message: string; default?: string; validate?: PromptValidator }
  | { kind: 'confirm'; name: string; message: string; default?: boolean; validate?: PromptValidator }
  | { kind: 'select'; name: string; message: string; options: string[]; default?: string; validate?: PromptValidator }
  | {
      kind: 'multiselect';
      name: string;
      message: string;
      options: string[];
      default?: string[];
      validate?: PromptValidator;
    }
  | { kind: 'number'; name: string; message: string; default?: number; validate?: PromptValidator };

export type Answers = Record<string, unknown>;

export type PromptAdapter = {
  ask<T>(request: PromptRequest): Promise<T>;
};

export type VfsFile = {
  path: string;
  content?: string;
  bytesBase64?: string;
  mode?: number;
};

/**
 * CyanPrint-managed metadata that lives alongside generated files but is never part of
 * an artifact's VFS. Reads (including SDK helper reads) must ignore these paths.
 */
export const CYAN_METADATA_PATHS = {
  stateFile: '.cyan_state.yaml',
  conflictsPrefix: '.cyan_conflicts/',
} as const;

export function isCyanMetadataPath(relativePath: string): boolean {
  const normalized = relativePath.split(/[\\/]+/).join('/');
  return normalized === CYAN_METADATA_PATHS.stateFile || normalized.startsWith(CYAN_METADATA_PATHS.conflictsPrefix);
}

export type GeneratedState = {
  cyanprint: 4;
  template: {
    owner: string;
    name: string;
    version: string;
    source: string;
  };
  answers: Answers;
  deterministicState: Record<string, unknown>;
  files: Array<{ path: string; sha256: string; content?: string; bytesBase64?: string }>;
  artifacts: Array<{ kind: string; owner: string; name: string; version: string; integrity: string }>;
  conflicts?: Array<{ path: string; reason: string }>;
};
