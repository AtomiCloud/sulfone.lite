import { z } from 'zod';
import { ArtifactDependencySchema, ArtifactKindSchema } from './manifest';

export const ObjectRefSchema = z.object({
  bucket: z.string().default('cyanprint-local-r2'),
  key: z.string().min(1),
  sha256: z.string().min(16),
  size: z.number().int().nonnegative(),
});

export const ArtifactObjectsSchema = z.object({
  manifest: ObjectRefSchema,
  readme: ObjectRefSchema.optional(),
  bundle: ObjectRefSchema,
  archive: ObjectRefSchema.optional(),
});

export const ResolvedDependencyPinSchema = z.object({
  kind: ArtifactKindSchema,
  owner: z.string(),
  name: z.string(),
  version: z.string().regex(/^\d+$/),
  integrity: z.string(),
});

export const ArtifactVersionSchema = z.object({
  id: z.string(),
  kind: ArtifactKindSchema,
  owner: z.string(),
  name: z.string(),
  version: z.string().regex(/^\d+$/),
  publishedAt: z.string().datetime().optional(),
  readme: z.string().default(''),
  dependencies: z.array(ArtifactDependencySchema).default([]),
  resolvedPins: z.array(ResolvedDependencyPinSchema).default([]),
  object: ObjectRefSchema.optional(),
  artifactObjects: ArtifactObjectsSchema.optional(),
  scriptOnly: z.boolean().optional(),
  disabled: z.boolean().default(false),
  moderationState: z.enum(['active', 'disabled', 'review']).default('active'),
  downloads: z.number().int().nonnegative().default(0),
  likes: z.number().int().nonnegative().default(0),
});

export const ArtifactPublishSchema = ArtifactVersionSchema.omit({ id: true, version: true }).strict();

export type ObjectRef = z.infer<typeof ObjectRefSchema>;
export type ArtifactObjects = z.infer<typeof ArtifactObjectsSchema>;
export type ResolvedDependencyPin = z.infer<typeof ResolvedDependencyPinSchema>;
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type ArtifactPublish = z.infer<typeof ArtifactPublishSchema>;

export type BatchResolveRequest = {
  refs: Array<{ kind: string; owner?: string; name: string; version?: string }>;
};

export type BatchResolveResponse = {
  resolved: ArtifactVersion[];
  missing: Array<{ kind: string; owner?: string; name: string; version?: string }>;
};

export function artifactVersionId(kind: string, owner: string, name: string, version: string): string {
  return [kind, owner, name, version].map(encodeArtifactIdPart).join('__');
}

export function artifactIntegrity(artifact: Pick<ArtifactVersion, 'artifactObjects' | 'object' | 'id'>): string {
  if (artifact.artifactObjects) {
    return [
      'artifact-objects-v1',
      objectIntegrityPart('manifest', artifact.artifactObjects.manifest),
      artifact.artifactObjects.readme ? objectIntegrityPart('readme', artifact.artifactObjects.readme) : 'readme:none',
      objectIntegrityPart('bundle', artifact.artifactObjects.bundle),
      artifact.artifactObjects.archive
        ? objectIntegrityPart('archive', artifact.artifactObjects.archive)
        : 'archive:none',
    ].join('|');
  }
  if (artifact.object) {
    return objectIntegrityPart('object', artifact.object);
  }
  return `${artifact.id}-metadata`;
}

function objectIntegrityPart(label: string, ref: ObjectRef): string {
  return `${label}:${ref.bucket}:${ref.key}:${ref.sha256}:${ref.size}`;
}

function encodeArtifactIdPart(part: string): string {
  return Array.from(part)
    .map(char => (/^[a-zA-Z0-9]$/.test(char) ? char : `_x${char.codePointAt(0)?.toString(16).padStart(2, '0')}_`))
    .join('');
}
