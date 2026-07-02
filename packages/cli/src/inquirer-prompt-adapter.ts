import { checkbox, confirm, input, number, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  promptOptionValue,
  type Answers,
  type PromptAdapter,
  type PromptOption,
  type PromptRequest,
} from '@cyanprint/contracts';

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
  const message = promptMessage(request);
  if (request.kind === 'text') {
    return await prompts.input({
      message,
      default: request.default,
      validate: validate ? value => validate(value) : undefined,
    });
  }
  if (request.kind === 'confirm') {
    return await prompts.confirm({ message, default: request.default });
  }
  if (request.kind === 'select') {
    return await prompts.select({
      message,
      choices: request.options.map(option => promptChoice(option)),
      default: request.default,
    });
  }
  if (request.kind === 'multiselect') {
    return await prompts.checkbox({
      message,
      choices: request.options.map(option => ({
        ...promptChoice(option),
        checked: request.default?.includes(promptOptionValue(option)),
      })),
      validate: validate ? items => validate(items.map(item => item.value)) : undefined,
    });
  }
  return await prompts.number({
    message,
    default: request.default,
    required: true,
    validate: validate ? value => validate(value) : undefined,
  });
}

/**
 * The prompt line: the author's question, a dim placeholder example for free-form inputs
 * (inquirer has no native inline placeholder), and a dim description on its own line.
 * Select/multiselect option descriptions render natively below the list as the highlight moves.
 */
function promptMessage(request: PromptRequest): string {
  let message = request.message;
  if ((request.kind === 'text' || request.kind === 'number') && request.placeholder !== undefined) {
    message += ` ${chalk.dim(`e.g. ${request.placeholder}`)}`;
  }
  if (request.description) {
    message += `\n${chalk.dim(request.description)}\n`;
  }
  return message;
}

function promptChoice(option: PromptOption): { name: string; value: string; description?: string } {
  if (typeof option === 'string') {
    return { name: option, value: option };
  }
  return { name: option.label ?? option.value, value: option.value, description: option.description };
}
