import { z } from 'zod';

/**
 * The probe contract version this engine build serves. Probes are a versioned public
 * surface: every probe definition file carries the contract version it was written
 * against (`ProbeDefinition.contractVersion`), and a version the engine cannot serve
 * must surface as a loud, attributable failure — never a silent skip.
 */
export const PROBE_CONTRACT_VERSION = 1;

/**
 * The fixed verdict vocabulary for a probe run:
 *
 * - `proven`  — a baseline probe passed: the healthy generated repo's gate is green.
 * - `caught`  — a mutation probe's sabotage was detected: the gate turned red.
 * - `missed`  — the false green: a mutation probe's sabotage left the gate green.
 * - `invalid` — the experiment never ran (e.g. the sabotage could not be applied),
 *               so the probe asserts nothing about the gate.
 * - `broken`  — the gate or environment failed outside the experiment itself,
 *               including probe timeouts and failed baselines.
 */
export const ProbeVerdictSchema = z.enum(['proven', 'caught', 'missed', 'invalid', 'broken']);
export type ProbeVerdict = z.infer<typeof ProbeVerdictSchema>;

/**
 * The sanctioned "this experiment does not apply here" signal. A probe that
 * discovers its precondition is absent (nothing to sabotage, no gate to consult)
 * throws `probeInapplicable(...)` and the engine records the verdict `invalid` —
 * the probe asserts nothing. The marker is a plain property (not an instanceof
 * check) so it survives bundling across module realms.
 */
const PROBE_INAPPLICABLE_MARKER = 'cyanprintProbeInapplicable';

export function probeInapplicable(reason: string): Error {
  const error = new Error(reason);
  Object.defineProperty(error, PROBE_INAPPLICABLE_MARKER, { value: true, enumerable: false });
  return error;
}

export function isProbeInapplicable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[PROBE_INAPPLICABLE_MARKER] === true
  );
}

/** Exit code and captured output of a command run inside the probe sandbox. */
export type ProbeExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * The engine-provided repo helper a probe receives as its first `run` argument.
 * Probes NEVER import an implementation of this interface — the engine hands one in,
 * so probe files stay runnable against any engine that serves their contract version.
 *
 * All paths are relative to the sandboxed copy of the generated repo; `exec` runs with
 * its cwd pinned to the sandbox root and the environment inherited untouched.
 */
export type ProbeRepo = {
  /**
   * Run a shell command in the sandbox; never throws on non-zero exit. On timeout
   * (per-command `timeoutMs`, or the enclosing per-probe timeout) the engine kills
   * the command's spawned process group / PPID-connected subtree — descendants
   * that leave it (`setsid`, daemonization) escape the kill, a documented
   * limitation: tracking them would need an engine-injected environment marker,
   * which the untouched-environment guarantee above rules out.
   */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ProbeExecResult>;
  /** Read a sandbox file as UTF-8 text. */
  read(path: string): Promise<string>;
  /** Write (create or overwrite) a sandbox file. */
  write(path: string, content: string): Promise<void>;
  /** Remove a sandbox file or directory tree. */
  remove(path: string): Promise<void>;
  /** List sandbox file paths matching a glob pattern. */
  glob(pattern: string): Promise<string[]>;
  /** Replace `find` with `replace` in a sandbox file; a missing `find` is a loud failure. */
  patch(path: string, edit: { find: string; replace: string }): Promise<void>;
};

/**
 * Feature identity is per-template: the same feature name declared by two different
 * templates is two different features. `template` is the source template's
 * `owner/name` ref; `name` is the flat feature name from `CyanOutput.features`.
 */
export type ProbeFeatureIdentity = {
  template: string;
  name: string;
};

/** Invocation context the engine passes to every probe run. */
export type ProbeCtx = {
  /** Identity of the feature this probe proves. */
  feature: ProbeFeatureIdentity;
  /** Absolute path of the sandboxed generated repo the probe is running against. */
  sandboxPath: string;
  /** The per-probe timeout in effect for this run, in milliseconds. */
  timeoutMs: number;
};

/**
 * One experiment against the generated repo. `kind: 'baseline'` proves the healthy
 * repo's gate is green (verdict `proven`); `kind: 'mutation'` applies a sabotage and
 * expects the gate to turn red (verdict `caught` — a green gate is the `missed`
 * false green).
 *
 * `run` is author-owned code: assertions are written in the repo's own test idiom
 * (run the repo's gates via `repo.exec` and throw on the wrong outcome) — the engine
 * prescribes no assertion helpers.
 */
export type Probe = {
  name: string;
  /** Mandatory one-line, human-readable statement of what this probe demonstrates. */
  description: string;
  kind: 'baseline' | 'mutation';
  /** Per-probe timeout override in milliseconds. */
  timeoutMs?: number;
  /**
   * Feature names whose gates may legitimately redden as a side effect of this
   * probe's sabotage — the attribution carrier that keeps overlapping gates from
   * being misread as unexpected failures.
   */
  expectedImpact?: string[];
  run(repo: ProbeRepo, ctx: ProbeCtx): Promise<void> | void;
};

/** How the sandbox snapshots/restores the generated repo between probes. */
export type ProbeSandboxConfig = {
  snapshot: 'git' | 'fs' | 'auto';
  /** Paths preserved across snapshot restores (e.g. dependency caches). */
  preserve?: string[];
};

/** Optional two-phase setup commands run once before the definition's probes. */
export type ProbeSetupConfig = {
  pre?: string[];
  post?: string[];
};

/**
 * One probe definition file — one per feature, living in the template's `probes/`
 * directory as `probes/<feature>.ts` next to `cyan.ts`, default-exported.
 */
export type ProbeDefinition = {
  /** The contract version this definition was written against (see PROBE_CONTRACT_VERSION). */
  contractVersion: number;
  sandbox?: ProbeSandboxConfig;
  setup?: ProbeSetupConfig;
  probes: Probe[];
};

// ---------------------------------------------------------------------------
// Zod schemas for the declarative parts of a probe definition. `run` is
// author-owned code, so it is only validated to be a function.
// ---------------------------------------------------------------------------

/**
 * Probe descriptions are a mandatory ONE-LINER everywhere they appear (probe
 * definitions, the committed manifest, override displacement records, run
 * reports) — a description containing a line break is malformed data for every
 * downstream audit/report consumer, so the schema rejects it outright.
 */
export const OneLineDescriptionSchema = z
  .string()
  .min(1)
  .refine(value => !/[\r\n]/.test(value), 'description must be a single line (no line breaks)');

export const ProbeSandboxConfigSchema: z.ZodType<ProbeSandboxConfig> = z
  .object({
    snapshot: z.enum(['git', 'fs', 'auto']),
    preserve: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ProbeSetupConfigSchema: z.ZodType<ProbeSetupConfig> = z
  .object({
    pre: z.array(z.string().min(1)).optional(),
    post: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ProbeSchema: z.ZodType<Probe> = z
  .object({
    name: z.string().min(1),
    description: OneLineDescriptionSchema,
    kind: z.enum(['baseline', 'mutation']),
    timeoutMs: z.number().int().positive().optional(),
    expectedImpact: z.array(z.string().min(1)).optional(),
    run: z.custom<Probe['run']>(value => typeof value === 'function', 'run must be a function'),
  })
  .strict();

export const ProbeDefinitionSchema: z.ZodType<ProbeDefinition> = z
  .object({
    contractVersion: z.number().int().positive(),
    sandbox: ProbeSandboxConfigSchema.optional(),
    setup: ProbeSetupConfigSchema.optional(),
    // Probe names must be unique within a definition: verdicts, the run matrix,
    // and the manifest all key a probe by `(template, feature, name)`, so two
    // probes sharing a name would silently overwrite each other's verdicts (an
    // FR7 violation). Rejected loudly here, naming the duplicates.
    probes: z
      .array(ProbeSchema)
      .min(1)
      .superRefine((probes, ctx) => {
        const seen = new Set<string>();
        for (const probe of probes) {
          if (seen.has(probe.name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicate probe name "${probe.name}" — probe names must be unique within a definition (verdicts are keyed by name)`,
            });
          }
          seen.add(probe.name);
        }
      }),
  })
  .strict();

// ---------------------------------------------------------------------------
// probes.yaml manifest (FR6 carrier; generation and drift-checking land with the
// engine). The manifest is machine-generated and committed next to cyan.yaml; it
// records, per feature, every probe that would run and where each one came from.
// ---------------------------------------------------------------------------

export const ProbeFeatureIdentitySchema = z
  .object({
    template: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

/** Identity of a single probe: the feature it proves plus the probe's own name. */
export const ProbeIdentitySchema = z
  .object({
    feature: ProbeFeatureIdentitySchema,
    probe: z.string().min(1),
  })
  .strict();

/**
 * Where a resolved probe came from:
 * - `local`      — authored in this template's own `probes/` directory.
 * - `dependency` — inherited from a composed template (`owner/name@version`).
 * - `built-in`   — shipped with the engine.
 */
const ProbeBaseOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z
    .object({
      kind: z.literal('dependency'),
      owner: z.string().min(1),
      name: z.string().min(1),
      version: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('built-in') }).strict(),
]);

/**
 * The fourth origin: an explicit override. It records the origin that now supplies
 * the probe AND the identity + description of the probe it displaced, so an audit
 * can always answer "what stopped running, and what runs instead?".
 */
const ProbeOverrideOriginSchema = z
  .object({
    kind: z.literal('override'),
    origin: ProbeBaseOriginSchema,
    displaced: z
      .object({
        identity: ProbeIdentitySchema,
        description: OneLineDescriptionSchema,
      })
      .strict(),
  })
  .strict();

export const ProbeResolutionOriginSchema = z.union([ProbeBaseOriginSchema, ProbeOverrideOriginSchema]);
export type ProbeResolutionOrigin = z.infer<typeof ProbeResolutionOriginSchema>;

const ProbeManifestProbeSchema = z
  .object({
    name: z.string().min(1),
    description: OneLineDescriptionSchema,
    kind: z.enum(['baseline', 'mutation']),
    origin: ProbeResolutionOriginSchema,
  })
  .strict();

const ProbeManifestFeatureSchema = z
  .object({
    template: z.string().min(1),
    name: z.string().min(1),
    probes: z.array(ProbeManifestProbeSchema).min(1),
  })
  .strict();

/** The committed `probes.yaml` shape. */
export const ProbeManifestSchema = z
  .object({
    contractVersion: z.number().int().positive(),
    features: z.array(ProbeManifestFeatureSchema),
  })
  .strict();

export type ProbeManifest = z.infer<typeof ProbeManifestSchema>;

// ---------------------------------------------------------------------------
// Run report: the manifest shape with a verdict attached to every probe.
// ---------------------------------------------------------------------------

const ProbeRunReportProbeSchema = ProbeManifestProbeSchema.safeExtend({
  verdict: ProbeVerdictSchema,
});

const ProbeRunReportFeatureSchema = ProbeManifestFeatureSchema.safeExtend({
  probes: z.array(ProbeRunReportProbeSchema).min(1),
});

export const ProbeRunReportSchema = z
  .object({
    contractVersion: z.number().int().positive(),
    features: z.array(ProbeRunReportFeatureSchema),
  })
  .strict();

export type ProbeRunReport = z.infer<typeof ProbeRunReportSchema>;
