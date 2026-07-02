// Free-form prompts (text, number, confirm) built on @inquirer/core so the prompt
// description renders BELOW the input line — consistent with select/checkbox, whose
// option help renders below the list. Also gives text/number a real inline ghost
// placeholder, which @inquirer/prompts input does not support.

import { createPrompt, isBackspaceKey, isEnterKey, useKeypress, usePrefix, useState } from '@inquirer/core';
import chalk from 'chalk';

export type DescribedTextConfig = {
  message: string;
  default?: string;
  placeholder?: string;
  description?: string;
  validate?: (value: string) => boolean | string;
};

export type DescribedNumberConfig = {
  message: string;
  default?: number;
  placeholder?: string;
  description?: string;
  validate?: (value: number) => boolean | string;
};

export type DescribedConfirmConfig = {
  message: string;
  default?: boolean;
  description?: string;
};

// Portable signature for the exported prompts (avoids leaking @inquirer/type paths).
type DescribedPrompt<Value, Config> = (config: Config) => Promise<Value>;

function bottomContent(description: string | undefined, error: string | undefined, active: boolean): string {
  const lines: string[] = [];
  if (description && active) {
    lines.push(chalk.dim(description));
  }
  if (error) {
    lines.push(chalk.red(error));
  }
  return lines.join('\n');
}

export const describedText: DescribedPrompt<string, DescribedTextConfig> = createPrompt<string, DescribedTextConfig>(
  (config, done) => {
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | undefined>(undefined);
    const prefix = usePrefix({ status });

    useKeypress((key, rl) => {
      if (status !== 'idle') {
        return;
      }
      if (isEnterKey(key)) {
        const answer = value || config.default || '';
        const result = config.validate ? config.validate(answer) : true;
        if (result === true) {
          setValue(answer);
          setStatus('done');
          done(answer);
        } else {
          rl.write(value);
          setError(typeof result === 'string' ? result : 'Invalid answer.');
        }
        return;
      }
      setValue(rl.line);
      setError(undefined);
    });

    const message = chalk.bold(config.message);
    const hint = config.default !== undefined && status === 'idle' && !value ? chalk.dim(` (${config.default})`) : '';
    const ghost = !value && status === 'idle' && config.placeholder ? chalk.dim(config.placeholder) : '';
    const shown = status === 'done' ? chalk.cyan(value) : value || ghost;
    return [`${prefix} ${message}${hint} ${shown}`, bottomContent(config.description, error, status === 'idle')];
  },
);

export const describedNumber: DescribedPrompt<number, DescribedNumberConfig> = createPrompt<
  number,
  DescribedNumberConfig
>((config, done) => {
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const prefix = usePrefix({ status });

  useKeypress((key, rl) => {
    if (status !== 'idle') {
      return;
    }
    if (isEnterKey(key)) {
      const raw = value || (config.default !== undefined ? String(config.default) : '');
      const parsed = Number(raw);
      if (raw === '' || Number.isNaN(parsed)) {
        rl.write(value);
        setError('Enter a number.');
        return;
      }
      const result = config.validate ? config.validate(parsed) : true;
      if (result === true) {
        setValue(String(parsed));
        setStatus('done');
        done(parsed);
      } else {
        rl.write(value);
        setError(typeof result === 'string' ? result : 'Invalid answer.');
      }
      return;
    }
    setValue(rl.line);
    setError(undefined);
  });

  const message = chalk.bold(config.message);
  const hint = config.default !== undefined && status === 'idle' && !value ? chalk.dim(` (${config.default})`) : '';
  const ghost = !value && status === 'idle' && config.placeholder ? chalk.dim(config.placeholder) : '';
  const shown = status === 'done' ? chalk.cyan(value) : value || ghost;
  return [`${prefix} ${message}${hint} ${shown}`, bottomContent(config.description, error, status === 'idle')];
});

export const describedConfirm: DescribedPrompt<boolean, DescribedConfirmConfig> = createPrompt<
  boolean,
  DescribedConfirmConfig
>((config, done) => {
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const prefix = usePrefix({ status });

  useKeypress((key, rl) => {
    if (status !== 'idle') {
      return;
    }
    if (isEnterKey(key)) {
      const raw = value.trim().toLowerCase();
      const answer = raw === '' ? (config.default ?? true) : raw === 'y' || raw === 'yes';
      if (raw !== '' && !['y', 'yes', 'n', 'no'].includes(raw)) {
        rl.write(value);
        setError('Answer y or n.');
        return;
      }
      setValue(answer ? 'yes' : 'no');
      setStatus('done');
      done(answer);
      return;
    }
    if (isBackspaceKey(key) && !rl.line) {
      setValue('');
      return;
    }
    setValue(rl.line);
    setError(undefined);
  });

  const message = chalk.bold(config.message);
  const hint = status === 'idle' ? chalk.dim(config.default === false ? ' (y/N)' : ' (Y/n)') : '';
  const shown = status === 'done' ? chalk.cyan(value) : value;
  return [`${prefix} ${message}${hint} ${shown}`, bottomContent(config.description, error, status === 'idle')];
});
