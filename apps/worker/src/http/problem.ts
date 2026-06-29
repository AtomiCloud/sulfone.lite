import type { Context } from 'hono';
import { problem, type ProblemCategory } from '@cyanprint/contracts';

export function problemResponse(c: Context, status: number, category: ProblemCategory, code: string, message: string) {
  return c.json(problem(category, code, message), status as never);
}
