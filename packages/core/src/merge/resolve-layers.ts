import type { FileOrigin, Provenance, ProvenanceSegment, ResolverDeclaration, VfsFile } from '@cyanprint/contracts';
import { comparePaths, stableConfig } from '../util';

/**
 * One layer in a resolution scope: a contributing template's full file set plus the
 * template's `resolvers:` list (its nomination source). Layer order is the array order —
 * the highest layer wins last-write-wins outcomes.
 */
export type ResolutionLayer = {
  /** Contributing template ref, `owner/name@version`. */
  template: string;
  files: VfsFile[];
  /** The contributing template's `resolvers:` declarations, used to nominate per path. */
  resolvers: ResolverDeclaration[];
  /** Tier-1 only: the source processor invocation that produced this layer. */
  processor?: { ref: string; invocation: number };
};

/** Invoked once per agreed path with every variation in scope. */
export type ResolverInvoker = (args: {
  resolver: ResolverDeclaration;
  path: string;
  files: Array<{ path: string; content: string; origin: FileOrigin }>;
}) => Promise<string>;

export type ResolveLayersResult = {
  files: VfsFile[];
  decisions: Provenance[];
};

/**
 * Helium-exact global resolution: for every path with more than one variation in scope,
 * each contributing template nominates a resolver (first `resolvers:` entry whose `files:`
 * globs match the path). Unanimous ref + identical config ⇒ ONE resolver call with all
 * variations; anything else ⇒ last-write-wins by highest layer, recorded as an
 * `lww-override` decision.
 */
export async function resolveLayers(args: {
  layers: ResolutionLayer[];
  segment: ProvenanceSegment;
  invokeResolver: ResolverInvoker;
}): Promise<ResolveLayersResult> {
  type Variation = { file: VfsFile; layerIndex: number; layer: ResolutionLayer };
  const byPath = new Map<string, Variation[]>();
  for (const [layerIndex, layer] of args.layers.entries()) {
    for (const file of layer.files) {
      const variations = byPath.get(file.path) ?? [];
      variations.push({ file, layerIndex, layer });
      byPath.set(file.path, variations);
    }
  }

  const output: VfsFile[] = [];
  const decisions: Provenance[] = [];
  for (const path of [...byPath.keys()].sort(comparePaths)) {
    const variations = byPath.get(path) ?? [];
    const first = variations[0];
    if (!first) {
      continue;
    }
    if (variations.length === 1) {
      output.push(first.file);
      continue;
    }
    // Byte-identical variations are not a conflict: nothing can be lost, so no decision
    // is recorded (the path surfaces as `added`). Recording `lww-override` here would
    // fail strict template tests for common shared files (LICENSE, .editorconfig, ...).
    if (variations.every(variation => sameFileContent(variation.file, first.file))) {
      output.push(first.file);
      continue;
    }

    const contributors: FileOrigin[] = variations.map(variation => ({
      template: variation.layer.template,
      layer: variation.layerIndex,
      ...(variation.layer.processor ? { processor: variation.layer.processor } : {}),
    }));
    const winner = variations[variations.length - 1] ?? first;
    const nominations = variations.map(variation => nominateResolver(variation.layer.resolvers, path));
    const agreed = agreedNomination(nominations);
    const binary = variations.some(variation => variation.file.bytesBase64 !== undefined);

    if (agreed && !binary) {
      const content = await args.invokeResolver({
        resolver: agreed,
        path,
        files: variations.map((variation, index) => ({
          path,
          content: variation.file.content ?? '',
          origin: contributors[index] as FileOrigin,
        })),
      });
      output.push({ path, content });
      decisions.push({
        path,
        source: winner.layer.template,
        decision: 'resolver-merged',
        segment: args.segment,
        resolver: resolverRef(agreed),
        contributors,
      });
      continue;
    }

    output.push(winner.file);
    decisions.push({
      path,
      source: winner.layer.template,
      decision: 'lww-override',
      segment: args.segment,
      contributors,
    });
  }

  return { files: output.sort((left, right) => comparePaths(left.path, right.path)), decisions };
}

function sameFileContent(left: VfsFile, right: VfsFile): boolean {
  return left.content === right.content && left.bytesBase64 === right.bytesBase64;
}

/** First `resolvers:` entry whose `files:` globs match the path — per template, per path. */
export function nominateResolver(resolvers: ResolverDeclaration[], path: string): ResolverDeclaration | undefined {
  return resolvers.find(entry => entry.files.some(pattern => new Bun.Glob(pattern).match(path)));
}

/**
 * Consensus check (iridium-exact): Agreed when every contributor nominates the same
 * resolver ref with identical config. AllNone / NoConsensus / Ambiguous ⇒ undefined (LWW).
 */
function agreedNomination(nominations: Array<ResolverDeclaration | undefined>): ResolverDeclaration | undefined {
  const first = nominations[0];
  if (!first || nominations.some(nomination => nomination === undefined)) {
    return undefined;
  }
  const identity = nominationIdentity(first);
  return nominations.every(nomination => nomination && nominationIdentity(nomination) === identity) ? first : undefined;
}

function nominationIdentity(entry: ResolverDeclaration): string {
  return `${resolverRef(entry)}:${stableConfig(entry.config)}`;
}

export function resolverRef(entry: ResolverDeclaration): string {
  return `${entry.owner}/${entry.name}${entry.version ? `@${entry.version}` : ''}`;
}
