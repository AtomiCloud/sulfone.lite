// CyanPrint v4 SDK type contract.
//
// This module is TYPE-ONLY. Artifact authors import from here with `import type`,
// so nothing in this file reaches a bundled artifact at runtime. The CyanPrint
// runtime constructs the helper objects described here and passes them in.
//
// It is intentionally self-contained (no imports) so it can be emitted to a single
// `.d.ts` and vendored into generated artifacts with zero install.

/** A single file in the virtual file system. Text uses `content`; binary uses `bytesBase64`. */
export type VfsFile = {
  path: string;
  content?: string;
  bytesBase64?: string;
  mode?: number;
};

/** Raw execution context handed to a processor. */
export type ProcessorInput = {
  inputDir: string;
  outputDir: string;
  config?: unknown;
};

/** Helper injected as the second argument of a processor. */
export type ProcessorFsHelper = {
  context: {
    inputDir: string;
    outputDir: string;
    config?: unknown;
  };
  /** Read every file from `inputDir` into the VFS (CyanPrint metadata files are ignored). */
  read(): Promise<VfsFile[]>;
  /** Write the VFS into `outputDir` using the same safe-path checks as the runtime. */
  write(files: VfsFile[]): Promise<void>;
};

/** A processor. The second `fs` helper is the common path; raw `input` dirs remain the escape hatch. */
export type Processor = (input: ProcessorInput, fs: ProcessorFsHelper) => unknown | Promise<unknown>;

/** Raw execution context handed to a plugin. */
export type PluginInput = {
  inputDir: string;
  outputDir: string;
  dir: string;
  config?: unknown;
};

/** Options for `helper.exec`. */
export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Throw when the command exits non-zero. Defaults to `true`. */
  throwOnError?: boolean;
};

/** Result of `helper.exec`. */
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Helper injected as the second argument of a plugin. */
export type PluginHelper = {
  context: {
    inputDir: string;
    outputDir: string;
    dir: string;
    config?: unknown;
  };
  read(): Promise<VfsFile[]>;
  write(files: VfsFile[]): Promise<void>;
  /** Run a shell command in `outputDir` by default. Throws on non-zero exit unless opted out. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
};

/** A plugin. */
export type Plugin = (input: PluginInput, helper: PluginHelper) => unknown | Promise<unknown>;

/** Where a resolved file variation came from. */
export type FileOrigin = {
  /** Contributing template as `owner/name@version`. */
  template: string;
  /** Order within the resolution scope. */
  layer: number;
  /** Set for processor-output (tier-1) variations: source processor ref + invocation index. */
  processor?: { ref: string; invocation: number };
};

/** A file variation participating in a resolver merge. */
export type ResolvedFile = {
  path: string;
  content: string;
  origin: FileOrigin;
};

/**
 * Input to a v4 resolver: ONE call per conflicting path, carrying ALL variations of that
 * path in the resolution scope at once (with origins). There is no pairwise fold.
 */
export type ResolverInput = {
  config: Record<string, unknown>;
  files: ResolvedFile[];
};

/** Output of a resolver merge. */
export type ResolverOutput = {
  path: string;
  content: string;
};

/** A v4 resolver: merges every variation of one path in a single call. */
export type Resolver = (input: ResolverInput) => ResolverOutput | Promise<ResolverOutput>;
