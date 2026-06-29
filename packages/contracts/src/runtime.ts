import { z } from 'zod';

export const PromptKindSchema = z.enum(['text', 'confirm', 'select', 'multiselect', 'number']);
export type PromptKind = z.infer<typeof PromptKindSchema>;

export type PromptRequest =
  | { kind: 'text'; name: string; message: string; default?: string }
  | { kind: 'confirm'; name: string; message: string; default?: boolean }
  | { kind: 'select'; name: string; message: string; options: string[]; default?: string }
  | { kind: 'multiselect'; name: string; message: string; options: string[]; default?: string[] }
  | { kind: 'number'; name: string; message: string; default?: number };

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

export type MachineEnvelope<T> = {
  status: 'done' | 'need_input' | 'conflict' | 'error';
  data?: T;
  prompt?: PromptRequest;
  problems?: Array<{ category: string; code: string; message: string; details?: Record<string, unknown> }>;
};
