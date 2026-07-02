import { checkbox, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  promptOptionValue,
  type Answers,
  type PromptAdapter,
  type PromptOption,
  type PromptRequest,
} from '@cyanprint/contracts';
import { describedConfirm, describedNumber, describedText } from './described-prompts';

export type InquirerPrompts = {
  checkbox: typeof checkbox;
  confirm: typeof describedConfirm;
  input: typeof describedText;
  number: typeof describedNumber;
  select: typeof select;
};

const defaultPrompts: InquirerPrompts = {
  checkbox,
  confirm: describedConfirm,
  input: describedText,
  number: describedNumber,
  select,
};

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
  // request.validate re-prompts inline (the prompts share the true-or-error-message contract).
  // Free-form prompts render `description` BELOW the input (like select/checkbox render option
  // help below the list) and `placeholder` as an inline ghost value.
  const validate = request.validate;
  if (request.kind === 'text') {
    return await prompts.input({
      message: request.message,
      default: request.default,
      placeholder: request.placeholder,
      description: request.description,
      validate: validate ? value => validate(value) : undefined,
    });
  }
  if (request.kind === 'confirm') {
    return await prompts.confirm({
      message: request.message,
      default: request.default,
      description: request.description,
    });
  }
  if (request.kind === 'select') {
    return await prompts.select({
      message: promptMessage(request),
      choices: request.options.map(option => promptChoice(option)),
      default: request.default,
    });
  }
  if (request.kind === 'multiselect') {
    return await prompts.checkbox({
      message: promptMessage(request),
      choices: request.options.map(option => ({
        ...promptChoice(option),
        checked: request.default?.includes(promptOptionValue(option)),
      })),
      validate: validate ? items => validate(items.map(item => item.value)) : undefined,
    });
  }
  return await prompts.number({
    message: request.message,
    default: request.default,
    placeholder: request.placeholder,
    description: request.description,
    validate: validate ? value => validate(value) : undefined,
  });
}

/**
 * List prompts reserve the bottom line for per-option descriptions, so a prompt-level
 * description renders as a dim line under the question instead.
 */
function promptMessage(request: PromptRequest): string {
  let message = request.message;
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
