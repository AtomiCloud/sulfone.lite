import { pathToFileURL } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Answers, CyanOutput, CyanScript, PromptAdapter, PromptRequest, VfsFile } from '@cyanprint/contracts';
import { CyanError, makePromptContext, problem, promptOptionValue } from '@cyanprint/contracts';
import { withTempSession } from '../sessions/temp-session';
import { comparePaths, safeJoin } from '../util';

export function answersPromptAdapter(answers: Answers, interactive = false): PromptAdapter {
  return {
    async ask<T>(request: PromptRequest): Promise<T> {
      if (request.name in answers) {
        return answers[request.name] as T;
      }
      if (!interactive && request.default !== undefined) {
        answers[request.name] = request.default;
        return request.default as T;
      }
      if (interactive) {
        const raw = prompt(
          `${request.message}${request.default !== undefined ? ` (${String(request.default)})` : ''}: `,
        );
        const value = raw === null || raw === '' ? request.default : raw;
        if (value === undefined) {
          throw new CyanError(
            problem('validation', 'missing_interactive_answer', `Missing interactive answer for ${request.name}`, {
              request,
            }),
          );
        }
        const normalized = String(value).toLowerCase();
        const parsed =
          request.kind === 'confirm'
            ? normalized === 'true' || normalized === 'yes'
            : request.kind === 'number'
              ? Number(value)
              : request.kind === 'multiselect'
                ? String(value)
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean)
                : value;
        if (request.kind === 'confirm' && !['true', 'yes', 'false', 'no'].includes(normalized)) {
          throw new CyanError(
            problem('validation', 'invalid_interactive_confirm', `Invalid confirm answer for ${request.name}`, {
              request,
              value,
            }),
          );
        }
        if (request.kind === 'number' && Number.isNaN(parsed)) {
          throw new CyanError(
            problem('validation', 'invalid_interactive_number', `Invalid number answer for ${request.name}`, {
              request,
              value,
            }),
          );
        }
        if (request.kind === 'select' && !request.options.map(promptOptionValue).includes(String(parsed))) {
          throw new CyanError(
            problem('validation', 'invalid_interactive_select', `Invalid select answer for ${request.name}`, {
              request,
              value,
            }),
          );
        }
        if (request.kind === 'multiselect') {
          const values = parsed as string[];
          const optionValues = request.options.map(promptOptionValue);
          const invalid = values.filter(item => !optionValues.includes(item));
          if (invalid.length > 0) {
            throw new CyanError(
              problem(
                'validation',
                'invalid_interactive_multiselect',
                `Invalid multiselect answer for ${request.name}`,
                { request, invalid },
              ),
            );
          }
        }
        answers[request.name] = parsed;
        return parsed as T;
      }
      throw new CyanError(
        problem('validation', 'missing_answer', `Missing headless answer for ${request.name}`, { request }),
      );
    },
  };
}

export async function loadCyanScript(scriptPath: string): Promise<CyanScript> {
  const moduleUrl = `${pathToFileURL(scriptPath).href}?cyanprint=${Date.now()}`;
  const loaded = (await import(moduleUrl)) as { default?: unknown; cyan?: unknown };
  const candidate = loaded.default ?? loaded.cyan;
  if (typeof candidate !== 'function') {
    throw new CyanError(
      problem('validation', 'invalid_cyan_script', 'cyan.ts must export a default function or named cyan function.'),
    );
  }
  return candidate as CyanScript;
}

// Custom adapters (e.g. the CLI's inquirer adapter) hold their own answer cache; without this
// wrapper their prompted values never reach `answers`, so generated state persists `answers: {}`
// and update/bubbling cannot reuse them.
function recordingPromptAdapter(answers: Answers, adapter: PromptAdapter): PromptAdapter {
  return {
    async ask<T>(request: PromptRequest): Promise<T> {
      if (request.name in answers) {
        return answers[request.name] as T;
      }
      const value = await adapter.ask<T>(request);
      answers[request.name] = value;
      return value;
    },
  };
}

export async function executeCyanScript(
  scriptPath: string,
  answers: Answers,
  deterministicState: Record<string, unknown>,
  interactive = false,
  promptAdapter: PromptAdapter = answersPromptAdapter(answers, interactive),
): Promise<CyanOutput> {
  return await withTempSession(async session => {
    const script = await loadCyanScript(scriptPath);
    const ctx = makePromptContext(recordingPromptAdapter(answers, promptAdapter), answers, deterministicState, {
      sessionPath: session.path,
    });
    const output = await script(ctx.prompt, ctx);
    assertStaticComposition(output);
    return output;
  });
}

// Composition is static: dependencies are declared only in cyan.yaml. Old scripts that
// return `templates` (dynamic composition) or `resolvers` (use-time resolver config)
// must fail loudly, not be silently ignored.
function assertStaticComposition(output: unknown): void {
  if (!output || typeof output !== 'object') {
    return;
  }
  const record = output as Record<string, unknown>;
  if (record.templates !== undefined) {
    throw new CyanError(
      problem(
        'validation',
        'dynamic_templates_removed',
        'templates cannot be returned from cyan.ts; declare them in cyan.yaml',
      ),
    );
  }
  if (record.resolvers !== undefined) {
    throw new CyanError(
      problem(
        'validation',
        'script_resolvers_removed',
        'resolvers cannot be returned from cyan.ts; declare them (with config and files globs) in cyan.yaml under resolvers:',
      ),
    );
  }
}

type TemplateFileGlobOptions = {
  base?: string;
  root?: string;
  exclude?: string[];
  mode?: 'template' | 'copy';
};

export async function globTemplateFiles(
  templateRoot: string,
  pattern: string,
  options: TemplateFileGlobOptions = {},
): Promise<VfsFile[]> {
  const base = options.base ?? options.root ?? '';
  const scanRoot = base ? safeJoin(templateRoot, base) : templateRoot;
  // Derive the probe check prefix from the *resolved* scan root relative to the template root,
  // not the textual base: `safeJoin` collapses `..`/`.` segments (so `base: 'template/..'` scans
  // the template root itself), and the exclusion check must see the same collapsed path or a
  // normalized alias like `template/../probes` would smuggle probe files past `isTemplateProbePath`.
  const normalizedBase = relative(resolve(templateRoot), scanRoot)
    .split(/[\\/]+/)
    .filter(part => part && part !== '.')
    .join('/');
  const excludes = (options.exclude ?? []).map(exclude => new Bun.Glob(exclude));
  const mode = options.mode ?? 'copy';
  const glob = new Bun.Glob(pattern);
  const files: VfsFile[] = [];
  for (const path of await walkTemplateFiles(scanRoot)) {
    // Drop the probe surface by BOTH the template-root-relative source path AND the
    // scan-root-relative output path. The source path (with normalized base) keeps the
    // template's own probes/ + probes.yaml out of every scope, including via `..` aliases
    // that resolve into the probe directory. The output path closes the payload-scope
    // leak: a scope like `base: 'template'` writes files at their scan-root-relative path,
    // so a file at `template/probes/tests.ts` would otherwise materialize as `probes/tests.ts`
    // in the generated repo — AC5 guarantees generated repos NEVER contain probes/** or
    // probes.yaml, regardless of where in the template tree the file physically lives.
    const sourcePath = normalizedBase ? `${normalizedBase}/${path}` : path;
    if (isTemplateProbePath(sourcePath) || isTemplateProbePath(path)) {
      continue;
    }
    if (!matchesTemplateGlob(glob, pattern, path)) {
      continue;
    }
    if (excludes.some(exclude => exclude.match(path))) {
      continue;
    }
    const bytes = await readFile(join(scanRoot, path));
    if (mode === 'template') {
      const content = decodeTemplateContent(path, bytes);
      files.push({ path, content });
    } else {
      files.push({
        path,
        bytesBase64: Buffer.from(bytes).toString('base64'),
      });
    }
  }
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Probes ride the published template artifact but must never materialize into
 * generated repos: the template's own `probes/` directory and committed
 * `probes.yaml` (both siblings of cyan.ts) are excluded from every template file
 * scope, even a root-level `**\/*` glob. Applied to BOTH the source path and the
 * generated-repo output path, so `probes/**` and `probes.yaml` can never appear in
 * a generated repo — whether the file lives at the template root or is a payload
 * path like `template/probes/…` whose output would land at `probes/…` (AC5 is an
 * absolute guarantee about generated repos, so no scope may reintroduce the probe
 * surface).
 *
 * Exported so the tree-assembly boundary in `create-project.ts` can apply the SAME
 * predicate to processor/plugin *output* paths: this input-side scope filter only
 * sees files it globs off disk, so a processor that synthesizes a fresh `probes/…`
 * output path never passes through here. The generated-tree waist re-checks every
 * final path with this predicate to keep AC5 absolute across every output vector.
 */
export function isTemplateProbePath(rootRelativePath: string): boolean {
  return rootRelativePath === 'probes.yaml' || rootRelativePath === 'probes' || rootRelativePath.startsWith('probes/');
}

function matchesTemplateGlob(glob: Bun.Glob, pattern: string, path: string): boolean {
  if (pattern === '**/*') {
    return true;
  }
  return glob.match(path);
}

async function walkTemplateFiles(root: string, dir = root, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkTemplateFiles(root, join(dir, entry.name), relativePath)));
    } else if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
}

function decodeTemplateContent(path: string, bytes: Uint8Array): string {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\u0000')) {
      throw new Error('NUL byte');
    }
    return content;
  } catch {
    throw new CyanError(
      problem('validation', 'template_file_not_utf8', `Template file must be UTF-8 text: ${path}`, { path }),
    );
  }
}
