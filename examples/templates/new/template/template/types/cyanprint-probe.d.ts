// CyanPrint v4 probe contract — vendored type declarations.
//
// This module is TYPE-ONLY. Template authors import from here with `import type`
// (the vendored copy is mapped as `@cyanprint/probe` in scaffolded template
// projects), so nothing in this file reaches a probe at runtime: the main
// CyanPrint CLI stays the only driver (FR19) and constructs the helper objects
// described here.
//
// It is intentionally self-contained (no imports) so it can be emitted to a
// single `.d.ts` and vendored into scaffolded template projects with zero
// install. It must stay assignability-identical to the canonical contract in
// `@cyanprint/contracts` — `probe-contract-types.test.ts` enforces that at
// compile time, and `bun run package:check` enforces byte parity of every
// vendored copy.

/**
 * The probe contract version this declaration file describes. Every probe
 * definition file carries the version it was written against; a version the
 * engine cannot serve fails loudly, never silently skips.
 */
export declare const PROBE_CONTRACT_VERSION: 1;

/**
 * The fixed verdict vocabulary for a probe run:
 *
 * - `proven`  — a baseline probe passed: the healthy generated repo's gate is green.
 * - `caught`  — a mutation probe's sabotage was detected: the gate turned red.
 * - `missed`  — the false green: a mutation probe's sabotage left the gate green.
 * - `invalid` — the experiment never ran, so the probe asserts nothing.
 * - `broken`  — the gate or environment failed outside the experiment itself.
 */
export type ProbeVerdict = 'proven' | 'caught' | 'missed' | 'invalid' | 'broken';

/** Exit code and captured output of a command run inside the probe sandbox. */
export type ProbeExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * The engine-provided repo helper a probe receives as its first `run` argument.
 * Probes NEVER import an implementation of this interface — the engine hands one
 * in, so probe files stay runnable against any engine that serves their contract
 * version. All paths are relative to the sandboxed copy of the generated repo;
 * `exec` runs with its cwd pinned to the sandbox root and the environment
 * inherited untouched.
 */
export type ProbeRepo = {
  /** Run a shell command in the sandbox; never throws on non-zero exit. */
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
 * Feature identity is per-template: the same feature name declared by two
 * different templates is two different features. `template` is the source
 * template's `owner/name` ref; `name` is the flat declared feature name.
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
 * One experiment against the generated repo. `kind: 'baseline'` proves the
 * healthy repo's gate is green (verdict `proven`); `kind: 'mutation'` applies a
 * sabotage and expects the gate to turn red (verdict `caught` — a green gate is
 * the `missed` false green). `run` is author-owned code: assert in the repo's
 * own test idiom (run gates via `repo.exec` and throw on the wrong outcome).
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
   * probe's sabotage — the attribution carrier that keeps overlapping gates
   * from being misread as unexpected failures.
   */
  expectedImpact?: string[];
  run(repo: ProbeRepo, ctx: ProbeCtx): Promise<void> | void;
};

/** How the sandbox snapshots/restores the generated repo between probes. */
export type ProbeSandboxConfig = {
  snapshot: 'git' | 'fs' | 'auto';
  /** Paths preserved across snapshot restores (e.g. dependency caches). */
  preserve?: string[];
  /** Glob patterns omitted from the source snapshot (setup.pre can recreate them). */
  exclude?: string[];
};

/** Optional two-phase setup commands run once before the definition's probes. */
export type ProbeSetupConfig = {
  pre?: string[];
  post?: string[];
};

/**
 * One probe definition file — one per feature, living in the template's
 * `probes/` directory as `probes/<feature>.ts` next to `cyan.ts`,
 * default-exported.
 */
export type ProbeDefinition = {
  /** The contract version this definition was written against (see PROBE_CONTRACT_VERSION). */
  contractVersion: number;
  sandbox?: ProbeSandboxConfig;
  setup?: ProbeSetupConfig;
  probes: Probe[];
};
