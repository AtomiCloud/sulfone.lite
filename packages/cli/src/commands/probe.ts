import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProbeEvidenceClass, ProbeFeatureIdentity, ProbeRunReport } from '@cyanprint/contracts';
import { CyanError, PROBE_CONTRACT_VERSION, problem } from '@cyanprint/contracts';
import {
  checkProbeManifestDrift,
  declaredFeatureSetForRepo,
  exists,
  loadManifest,
  PROBE_MANIFEST_FILE,
  runProbeMatrix,
  summarizeProbeReport,
  writeProbeManifest,
  type ProbeExecutionOptions,
  type ProbeSelectionInput,
  type ProbeSourcesInput,
} from '@cyanprint/core';
import { parseFlags, flagBool, flagString, parseParallel } from '../args';
import { failure, kv, printJson, printSection, success } from '../ui';

/**
 * `cyanprint probe` (FR12/FR13): prove feature promises against an ALREADY
 * materialized repo through the same `runProbeMatrix` engine as the test-flow
 * probe tier — there is no second execution path. Two pinned invocation modes:
 *
 * - explicit-source — `cyanprint probe <repo> --probes <dir> --features <file>`:
 *   the probe-author debug path; the manifest gate is SKIPPED (the run asserts
 *   nothing about any template's declared promises).
 * - declaration — `cyanprint probe <repo> --template <dir>`: the feature set is
 *   the repo's persisted `.cyan_state.yaml` union scoped to THIS `--template`'s
 *   own install contribution (see `declaredFeatureSetForRepo` in core) — so a
 *   multi-install repo's sibling features are proven only by their own
 *   `--template` runs, never leaked in here, while a template whose declarations
 *   drifted away from the repo's recorded promises fails loudly
 *   (`probe_declared_feature_drift`) instead of running a silently smaller
 *   matrix; the manifest drift gate fires (FR6) unless `--update-manifest` just
 *   regenerated it.
 */
export async function probeCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const json = flagBool(flags, 'json');
  const repo = positional[0];
  const templateFlag = flagString(flags, 'template');
  const probesFlag = flagString(flags, 'probes');
  const featuresFlag = flagString(flags, 'features');
  const updateManifest = flagBool(flags, 'update-manifest');

  if (updateManifest) {
    if (!templateFlag) {
      throw new Error('--update-manifest requires --template <dir>: the committed probes.yaml lives in the template');
    }
    if (probesFlag || featuresFlag) {
      throw new Error(
        "--update-manifest regenerates a template's committed probes.yaml from its own declarations — " +
          'it cannot be combined with an explicit probe source (--probes/--features)',
      );
    }
    const templateDir = resolve(templateFlag);
    const manifest = await writeProbeManifest(templateDir);
    const manifestPath = join(templateDir, PROBE_MANIFEST_FILE);
    const probeCount = manifest.features.reduce((count, feature) => count + feature.probes.length, 0);
    if (json) {
      // Under --json, stdout must stay valid machine-readable JSON. When combined
      // with a run, the human manifest-update summary would corrupt the JSON run
      // payload printed below, so suppress it — the manifest was still regenerated
      // and the drift gate is satisfied. Standalone (no repo), the update is the
      // whole output, so emit it as JSON.
      if (!repo) {
        printJson({ status: 'updated', path: manifestPath, features: manifest.features.length, probes: probeCount });
      }
    } else {
      console.log(success(`wrote ${manifestPath}`));
      printSection('Manifest', [kv('features', manifest.features.length), kv('probes', probeCount)]);
    }
    if (!repo) {
      return;
    }
  }

  if (!repo) {
    throw new Error('probe requires a materialized repo path (or --update-manifest with --template)');
  }
  const repoPath = resolve(repo);
  if (!(await exists(repoPath))) {
    throw new Error(`materialized repo not found: ${repo}`);
  }

  if (templateFlag && (probesFlag || featuresFlag)) {
    throw new Error(
      'choose one probe source mode: --template <dir> (declarations) or --probes <dir> --features <file> (explicit source)',
    );
  }
  if (Boolean(probesFlag) !== Boolean(featuresFlag)) {
    throw new Error('explicit-source mode needs BOTH --probes <dir> and --features <file>');
  }

  let probeSources: ProbeSourcesInput;
  let features: ProbeFeatureIdentity[];
  if (probesFlag && featuresFlag) {
    const sourceDir = await normalizeProbeSource(probesFlag);
    probeSources = { mode: 'explicit-source', dir: sourceDir };
    features = await readFeatureSet(featuresFlag, sourceDir);
  } else if (templateFlag) {
    const templateDir = resolve(templateFlag);
    features = await declaredFeatureSetForRepo(repoPath, templateDir);
    if (features.length > 0 && !updateManifest) {
      // FR6, both entry points, one rule: probing a feature-declaring template via
      // its own declarations requires a committed, drift-free probes.yaml.
      await checkManifestGate(templateDir);
    }
    probeSources = { mode: 'declaration', templateDir };
  } else {
    throw new Error('probe needs a probe source: --template <dir>, or --probes <dir> with --features <file>');
  }

  if (features.length === 0) {
    // A valid no-op run (no composed template declares features) still honours
    // BOTH output surfaces: --report must produce the run report file at parity
    // with --json — automation may request the artifact regardless of whether
    // anything was probed. Build the empty payload once and route it through the
    // same write/emit path as a real matrix run.
    const emptyPayload = {
      mode: 'matrix' as const,
      repo: repoPath,
      source:
        probeSources.mode === 'declaration'
          ? { mode: probeSources.mode, template: probeSources.templateDir }
          : { mode: probeSources.mode, dir: probeSources.dir },
      counts: emptyCounts(),
      report: emptyReport(),
      events: [],
      note: 'no declared features to probe',
    };
    const reportPath = flagString(flags, 'report');
    if (reportPath) {
      await writeFile(reportPath, JSON.stringify(emptyPayload, null, 2), 'utf8');
    }
    if (json) {
      printJson(emptyPayload);
    } else {
      console.log(success(`nothing to probe: no composed template declares features for ${repo}`));
    }
    return;
  }

  const selection = buildSelection(flagString(flags, 'feature'), flagString(flags, 'probe'));
  const options: ProbeExecutionOptions = {
    parallelism: parseParallel(flagString(flags, 'parallel')),
    timeoutMs: parseTimeoutSeconds(flagString(flags, 'timeout')),
    keepSandboxes: flagBool(flags, 'keep-sandbox'),
  };

  const result = await runProbeMatrix({ repoPath, probeSources, features, selection, options });
  const summary = summarizeProbeReport(result.report);
  const counts = {
    proven: summary.proven,
    caught: summary.caught,
    missed: summary.missed,
    invalid: summary.invalid,
    broken: summary.broken,
  };
  // Selection is a debug mode: the report is labelled so nobody reads a
  // selected subset as full-matrix results (FR13).
  const mode: 'matrix' | 'selection' = selection ? 'selection' : 'matrix';
  const sandboxes = result.runs
    .filter(run => run.sandboxPath)
    .map(run => ({
      runIndex: run.runIndex,
      kind: run.kind,
      ...(run.mutation ? { mutation: run.mutation } : {}),
      sandboxPath: run.sandboxPath as string,
    }));
  const payload = {
    mode,
    repo: repoPath,
    source:
      probeSources.mode === 'declaration'
        ? { mode: probeSources.mode, template: probeSources.templateDir }
        : { mode: probeSources.mode, dir: probeSources.dir },
    counts,
    report: result.report,
    events: result.events,
    ...(options.keepSandboxes ? { snapshotPath: result.snapshotPath, sandboxes } : {}),
  };
  const unexpectedControls = result.events.filter(event => event.attribution?.kind === 'unexpected-control');

  const reportPath = flagString(flags, 'report');
  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8');
  }
  const failed = counts.missed > 0 || counts.broken > 0 || unexpectedControls.length > 0;
  if (json) {
    printJson(payload);
  } else {
    console.log(failed ? failure(`probe ${repo}`) : success(`probe ${repo}`));
    if (mode === 'selection') {
      console.log('selection run — a debug subset, not full-matrix results');
    }
    printSection('Verdicts', verdictRows(result.report));
    printSection('Summary', [
      kv('proven', counts.proven),
      kv('caught', counts.caught),
      kv('missed', counts.missed),
      kv('invalid', counts.invalid),
      kv('broken', counts.broken),
    ]);
    if (unexpectedControls.length > 0) {
      printSection(
        'Unexpected control failures',
        unexpectedControls.map(event =>
          kv(
            `${event.feature}/${event.probe}`,
            `${event.outcome} (exit ${event.exitCode ?? 'signal/engine'}) in run ${event.runIndex}`,
          ),
        ),
      );
    }
    if (options.keepSandboxes) {
      printSection('Sandboxes (kept)', [
        kv('snapshot', result.snapshotPath),
        ...sandboxes.map(sandbox =>
          kv(
            sandbox.mutation
              ? `run ${sandbox.runIndex} (${sandbox.mutation.feature}/${sandbox.mutation.probe})`
              : `run ${sandbox.runIndex} (baseline)`,
            sandbox.sandboxPath,
          ),
        ),
      ]);
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

/** Re-throw drift failures with the author-facing regenerate hint attached. */
async function checkManifestGate(templateDir: string): Promise<void> {
  try {
    await checkProbeManifestDrift(templateDir);
  } catch (error) {
    if (error instanceof CyanError && error.problem.code === 'probe_manifest_drift') {
      throw new CyanError(
        problem(
          error.problem.category,
          error.problem.code,
          `${error.problem.message}\nRegenerate with: cyanprint probe --template ${templateDir} --update-manifest`,
          error.problem.details,
        ),
      );
    }
    throw error;
  }
}

/** Accept a template dir containing `probes/`, or the `probes/` folder itself. */
async function normalizeProbeSource(dir: string): Promise<string> {
  const absolute = resolve(dir);
  if (await exists(join(absolute, 'probes'))) {
    return absolute;
  }
  if (basename(absolute) === 'probes' && (await exists(absolute))) {
    return dirname(absolute);
  }
  throw new Error(`--probes must name a template dir containing probes/, or a probes folder itself: ${dir}`);
}

/**
 * Parse the `--features` JSON file: an array of `{template, name, class?}` identities,
 * with bare-string names allowed when the probe source is a template dir whose
 * manifest supplies the owning `owner/name` ref.
 */
export async function readFeatureSet(file: string, sourceDir: string): Promise<ProbeFeatureIdentity[]> {
  const parsed = JSON.parse(await readFile(isAbsolute(file) ? file : resolve(file), 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`--features file must contain a non-empty JSON array: ${file}`);
  }
  let sourceRef: string | undefined;
  const defaultTemplate = async (): Promise<string> => {
    if (!sourceRef) {
      try {
        const { manifest } = await loadManifest(sourceDir);
        sourceRef = `${manifest.owner}/${manifest.name}`;
      } catch {
        throw new Error(
          `--features entries given as bare names need a template-dir probe source to supply the owning template; ` +
            `use the {"template":"owner/name","name":"feature"} form instead (${file})`,
        );
      }
    }
    return sourceRef;
  };
  const features: ProbeFeatureIdentity[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry.length > 0) {
      features.push({ template: await defaultTemplate(), name: entry });
      continue;
    }
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { template?: unknown }).template === 'string' &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      const identity = entry as { template: string; name: string; class?: unknown };
      if (identity.class !== undefined && !isProbeEvidenceClass(identity.class)) {
        throw new Error(
          `--features class must be one of "gate", "smoke", or "presence", got ${JSON.stringify(identity.class)}: ${file}`,
        );
      }
      features.push({
        template: identity.template,
        name: identity.name,
        ...(identity.class === undefined ? {} : { class: identity.class }),
      });
      continue;
    }
    throw new Error(`--features entries must be feature names or {"template","name","class"?} objects: ${file}`);
  }
  return features;
}

function isProbeEvidenceClass(value: unknown): value is ProbeEvidenceClass {
  return value === 'gate' || value === 'smoke' || value === 'presence';
}

function buildSelection(
  featureList: string | undefined,
  probeList: string | undefined,
): ProbeSelectionInput | undefined {
  const features = splitList(featureList);
  const probes = splitList(probeList);
  if (features.length === 0 && probes.length === 0) {
    return undefined;
  }
  return {
    ...(features.length > 0 ? { features } : {}),
    ...(probes.length > 0 ? { probes } : {}),
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function verdictRows(report: ProbeRunReport): string[] {
  const rows: string[] = [];
  for (const feature of report.features) {
    rows.push(`${feature.template}#${feature.name}`);
    for (const probe of feature.probes) {
      rows.push(`  ${kv(probe.verdict, `${probe.name} — ${probe.description}`)}`);
    }
  }
  return rows;
}

function emptyCounts(): Record<'proven' | 'caught' | 'missed' | 'invalid' | 'broken', number> {
  return { proven: 0, caught: 0, missed: 0, invalid: 0, broken: 0 };
}

function emptyReport(): ProbeRunReport {
  // Reuse the single source of truth for the contract version (as the normal report
  // builder in packages/core/src/probe/manifest.ts does) so the no-feature path can
  // never drift from the canonical value.
  return { contractVersion: PROBE_CONTRACT_VERSION, features: [] };
}

function parseTimeoutSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got "${value}"`);
  }
  return Math.round(parsed * 1000);
}
