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
  // Every prompt kind renders `description` BELOW the input/list; free-form prompts also
  // render `placeholder` as an inline ghost value.
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
      message: request.message,
      choices: request.options.map(option => promptChoice(option, request.description)),
      default: request.default,
      theme: listDescriptionTheme,
    });
  }
  if (request.kind === 'multiselect') {
    return await prompts.checkbox({
      message: request.message,
      choices: request.options.map(option => ({
        ...promptChoice(option, request.description),
        checked: request.default?.includes(promptOptionValue(option)),
      })),
      validate: validate ? items => validate(items.map(item => item.value)) : undefined,
      theme: listDescriptionTheme,
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

// The bottom lines are pre-styled in promptChoice (option help cyan, prompt description
// dim), so the theme must not restyle them.
const listDescriptionTheme = { style: { description: (text: string) => text } };

/**
 * A list choice's bottom content: the option's own help (following the highlight) with the
 * prompt-level description stacked underneath — so the prompt description renders at the
 * bottom for every kind, matching the free-form prompts.
 */
function promptChoice(
  option: PromptOption,
  promptDescription: string | undefined,
): { name: string; value: string; description?: string } {
  const base =
    typeof option === 'string'
      ? { name: option, value: option, description: undefined as string | undefined }
      : { name: option.label ?? option.value, value: option.value, description: option.description };
  const lines: string[] = [];
  if (base.description) {
    lines.push(chalk.cyan(base.description));
  }
  if (promptDescription) {
    lines.push(chalk.dim(promptDescription));
  }
  return { name: base.name, value: base.value, description: lines.length > 0 ? lines.join('\n') : undefined };
}
