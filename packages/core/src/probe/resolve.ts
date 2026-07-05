import { isAbsolute } from 'node:path';
import type { ProbeFeatureIdentity, ProbeResolutionOrigin } from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';
import { loadManifest } from '../manifest/load-manifest';
import { resolveDevTemplate } from '../create/create-project';
import { exists, safeJoin } from '../util';
import { builtInProbeDefinition } from './builtins';
import { loadProbeDefinitionFile } from './load-probe';
import type { ResolvedFeatureProbes, ResolvedProbe } from './matrix';

export { loadProbeDefinitionFile } from './load-probe';

/**
 * Three-tier probe resolution (FR2, FR4). Per feature, in fixed order:
 * consumer-own → source template → built-ins — where "consumer-own" only ever
 * applies to the consumer's OWN features: a dependency's feature resolves to the
 * DEPENDENCY's `probes/` directory, never the consumer's (no auto-shadowing;
 * identity is (source template, name), so same-named features from different
 * templates stay independent). Explicit overrides displace a dependency
 * feature's probes, propagate through composition (they are part of the
 * overriding template's interface), and diamonds resolve nearest-the-final-
 * consumer, with an equal-distance conflict a hard error.
 */

/** An engine-level override: the final consumer's own declaration (wins every diamond). */
export type ProbeOverrideInput = {
  /** Target feature's source template as an `owner/name` ref. */
  template: string;
  feature: string;
  /** Probe definition file: absolute, or relative to the consumer template dir. */
  file: string;
};

type CompositionNode = {
  /** `owner/name` ref. */
  ref: string;
  version: string;
  dir: string;
  /** Composition-graph distance from the final consumer (consumer = 0). */
  distance: number;
  /**
   * True when this node's dir is a hydrated published artifact (from the bundle
   * cache): its probe files must be bundled before import. False for the local
   * consumer and locally-scanned dependencies (direct import). See
   * {@link loadProbeDefinitionFile}.
   */
  bundled: boolean;
};

/** A non-override origin — what an override origin's `origin` field may carry. */
type ProbeBaseOrigin = Extract<ProbeResolutionOrigin, { kind: 'local' | 'dependency' | 'built-in' }>;

type CollectedOverride = {
  targetTemplate: string;
  feature: string;
  /** Absolute path of the overriding probe definition file. */
  file: string;
  /** Distance of the DECLARING template (-1 = engine-level consumer input). */
  distance: number;
  /** `owner/name` of the declaring template, for attribution and conflicts. */
  declaredBy: string;
  /** The origin that supplies the probes when this override wins. */
  origin: ProbeBaseOrigin;
  /** True when the override FILE lives inside a hydrated artifact (needs bundling). */
  bundled: boolean;
};

/** Declaration mode: resolve every declared feature for a consumer template. */
export async function resolveProbesForTemplate(args: {
  templateDir: string;
  features: ProbeFeatureIdentity[];
  overrides?: ProbeOverrideInput[];
  workspaceRoot?: string;
  localFallback?: boolean;
}): Promise<ResolvedFeatureProbes[]> {
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const { nodes, overrides } = await walkComposition(args.templateDir, workspaceRoot, args.localFallback);
  const consumer = [...nodes.values()].find(node => node.distance === 0);
  if (!consumer) {
    throw new Error('composition walk lost the consumer node');
  }
  for (const override of args.overrides ?? []) {
    overrides.push({
      targetTemplate: override.template,
      feature: override.feature,
      file: isAbsolute(override.file) ? override.file : safeJoin(args.templateDir, override.file),
      distance: -1,
      declaredBy: consumer.ref,
      origin: { kind: 'local' },
      // The final consumer supplies this file locally — import it directly.
      bundled: false,
    });
  }
  const resolved: ResolvedFeatureProbes[] = [];
  for (const feature of args.features) {
    resolved.push(await resolveFeature(feature, nodes, overrides));
  }
  return resolved;
}

/**
 * Explicit-source mode (FR12/G3 — the probe-author debug path): the caller
 * supplies BOTH the feature set and the probe source directory; features match
 * the source's `probes/<name>.ts` definitions directly, bypassing three-tier
 * resolution. Resolve-or-fail still applies: a supplied feature with no
 * definition in the supplied source is a hard error.
 */
export async function resolveProbesFromSource(args: {
  sourceDir: string;
  features: ProbeFeatureIdentity[];
}): Promise<ResolvedFeatureProbes[]> {
  const resolved: ResolvedFeatureProbes[] = [];
  for (const feature of args.features) {
    const file = safeJoin(args.sourceDir, `probes/${feature.name}.ts`);
    if (!(await exists(file))) {
      throw new CyanError(
        problem(
          'validation',
          'probe_resolution_failed',
          `Explicit probe source has no definition for feature "${feature.name}" of ${feature.template}: ` +
            `expected ${file}. A supplied feature must resolve — nothing is silently skipped.`,
          { feature: feature.name, template: feature.template, searched: [file] },
        ),
      );
    }
    const definition = await loadProbeDefinitionFile(file, feature.template);
    resolved.push({
      feature,
      definition,
      probes: definition.probes.map(probe => ({
        probe,
        origin: { kind: 'local' as const },
        source: { kind: 'file' as const, modulePath: file, bundled: false },
      })),
    });
  }
  return resolved;
}

async function walkComposition(
  templateDir: string,
  workspaceRoot: string,
  localFallback?: boolean,
): Promise<{ nodes: Map<string, CompositionNode>; overrides: CollectedOverride[] }> {
  const nodes = new Map<string, CompositionNode>();
  const overrides: CollectedOverride[] = [];
  // The consumer's own dir is always local (never a hydrated artifact).
  let frontier: Array<{ dir: string; distance: number; bundled: boolean }> = [
    { dir: templateDir, distance: 0, bundled: false },
  ];
  while (frontier.length > 0) {
    const next: Array<{ dir: string; distance: number; bundled: boolean }> = [];
    for (const { dir, distance, bundled } of frontier) {
      const { manifest } = await loadManifest(dir);
      const ref = `${manifest.owner}/${manifest.name}`;
      // BFS: the first visit is the minimum distance; later sightings (diamonds)
      // add nothing — the node and its declarations are collected once.
      if (nodes.has(ref)) {
        continue;
      }
      const node: CompositionNode = { ref, version: manifest.version ?? 'local', dir, distance, bundled };
      nodes.set(ref, node);
      for (const declared of manifest.probeOverrides) {
        overrides.push({
          targetTemplate: `${declared.owner}/${declared.name}`,
          feature: declared.feature,
          file: safeJoin(dir, declared.file),
          distance,
          declaredBy: ref,
          origin:
            distance === 0
              ? { kind: 'local' }
              : { kind: 'dependency', owner: manifest.owner, name: manifest.name, version: node.version },
          // The override file lives in THIS node's dir, so it is bundled iff this
          // node is a hydrated artifact.
          bundled,
        });
      }
      for (const dependency of manifest.templates) {
        const child = await resolveDevTemplate({
          workspaceRoot,
          templateDir: dir,
          dependency,
          defaultOwner: manifest.owner,
          localFallback,
        });
        next.push({ dir: child.dir, distance: distance + 1, bundled: child.fromArtifactCache });
      }
    }
    frontier = next;
  }
  return { nodes, overrides };
}

async function resolveFeature(
  feature: ProbeFeatureIdentity,
  nodes: Map<string, CompositionNode>,
  overrides: CollectedOverride[],
): Promise<ResolvedFeatureProbes> {
  const base = await resolveBaseTiers(feature, nodes);
  const candidates = overrides.filter(
    override => override.targetTemplate === feature.template && override.feature === feature.name,
  );
  if (candidates.length === 0) {
    if (!base) {
      const node = nodes.get(feature.template);
      throw new CyanError(
        problem(
          'validation',
          'probe_resolution_failed',
          `No probes resolve for declared feature "${feature.name}" of ${feature.template}. ` +
            `Searched: the template's own probes/${feature.name}.ts` +
            `${node ? ` (${node.dir})` : ''} and the built-in library. ` +
            'A declared feature must be proven (FR2) — author probes for it, or stop declaring it.',
          { feature: feature.name, template: feature.template },
        ),
      );
    }
    return base;
  }

  const nearest = Math.min(...candidates.map(candidate => candidate.distance));
  const winners = candidates.filter(candidate => candidate.distance === nearest);
  if (winners.length > 1) {
    const origins = winners.map(winner => `${winner.declaredBy} (${winner.file})`).join(' vs ');
    throw new CyanError(
      problem(
        'validation',
        'probe_override_conflict',
        `Competing probe overrides for feature "${feature.name}" of ${feature.template} at equal composition ` +
          `distance: ${origins}. Resolve the diamond by declaring an override for this feature in the final consumer.`,
        { feature: feature.name, template: feature.template, origins: winners.map(winner => winner.declaredBy) },
      ),
    );
  }
  const winner = winners[0] as CollectedOverride;
  if (!base) {
    throw new CyanError(
      problem(
        'validation',
        'probe_override_displaces_nothing',
        `Probe override from ${winner.declaredBy} targets feature "${feature.name}" of ${feature.template}, ` +
          'but no probes resolve for it at any tier — there is nothing to displace or audit. ' +
          'Author probes in the source template (or rely on built-ins) before overriding them.',
        { feature: feature.name, template: feature.template, declaredBy: winner.declaredBy },
      ),
    );
  }
  const definition = await loadProbeDefinitionFile(winner.file, winner.declaredBy, { bundled: winner.bundled });
  const displaced = base.probes;
  const probes: ResolvedProbe[] = definition.probes.map((probe, index) => {
    // The audit schema records ONE displaced probe per running probe: pair by
    // definition order, clamped to the last displaced probe when the override
    // supplies more probes than it displaces.
    const displacedProbe = displaced[Math.min(index, displaced.length - 1)] as ResolvedProbe;
    return {
      probe,
      origin: {
        kind: 'override' as const,
        origin: winner.origin,
        displaced: {
          identity: { feature, probe: displacedProbe.probe.name },
          description: displacedProbe.probe.description,
        },
      },
      source: { kind: 'file' as const, modulePath: winner.file, bundled: winner.bundled },
    };
  });
  return { feature, definition, probes };
}

/** Tiers in fixed order: the feature's own template's `probes/`, then built-ins. */
async function resolveBaseTiers(
  feature: ProbeFeatureIdentity,
  nodes: Map<string, CompositionNode>,
): Promise<ResolvedFeatureProbes | undefined> {
  const node = nodes.get(feature.template);
  if (!node) {
    throw new CyanError(
      problem(
        'validation',
        'probe_resolution_failed',
        `Feature "${feature.name}" is declared by ${feature.template}, which is not part of this composition — ` +
          'its probes cannot be resolved.',
        { feature: feature.name, template: feature.template },
      ),
    );
  }
  const file = safeJoin(node.dir, `probes/${feature.name}.ts`);
  if (await exists(file)) {
    const definition = await loadProbeDefinitionFile(file, node.ref, { bundled: node.bundled });
    const origin: ProbeResolutionOrigin =
      node.distance === 0
        ? { kind: 'local' }
        : {
            kind: 'dependency',
            owner: node.ref.split('/')[0] as string,
            name: node.ref.split('/')[1] as string,
            version: node.version,
          };
    return {
      feature,
      definition,
      probes: definition.probes.map(probe => ({
        probe,
        origin,
        source: { kind: 'file' as const, modulePath: file, bundled: node.bundled },
      })),
    };
  }
  const builtIn = builtInProbeDefinition(feature.name);
  if (builtIn) {
    return {
      feature,
      definition: builtIn,
      probes: builtIn.probes.map(probe => ({
        probe,
        origin: { kind: 'built-in' as const },
        source: { kind: 'builtin' as const },
      })),
    };
  }
  return undefined;
}
