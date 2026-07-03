import { z } from 'zod';
import { CyanError, problem } from './errors';

export const ArtifactKindSchema = z.enum(['template', 'template-group', 'processor', 'plugin', 'resolver']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const RegistryVersionSchema = z
  .union([z.string().regex(/^(0|[1-9]\d*)$/), z.number().int().nonnegative()])
  .transform(version => String(version));

/**
 * A dependency declaration. The artifact kind is never part of the declaration —
 * it is implied by the cyan.yaml section (`templates:` / `processors:` / `plugins:` /
 * `resolvers:`) or the code context the ref appears in.
 */
export const ArtifactDependencySchema = z.object({
  owner: z.string().min(1).optional(),
  name: z.string().min(1),
  version: RegistryVersionSchema.optional(),
});

export type ArtifactDependency = z.infer<typeof ArtifactDependencySchema>;

/**
 * Runtime-internal artifact reference. Registry, cache, and trust internals still need
 * the kind an endpoint or storage path requires; it is attached from context, never
 * read from authored config.
 */
export type KindedArtifactRef = ArtifactDependency & { kind: ArtifactKind };

const DependencyRefSchema = z.string().regex(/^[^/@]+\/[^/@]+(?:@(0|[1-9]\d*))?$/);
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(path => !path.startsWith('/') && !path.startsWith('\\') && !path.includes('\0'), 'Path must be relative.')
  .refine(
    path => path.split(/[\\/]+/).every(part => part.length > 0 && part !== '.' && part !== '..'),
    'Path must not escape the artifact root.',
  );

/** Per-dependency config embedded in the `templates:` dictionary. `{}` (or nothing) = just depend on it. */
const TemplateDependencyConfigSchema = z
  .object({
    answers: z.record(z.string(), z.unknown()).default({}),
    deterministicState: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** An entry in the `resolvers:` list: a ref plus config and the file globs it merges. */
const ResolverEntrySchema = z
  .object({
    ref: DependencyRefSchema,
    config: z.record(z.string(), z.unknown()).default({}),
    files: z.array(z.string().min(1)).min(1),
  })
  .strict();

const RawCyanManifestSchema = z
  .object({
    cyanprint: z.literal(4).default(4),
    kind: ArtifactKindSchema,
    owner: z.string().min(1).default('local'),
    name: z.string().min(1),
    version: RegistryVersionSchema.optional(),
    description: z.string().optional(),
    license: z.string().optional(),
    readme: SafeRelativePathSchema.default('README.md'),
    entry: SafeRelativePathSchema.default('cyan.ts'),
    bundledEntry: SafeRelativePathSchema,
    templates: z.record(DependencyRefSchema, TemplateDependencyConfigSchema.nullable()).default({}),
    processors: z.array(DependencyRefSchema).default([]),
    plugins: z.array(DependencyRefSchema).default([]),
    resolvers: z.array(ResolverEntrySchema).default([]),
    legacy: z
      .object({
        docker: z.unknown().optional(),
        coordinator: z.unknown().optional(),
        serverExecution: z.unknown().optional(),
      })
      .default({}),
  })
  .strict();

/** A `templates:` dictionary entry: the ref plus its embedded per-dependency config. */
export type TemplateDependency = ArtifactDependency & {
  owner: string;
  answers: Record<string, unknown>;
  deterministicState: Record<string, unknown>;
};

/** A parsed `resolvers:` entry: the ref plus config and file globs used for nomination. */
export type ResolverDeclaration = ArtifactDependency & {
  owner: string;
  config: Record<string, unknown>;
  files: string[];
};

export const CyanManifestSchema = RawCyanManifestSchema.transform(manifest => ({
  ...manifest,
  templates: Object.entries(manifest.templates).map(
    ([ref, config]): TemplateDependency => ({
      ...parseDependencyRef(ref),
      answers: config?.answers ?? {},
      deterministicState: config?.deterministicState ?? {},
    }),
  ),
  processors: manifest.processors.map(ref => parseDependencyRef(ref)),
  plugins: manifest.plugins.map(ref => parseDependencyRef(ref)),
  resolvers: manifest.resolvers.map(
    (entry): ResolverDeclaration => ({
      ...parseDependencyRef(entry.ref),
      config: entry.config,
      files: entry.files,
    }),
  ),
}));

export type CyanManifest = z.infer<typeof CyanManifestSchema>;

export type CompatibilityWarning = {
  code:
    | 'legacy_docker_ignored'
    | 'legacy_coordinator_ignored'
    | 'legacy_server_execution_ignored'
    | 'post_generation_command_skipped'
    | 'merge_conflicts_pending';
  message: string;
};

export type ParsedManifest = {
  manifest: CyanManifest;
  warnings: CompatibilityWarning[];
};

const REMOVED_MANIFEST_FIELDS: Array<{ field: string; message: string }> = [
  {
    field: 'presets',
    message:
      'presets: has been removed. Declare per-dependency config directly in the templates: dictionary, e.g. `templates: { owner/name: { answers: {...}, deterministicState: {...} } }`.',
  },
  {
    field: 'api',
    message:
      'api: has been removed. Resolvers have a single runtime API: one call per conflicting path with all variations (`resolver({ config, files })`).',
  },
  {
    field: 'commutative',
    message: 'commutative: has been removed along with the pairwise resolver fold.',
  },
];

export function parseCyanManifest(input: unknown): ParsedManifest {
  const normalized = normalizeLegacyResolverManifest(input);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>;
    for (const removed of REMOVED_MANIFEST_FIELDS) {
      if (record[removed.field] !== undefined) {
        throw new CyanError(problem('validation', `removed_manifest_field_${removed.field}`, removed.message));
      }
    }
  }
  const parsed = CyanManifestSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CyanError(
      problem('validation', 'invalid_manifest', 'cyan.yaml is invalid', { issues: parsed.error.issues }),
    );
  }

  const warnings: CompatibilityWarning[] = [];
  const legacy = parsed.data.legacy;
  if (legacy.docker !== undefined) {
    warnings.push({
      code: 'legacy_docker_ignored',
      message: 'Docker metadata is ignored in CyanPrint v4 local execution.',
    });
  }
  if (legacy.coordinator !== undefined) {
    warnings.push({ code: 'legacy_coordinator_ignored', message: 'Coordinator metadata is ignored in CyanPrint v4.' });
  }
  if (legacy.serverExecution !== undefined) {
    warnings.push({
      code: 'legacy_server_execution_ignored',
      message: 'Server-side execution is not supported in CyanPrint v4.',
    });
  }

  return { manifest: parsed.data, warnings };
}

function normalizeLegacyResolverManifest(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  if (record.cyanprint !== undefined || record.kind !== undefined) {
    return input;
  }
  const build = record.build;
  const buildRecord =
    build && typeof build === 'object' && !Array.isArray(build) ? (build as Record<string, unknown>) : {};
  const images = buildRecord.images;
  const imageRecord =
    images && typeof images === 'object' && !Array.isArray(images) ? (images as Record<string, unknown>) : {};
  if (imageRecord.resolver === undefined || typeof record.name !== 'string') {
    return input;
  }
  return {
    cyanprint: 4,
    kind: 'resolver',
    owner: typeof record.username === 'string' && record.username.length > 0 ? record.username : 'local',
    name: record.name,
    description: typeof record.description === 'string' ? record.description : undefined,
    readme: typeof record.readme === 'string' ? record.readme : undefined,
    entry: 'index.ts',
    bundledEntry: 'dist/index.js',
  };
}

export function parseDependencyRef(ref: string): ArtifactDependency & { owner: string } {
  const [identity, version] = ref.split('@');
  const [owner, name] = identity?.split('/') ?? [];
  if (!owner || !name) {
    throw new CyanError(problem('validation', 'invalid_dependency_ref', `Invalid dependency ref: ${ref}`));
  }
  return { owner, name, version };
}

/** Format a parsed dependency back into its `owner/name[@version]` ref form. */
export function formatDependencyRef(dependency: ArtifactDependency, defaultOwner = 'local'): string {
  const base = `${dependency.owner ?? defaultOwner}/${dependency.name}`;
  return dependency.version ? `${base}@${dependency.version}` : base;
}

/**
 * Declared dependency keys for one manifest section. Keys are `owner:name[@version]` —
 * the kind is implied by which section the set was built from.
 */
export function declaredDependencyKeys(dependencies: ArtifactDependency[], defaultOwner: string): Set<string> {
  const keys = new Set<string>();
  for (const ref of dependencies) {
    const baseKey = `${ref.owner ?? defaultOwner}:${ref.name}`;
    if (ref.version) {
      keys.add(`${baseKey}@${ref.version}`);
    } else {
      keys.add(baseKey);
    }
  }
  return keys;
}
