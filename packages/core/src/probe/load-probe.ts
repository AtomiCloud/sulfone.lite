import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProbeDefinition } from '@cyanprint/contracts';
import { CyanError, PROBE_CONTRACT_VERSION, ProbeDefinitionSchema, problem } from '@cyanprint/contracts';
import { compileRuntimeBundle } from '@cyanprint/artifact-bundler';
import { isRecord } from '../util';

/**
 * Probe module loading, extracted from `resolve.ts` so the isolated probe runner
 * subprocess (`probe-runner.ts`) can reuse the exact same import + validation path
 * WITHOUT pulling in the heavy resolution/generation graph (`create-project.ts`
 * and friends). Both the in-process resolver and the runner load and validate
 * probe definition files identically.
 *
 * Loading follows plan-1's convention (spec.md:135-138): artifact-shipped probes
 * (from a hydrated dependency bundle) are compiled through the existing
 * `compileRuntimeBundle` / `Bun.build` path so their bundleable imports resolve
 * the same way the artifact build did; a locally-authored probe file (the
 * consumer's own dir, a locally-scanned dependency, or explicit-source dev mode)
 * is imported directly.
 */

/**
 * Load one probe definition file. Failures are loud and attributed to their
 * origin (template + file) — an incompatible contract version in particular is a
 * hard error, never a silent skip or a false verdict (plan-1 risk stance, AC8).
 */
export async function loadProbeDefinitionFile(
  file: string,
  template: string,
  opts?: { bundled?: boolean },
): Promise<ProbeDefinition> {
  let candidate: unknown;
  try {
    candidate = (await importProbeModule(file, opts?.bundled ?? false)).default;
  } catch (error) {
    throw new CyanError(
      problem(
        'validation',
        'invalid_probe_definition',
        `Probe definition file from ${template} failed to load: ${file} (${error instanceof Error ? error.message : String(error)})`,
        { template, file },
      ),
    );
  }
  if (
    isRecord(candidate) &&
    typeof candidate.contractVersion === 'number' &&
    candidate.contractVersion !== PROBE_CONTRACT_VERSION
  ) {
    throw new CyanError(
      problem(
        'validation',
        'probe_contract_version_unsupported',
        `Probe definition ${file} from ${template} declares contract version ${candidate.contractVersion}, ` +
          `but this engine serves version ${PROBE_CONTRACT_VERSION}. Update the probe file or the engine — ` +
          'incompatible probes never silently skip.',
        { template, file, declared: candidate.contractVersion, supported: PROBE_CONTRACT_VERSION },
      ),
    );
  }
  const parsed = ProbeDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CyanError(
      problem('validation', 'invalid_probe_definition', `Probe definition file from ${template} is invalid: ${file}`, {
        template,
        file,
        issues: parsed.error.issues,
      }),
    );
  }
  return parsed.data;
}

/**
 * Import a probe module's default export. Local files import directly (fast dev
 * loop); artifact-shipped files are first bundled with `compileRuntimeBundle`
 * (the same `Bun.build` path the artifact build uses) into a temp ESM module so
 * their imports inline exactly as they did at publish time, then imported.
 */
export async function importProbeModule(file: string, bundled: boolean): Promise<{ default?: unknown }> {
  if (!bundled) {
    return (await import(`${pathToFileURL(file).href}?cyanprint=${Date.now()}`)) as { default?: unknown };
  }
  const outDir = await mkdtemp(join(tmpdir(), 'cyanprint-probe-bundle-'));
  const output = join(outDir, 'probe.mjs');
  try {
    // No `kind` → no runtime-export-arity validation: a probe module default-exports
    // a definition object, not a named runtime function.
    await compileRuntimeBundle({ entrypoint: file, output });
    return (await import(`${pathToFileURL(output).href}?cyanprint=${Date.now()}`)) as { default?: unknown };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
