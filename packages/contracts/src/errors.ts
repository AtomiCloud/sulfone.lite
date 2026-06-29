import { z } from 'zod';

export const ProblemCategorySchema = z.enum([
  'validation',
  'auth',
  'permission',
  'not_found',
  'conflict',
  'storage',
  'trust',
  'execution',
  'unexpected',
]);

export type ProblemCategory = z.infer<typeof ProblemCategorySchema>;

export type CyanProblem = {
  category: ProblemCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export class CyanError extends Error {
  readonly problem: CyanProblem;

  constructor(problem: CyanProblem) {
    super(problem.message);
    this.name = 'CyanError';
    this.problem = problem;
  }
}

export function problem(
  category: ProblemCategory,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CyanProblem {
  return { category, code, message, details };
}
