import { z } from 'zod';

export const PromptKindSchema = z.enum(['text', 'confirm', 'select', 'multiselect', 'number']);
export type PromptKind = z.infer<typeof PromptKindSchema>;

/**
 * Optional per-prompt validation. Return `true` to accept, or an error message (or `false`)
 * to reject. Interactive adapters re-prompt on rejection; headless answers fail the run.
 */
export type PromptValidator = (value: unknown) => boolean | string;

/**
 * A select/multiselect option: a bare string, or an object with a display label and a
 * description that interactive adapters render below the list for the highlighted option.
 */
export type PromptOption = string | { value: string; label?: string; description?: string };

export function promptOptionValue(option: PromptOption): string {
  return typeof option === 'string' ? option : option.value;
}

export type PromptRequest =
  | {
      kind: 'text';
      name: string;
      message: string;
      default?: string;
      placeholder?: string;
      description?: string;
      validate?: PromptValidator;
    }
  | {
      kind: 'confirm';
      name: string;
      message: string;
      default?: boolean;
      description?: string;
      validate?: PromptValidator;
    }
  | {
      kind: 'select';
      name: string;
      message: string;
      options: PromptOption[];
      default?: string;
      description?: string;
      validate?: PromptValidator;
    }
  | {
      kind: 'multiselect';
      name: string;
      message: string;
      options: PromptOption[];
      default?: string[];
      description?: string;
      validate?: PromptValidator;
    }
  | {
      kind: 'number';
      name: string;
      message: string;
      default?: number;
      placeholder?: string;
      description?: string;
      validate?: PromptValidator;
    };

export type Answers = Record<string, unknown>;

export type PromptAdapter = {
  ask<T>(request: PromptRequest): Promise<T>;
};

export type VfsFile = {
  path: string;
  content?: string;
  bytesBase64?: string;
  mode?: number;
};

/**
 * CyanPrint-managed metadata that lives alongside generated files but is never part of
 * an artifact's VFS. Reads (including SDK helper reads) must ignore these paths.
 */
export const CYAN_METADATA_PATHS = {
  stateFile: '.cyan_state.yaml',
} as const;

export function isCyanMetadataPath(relativePath: string): boolean {
  const normalized = relativePath.split(/[\\/]+/).join('/');
  return normalized === CYAN_METADATA_PATHS.stateFile;
}

/** Where a merged file variation came from. */
export type FileOrigin = {
  /** Contributing template as `owner/name@version`. */
  template: string;
  /** Order within the resolution scope. */
  layer: number;
  /** Set for tier-1 (processor) variations: the source processor and its invocation index. */
  processor?: { ref: string; invocation: number };
};

export type ProvenanceDecision = 'added' | 'resolver-merged' | 'lww-override';
export type ProvenanceSegment = 'processor' | 'dependency' | 'sibling';

/** One merge decision for a path — the durable record of the three-tier resolution. */
export type Provenance = {
  path: string;
  /** Winning template ref. */
  source: string;
  decision: ProvenanceDecision;
  /** Absent for 'added'. */
  segment?: ProvenanceSegment;
  /** Resolver ref actually invoked (resolver-merged only). */
  resolver?: string;
  /** Every contributing variation's origin. Absent for 'added'. */
  contributors?: FileOrigin[];
};

export type TemplateHistoryEntry = {
  version: string;
  time: string;
  answers: Answers;
  deterministicState: Record<string, unknown>;
};

/** One installed template in a project. Projects track N templates (multi-install). */
export type InstalledTemplate = {
  owner: string;
  name: string;
  version: string;
  source: string;
  active: boolean;
  installedAt: string;
  /** Version history, oldest first; the last entry is the current install. */
  history: TemplateHistoryEntry[];
  artifacts: Array<{ kind: string; owner: string; name: string; version: string; integrity: string }>;
};

/**
 * The `.cyan_state.yaml` shape. Stores answers + versions + deterministic state per
 * template — never old output. `files` records paths + hashes of the last generation;
 * `provenance` is the persisted record of every three-tier merge decision.
 */
export type GeneratedState = {
  cyanprint: 4;
  templates: InstalledTemplate[];
  files: Array<{ path: string; sha256: string }>;
  provenance: Provenance[];
};
