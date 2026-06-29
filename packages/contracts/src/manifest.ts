import { z } from 'zod';
import { CyanError, problem } from './errors';

export const ArtifactKindSchema = z.enum(['template', 'template-group', 'processor', 'plugin', 'resolver']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const RegistryVersionSchema = z
  .union([z.string().regex(/^(0|[1-9]\d*)$/), z.number().int().nonnegative()])
  .transform(version => String(version));

export const ArtifactDependencySchema = z.object({
  kind: ArtifactKindSchema,
  owner: z.string().min(1).optional(),
  name: z.string().min(1),
  version: RegistryVersionSchema.optional(),
});

export type ArtifactDependency = z.infer<typeof ArtifactDependencySchema>;

const DependencyRefSchema = z.string().regex(/^[^/@]+\/[^/@]+(?:@(0|[1-9]\d*))?$/);
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(path => !path.startsWith('/') && !path.startsWith('\\') && !path.includes('\0'), 'Path must be relative.')
  .refine(
    path => path.split(/[\\/]+/).every(part => part.length > 0 && part !== '.' && part !== '..'),
    'Path must not escape the artifact root.',
  );

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
    templates: z.array(DependencyRefSchema).default([]),
    processors: z.array(DependencyRefSchema).default([]),
    plugins: z.array(DependencyRefSchema).default([]),
    resolvers: z.array(DependencyRefSchema).default([]),
    presets: z.record(z.string(), z.unknown()).default({}),
    legacy: z
      .object({
        docker: z.unknown().optional(),
        coordinator: z.unknown().optional(),
        serverExecution: z.unknown().optional(),
      })
      .default({}),
  })
  .strict();

export const CyanManifestSchema = RawCyanManifestSchema.transform(manifest => ({
  ...manifest,
  templates: manifest.templates.map(ref => parseDependencyRef('template', ref)),
  processors: manifest.processors.map(ref => parseDependencyRef('processor', ref)),
  plugins: manifest.plugins.map(ref => parseDependencyRef('plugin', ref)),
  resolvers: manifest.resolvers.map(ref => parseDependencyRef('resolver', ref)),
}));

export type CyanManifest = z.infer<typeof CyanManifestSchema>;

export type CompatibilityWarning = {
  code: 'legacy_docker_ignored' | 'legacy_coordinator_ignored' | 'legacy_server_execution_ignored';
  message: string;
};

export type ParsedManifest = {
  manifest: CyanManifest;
  warnings: CompatibilityWarning[];
};

export function parseCyanManifest(input: unknown): ParsedManifest {
  const normalized = normalizeLegacyResolverManifest(input);
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

function parseDependencyRef(kind: ArtifactDependency['kind'], ref: string): ArtifactDependency {
  const [identity, version] = ref.split('@');
  const [owner, name] = identity?.split('/') ?? [];
  if (!owner || !name) {
    throw new CyanError(problem('validation', 'invalid_dependency_ref', `Invalid dependency ref: ${ref}`));
  }
  return { kind, owner, name, version };
}

export function declaredDependencyKeys(manifest: CyanManifest): Set<string> {
  const refs = [...manifest.templates, ...manifest.processors, ...manifest.plugins, ...manifest.resolvers];
  const keys = new Set<string>();
  for (const ref of refs) {
    const baseKey = `${ref.kind}:${ref.owner ?? manifest.owner}:${ref.name}`;
    if (ref.version) {
      keys.add(`${baseKey}@${ref.version}`);
    } else {
      keys.add(baseKey);
    }
  }
  return keys;
}
