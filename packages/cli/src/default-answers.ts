import { join } from 'node:path';

/** The template's own `answers.json` when present, used as the default answers file for tests. */
export async function defaultTemplateAnswers(target: string): Promise<string | undefined> {
  const answers = join(target, 'answers.json');
  return (await Bun.file(answers).exists()) ? answers : undefined;
}
