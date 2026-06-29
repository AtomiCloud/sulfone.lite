import type { Answers, PromptAdapter } from './runtime';

export type CyanFileGlob = {
  glob?: string;
  base?: string;
  root?: string;
  exclude?: string[];
  mode?: 'template' | 'copy';
  type?: 'Template' | 'Copy' | 'template' | 'copy';
};

export type CyanPrompter = {
  text(name: string, message: string, options?: { default?: string }): Promise<string>;
  confirm(name: string, message: string, options?: { default?: boolean }): Promise<boolean>;
  select(name: string, message: string, options: { options: string[]; default?: string }): Promise<string>;
  multiselect(name: string, message: string, options: { options: string[]; default?: string[] }): Promise<string[]>;
  number(name: string, message: string, options?: { default?: number }): Promise<number>;
};

export type CyanPromptContext = {
  answers: Answers;
  runtime: {
    sessionPath: string;
  };
  prompt: CyanPrompter;
  deterministic: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
};

export type CyanArtifactUse = {
  kind?: 'processor' | 'plugin' | 'resolver' | 'template';
  owner?: string;
  name: string;
  version?: string;
  config?: unknown;
  files?: CyanFileGlob[];
};

export type CyanCommandIntent = {
  command: string;
  args?: string[];
  allow?: boolean;
};

export type CyanOutput = {
  processors?: CyanArtifactUse[];
  plugins?: CyanArtifactUse[];
  resolvers?: CyanArtifactUse[];
  templates?: CyanArtifactUse[];
  commands?: CyanCommandIntent[];
};

export type CyanScript = (prompt: CyanPrompter, ctx: CyanPromptContext) => Promise<CyanOutput> | CyanOutput;

export function makePromptContext(
  adapter: PromptAdapter,
  answers: Answers,
  deterministicState: Record<string, unknown>,
  runtime: { sessionPath?: string } = {},
): CyanPromptContext {
  return {
    answers,
    runtime: {
      sessionPath: runtime.sessionPath ?? '',
    },
    prompt: {
      text: (name, message, options) => adapter.ask<string>({ kind: 'text', name, message, default: options?.default }),
      confirm: (name, message, options) =>
        adapter.ask<boolean>({ kind: 'confirm', name, message, default: options?.default }),
      select: (name, message, options) =>
        adapter.ask<string>({ kind: 'select', name, message, options: options.options, default: options.default }),
      multiselect: (name, message, options) =>
        adapter.ask<string[]>({
          kind: 'multiselect',
          name,
          message,
          options: options.options,
          default: options.default,
        }),
      number: (name, message, options) =>
        adapter.ask<number>({ kind: 'number', name, message, default: options?.default }),
    },
    deterministic: {
      get: key => deterministicState[key] as never,
      set: (key, value) => {
        deterministicState[key] = value;
      },
    },
  };
}
