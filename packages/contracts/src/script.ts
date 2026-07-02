import { CyanError, problem } from './errors';
import type { Answers, PromptAdapter, PromptOption, PromptRequest, PromptValidator } from './runtime';

export type CyanFileGlob = {
  glob?: string;
  base?: string;
  root?: string;
  exclude?: string[];
  mode?: 'template' | 'copy';
  type?: 'Template' | 'Copy' | 'template' | 'copy';
};

export type CyanPrompter = {
  text(
    name: string,
    message: string,
    options?: {
      default?: string;
      placeholder?: string;
      description?: string;
      validate?: (value: string) => boolean | string;
    },
  ): Promise<string>;
  confirm(name: string, message: string, options?: { default?: boolean; description?: string }): Promise<boolean>;
  select(
    name: string,
    message: string,
    options: {
      options: PromptOption[];
      default?: string;
      description?: string;
      validate?: (value: string) => boolean | string;
    },
  ): Promise<string>;
  multiselect(
    name: string,
    message: string,
    options: {
      options: PromptOption[];
      default?: string[];
      description?: string;
      validate?: (value: string[]) => boolean | string;
    },
  ): Promise<string[]>;
  number(
    name: string,
    message: string,
    options?: {
      default?: number;
      placeholder?: string;
      description?: string;
      validate?: (value: number) => boolean | string;
    },
  ): Promise<number>;
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
  // Interactive adapters honor request.validate by re-prompting; this wrapper is the
  // backstop that also validates reused/headless answers, failing the run loudly.
  const ask = async <T>(request: PromptRequest): Promise<T> => {
    const value = await adapter.ask<T>(request);
    assertValidAnswer(request, value);
    return value;
  };
  return {
    answers,
    runtime: {
      sessionPath: runtime.sessionPath ?? '',
    },
    prompt: {
      text: (name, message, options) =>
        ask<string>({
          kind: 'text',
          name,
          message,
          default: options?.default,
          placeholder: options?.placeholder,
          description: options?.description,
          validate: options?.validate as PromptValidator | undefined,
        }),
      confirm: (name, message, options) =>
        ask<boolean>({ kind: 'confirm', name, message, default: options?.default, description: options?.description }),
      select: (name, message, options) =>
        ask<string>({
          kind: 'select',
          name,
          message,
          options: options.options,
          default: options.default,
          description: options.description,
          validate: options.validate as PromptValidator | undefined,
        }),
      multiselect: (name, message, options) =>
        ask<string[]>({
          kind: 'multiselect',
          name,
          message,
          options: options.options,
          default: options.default,
          description: options.description,
          validate: options.validate as PromptValidator | undefined,
        }),
      number: (name, message, options) =>
        ask<number>({
          kind: 'number',
          name,
          message,
          default: options?.default,
          placeholder: options?.placeholder,
          description: options?.description,
          validate: options?.validate as PromptValidator | undefined,
        }),
    },
    deterministic: {
      get: key => deterministicState[key] as never,
      set: (key, value) => {
        deterministicState[key] = value;
      },
    },
  };
}

function assertValidAnswer(request: PromptRequest, value: unknown): void {
  if (!request.validate) {
    return;
  }
  const result = request.validate(value);
  if (result === true) {
    return;
  }
  throw new CyanError(
    problem(
      'validation',
      'invalid_answer',
      typeof result === 'string' ? result : `Invalid answer for ${request.name}: ${String(value)}`,
      { name: request.name },
    ),
  );
}
