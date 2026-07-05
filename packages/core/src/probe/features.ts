import type { ProbeFeatureIdentity } from '@cyanprint/contracts';
import { comparePaths } from '../util';

/**
 * The (source template, name) identity invariant for FR3/FR6, in one place.
 *
 * Feature identity is per-template: the same feature name declared by two
 * different templates is two distinct features. Both the persisted-state union
 * (`generated-state.ts`) and the manifest derivation (`manifest.ts`) key and
 * order features by this rule, so the shared helpers here keep the two callers
 * from drifting rather than maintaining parallel copies of the invariant.
 */

/**
 * Map key that makes (template, name) the identity — JSON-encoded so no
 * separator can collide. Exported so every keyed-by-feature-identity site
 * (the union here, and coverage-by-proof in the test flow) shares ONE
 * collision-free scheme: an ad hoc `${template}#${name}` join lets the distinct
 * identities `{template:'a', name:'b#c'}` and `{template:'a#b', name:'c'}`
 * collapse to the same key.
 */
export function featureIdentityKey(feature: ProbeFeatureIdentity): string {
  return JSON.stringify([feature.template, feature.name]);
}

/** Deterministic order: by source template, then feature name. */
export function sortFeatureIdentities(features: ProbeFeatureIdentity[]): ProbeFeatureIdentity[] {
  return [...features].sort(
    (left, right) => comparePaths(left.template, right.template) || comparePaths(left.name, right.name),
  );
}

/**
 * Deterministic union of feature identities across composed generations (FR3):
 * deduplicated on (source template, name) and sorted, so the result is stable
 * regardless of which flow (create, layer, update, manifest derivation)
 * assembled the inputs.
 */
export function unionFeatureIdentities(lists: ProbeFeatureIdentity[][]): ProbeFeatureIdentity[] {
  const union = new Map<string, ProbeFeatureIdentity>();
  for (const list of lists) {
    for (const feature of list) {
      union.set(featureIdentityKey(feature), feature);
    }
  }
  return sortFeatureIdentities([...union.values()]);
}
