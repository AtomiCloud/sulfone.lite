import { checkbox, confirm, input, number, select } from '@inquirer/prompts';
import type { Answers, PromptAdapter, PromptRequest } from '@cyanprint/contracts';

export type InquirerPrompts = {
  checkbox: typeof checkbox;
  confirm: typeof confirm;
  input: typeof input;
  number: typeof number;
  select: typeof select;
};

const defaultPrompts: InquirerPrompts = { checkbox, confirm, input, number, select };

export function inquirerPromptAdapter(answers: Answers, prompts: InquirerPrompts = defaultPrompts): PromptAdapter {
  return {
    async ask<T>(request: PromptRequest): Promise<T> {
      if (request.name in answers) {
        return answers[request.name] as T;
      }
      const value = await askPrompt(request, prompts);
      answers[request.name] = value;
      return value as T;
    },
  };
}

async function askPrompt(request: PromptRequest, prompts: InquirerPrompts): Promise<unknown> {
  // request.validate re-prompts inline (inquirer shares the true-or-error-message contract).
  const validate = request.validate;
  if (request.kind === 'text') {
    return await prompts.input({
      message: request.message,
      default: request.default,
      validate: validate ? value => validate(value) : undefined,
    });
  }
  if (request.kind === 'confirm') {
    return await prompts.confirm({ message: request.message, default: request.default });
  }
  if (request.kind === 'select') {
    return await prompts.select({
      message: request.message,
      choices: request.options.map(option => ({ name: option, value: option })),
      default: request.default,
    });
  }
  if (request.kind === 'multiselect') {
    return await prompts.checkbox({
      message: request.message,
      choices: request.options.map(option => ({
        name: option,
        value: option,
        checked: request.default?.includes(option),
      })),
      validate: validate ? items => validate(items.map(item => item.value)) : undefined,
    });
  }
  return await prompts.number({
    message: request.message,
    default: request.default,
    required: true,
    validate: validate ? value => validate(value) : undefined,
  });
}
