import type { GeneratedState, InstalledTemplate, ProbeFeatureIdentity } from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';
import { loadManifest } from '../manifest/load-manifest';
import {
  activeTemplates,
  currentHistoryEntry,
  hasGeneratedState,
  loadGeneratedState,
  mergedDeterministicState,
  mergedStateAnswers,
} from '../state/generated-state';
import { featureIdentityKey, sortFeatureIdentities } from './features';
import { deriveFeaturesForAnswers, deriveTemplateFeatureSet } from './manifest';

/**
 * The declaration-mode feature set for a materialized repo (FR3/FR12/FR13): what
 * `cyanprint probe <repo> --template <dir>` and the `probe: true` test tier prove
 * against the final combined repo. Core-owned (not a CLI helper) because deciding
 * "what did this repo declare?" is probe/state domain logic, testable on its own
 * and shared by both entry points so they can never disagree.
 *
 * The authoritative record is the probed install's OWN history entry: each
 * install persists the features its generation declared (dependencies included,
 * per-template identity — `TemplateHistoryEntry.features`), which is exactly the
 * per-install attribution the flat state union lacks. When that record exists,
 * declaration mode probes precisely it, and any recorded feature the install's
 * re-derivation (a deterministic replay of its recorded answers — the same
 * invariant the manifest drift check relies on) no longer produces is template
 * drift: the repo's own state records a promise this run would quietly stop
 * proving. That is a hard `probe_declared_feature_drift` failure in EVERY
 * install configuration — a drifted dependency of the probed template fails
 * just as loudly in a multi-install repo as in a single-install one, because
 * the attribution is recorded, not inferred. Features the template gained
 * SINCE generation (re-derivation produces them, the record does not) are
 * scoped out silently: the run reflects what the materialized repo actually
 * contains, not what the template would declare today.
 *
 * An install that recorded no `features` is only genuinely ambiguous in a repo
 * generated BEFORE per-install attribution existed. When any active install DOES
 * carry attribution the state is modern, so an install omitting `features`
 * declared zero — even if a sibling contributed flat-union entries under this
 * same template ref (a same-ref dependency install with feature-enabling
 * answers); declaration mode returns the empty set rather than mis-reading the
 * sibling's feature as the probed install's own drift.
 *
 * Only genuinely pre-attribution repos (NO active install carries `features`)
 * fall back to scoping the flat state union: intersect it with the install's
 * re-derived features, and fail loudly only for drops that cannot be a sibling
 * install's (the probed template's own ref, or any drop when it is the repo's
 * sole install — see `assertUnionScopable`). That heuristic cannot attribute a
 * dependency's feature in a multi-install repo; one `cyanprint update` of the
 * repo backfills the attribution and closes the gap.
 */
export async function declaredFeatureSetForRepo(
  repoPath: string,
  templateDir: string,
): Promise<ProbeFeatureIdentity[]> {
  // No state file at all (never a normal CyanPrint output): there is no
  // generation record to scope against, so fall back to the template's
  // profile-union derivation (spec §1's documented fallback).
  if (!(await hasGeneratedState(repoPath))) {
    return await deriveTemplateFeatureSet(templateDir);
  }
  const state = await loadGeneratedState(repoPath);
  const { manifest } = await loadManifest(templateDir);
  const templateRef = `${manifest.owner}/${manifest.name}`;
  const install = activeTemplates(state).find(entry => `${entry.owner}/${entry.name}` === templateRef);
  const recorded = install ? currentHistoryEntry(install).features : undefined;
  const union = state.features ?? [];

  // A state file that exists but records ZERO features for this repo — no
  // per-install attribution AND an empty (omitted) flat union — is a repo that
  // declared nothing to probe: a feature-OFF generation. Return the empty set
  // directly. Re-deriving the install's recorded answers against the CURRENT
  // template would INVENT a promise the materialized repo never made if the
  // template has since changed to declare a feature for those same answers —
  // the false `missed` the earlier re-derivation shortcut produced. A state file
  // exists here, so this is NOT the no-state fallback above (which derives the
  // template's profile union for a genuinely unknown repo). A legacy pre-feature
  // repo is byte-identical and equally recorded zero promises; `cyanprint update`
  // backfills per-install attribution if it later gains features. This matches
  // the documented contract (docs/user/probe.md): a feature-off install records
  // nothing to probe, and only a repo with no state file derives the union.
  if (recorded === undefined && union.length === 0) {
    return [];
  }

  if (recorded !== undefined) {
    // Recorded attribution path: the install's history entry IS what this
    // install promised. Exact drift detection, no sibling inference needed.
    const installFeatures = await deriveInstallFeatureSet(state, templateDir, install);
    assertRecordedFeaturesDerivable({ templateRef, recorded, installFeatures });
    return sortFeatureIdentities(recorded);
  }

  // The probed install exists in history but recorded no features, yet the flat
  // union is non-empty. Distinguish MODERN mixed-attribution state from GENUINELY
  // pre-attribution legacy state: if any active install carries per-install
  // `features`, this repo was generated after attribution existed, so an install
  // that omits `features` explicitly declared ZERO — the flat-union entries were
  // contributed by SIBLING installs (possibly composing this same template ref
  // with feature-enabling answers), not by this install. Returning [] reflects
  // what the probed install actually promised; the legacy fallback below would
  // instead mis-read a same-ref sibling's feature as this install's own drift and
  // throw. Only genuine legacy state — where NO install carries attribution —
  // uses the flat-union intersection heuristic.
  if (install !== undefined && hasPerInstallAttribution(state)) {
    return [];
  }

  // Legacy fallback (pre-attribution state with a non-empty flat union): scope
  // the flat union by intersection, failing loudly only for unattributable drops.
  const installFeatures = await deriveInstallFeatureSet(state, templateDir, install);
  assertUnionScopable({ state, templateRef, install, union, installFeatures });
  return intersectFeatures(union, installFeatures);
}

/**
 * True when any active install records per-install feature attribution — the
 * signal that this repo was generated after per-install `features` existed.
 * In such a MODERN repo an install that omits `features` explicitly declared
 * zero; only a repo where NO active install carries attribution is treated as
 * genuine pre-attribution legacy state (the flat-union fallback).
 */
function hasPerInstallAttribution(state: GeneratedState): boolean {
  return activeTemplates(state).some(template => currentHistoryEntry(template).features !== undefined);
}

/**
 * The features attributable to `templateDir`'s own install in this repo: its
 * recorded install answers replayed through a headless generation. When
 * `--template` matches a recorded install we use THAT install's answers, so a
 * consumer that composed a dependency with feature-disabling answers derives zero
 * features for it. When `--template` is present only as a dependency (a debug
 * probe of a non-root template) there is no matching root install, so we fall
 * back to the merged answer union across active installs.
 */
async function deriveInstallFeatureSet(
  state: GeneratedState,
  templateDir: string,
  install: InstalledTemplate | undefined,
): Promise<ProbeFeatureIdentity[]> {
  const history = install ? currentHistoryEntry(install) : undefined;
  const answers = history ? history.answers : mergedStateAnswers(state);
  const deterministicState = history ? history.deterministicState : mergedDeterministicState(state);
  return await deriveFeaturesForAnswers(templateDir, answers, deterministicState);
}

/**
 * The loud half of the RECORDED-attribution contract: every feature the probed
 * install's history entry records must still be produced by re-deriving that
 * install's answers against the current template. A recorded feature that
 * re-derivation no longer yields — the template's own OR a composed
 * dependency's — means the template's feature declarations have drifted since
 * this repo was generated. Because the record carries per-install attribution,
 * no sibling inference is involved: this closes the flat-union blind spot where
 * a dependency's drifted-away feature in a multi-install repo was
 * indistinguishable from a sibling install's feature and got scoped out
 * silently (a green empty/smaller matrix for a promise the repo still records).
 */
function assertRecordedFeaturesDerivable(args: {
  templateRef: string;
  recorded: ProbeFeatureIdentity[];
  installFeatures: ProbeFeatureIdentity[];
}): void {
  const derivedKeys = new Set(args.installFeatures.map(featureIdentityKey));
  const drifted = sortFeatureIdentities(args.recorded.filter(feature => !derivedKeys.has(featureIdentityKey(feature))));
  if (drifted.length === 0) {
    return;
  }
  throw driftError(args.templateRef, drifted);
}

/**
 * The loud half of the LEGACY scoping contract (history entries written before
 * per-install attribution existed): any persisted feature the intersection
 * would drop must be attributable to a sibling install, or the run must fail
 * rather than silently shrink the matrix. Unattributable drops are:
 *
 * - a feature the probed template ITSELF declared (`feature.template ===
 *   templateRef`) that its install's re-derivation no longer produces — the
 *   template's feature-declaration code drifted since the repo was generated
 *   (or a sibling composed this same template with different answers, which the
 *   flat union genuinely cannot separate from drift); and
 * - when `--template` is the repo's ONLY active install, ANY drop — every
 *   persisted feature (its own and its dependencies') came from that one
 *   install's generation, so nothing can belong to a sibling.
 *
 * A dropped feature under a FOREIGN ref in a multi-install repo stays silent
 * here: the flat union genuinely cannot tell a sibling install's feature from a
 * drifted-away dependency feature, so the legacy heuristic must tolerate the
 * drop to keep sibling scoping working. Repos whose installs carry recorded
 * attribution never reach this path — `assertRecordedFeaturesDerivable` detects
 * exactly that dependency-drift case — and one `cyanprint update` backfills the
 * record for a legacy repo (documented in docs/user/probe.md).
 */
function assertUnionScopable(args: {
  state: GeneratedState;
  templateRef: string;
  install: InstalledTemplate | undefined;
  union: ProbeFeatureIdentity[];
  installFeatures: ProbeFeatureIdentity[];
}): void {
  const installKeys = new Set(args.installFeatures.map(featureIdentityKey));
  const dropped = args.union.filter(feature => !installKeys.has(featureIdentityKey(feature)));
  if (dropped.length === 0) {
    return;
  }
  const soleInstall = args.install !== undefined && activeTemplates(args.state).length === 1;
  const unattributable = sortFeatureIdentities(
    dropped.filter(feature => soleInstall || feature.template === args.templateRef),
  );
  if (unattributable.length === 0) {
    return;
  }
  throw driftError(args.templateRef, unattributable);
}

/** The shared drift failure: names the exact recorded promises the run would have stopped proving. */
function driftError(templateRef: string, drifted: ProbeFeatureIdentity[]): CyanError {
  const names = drifted.map(feature => `${feature.template}#${feature.name}`).join(', ');
  return new CyanError(
    problem(
      'validation',
      'probe_declared_feature_drift',
      `The repo's persisted .cyan_state.yaml records declared features that re-deriving the --template's install ` +
        `no longer produces: ${names}. The template's feature declarations have drifted since this repo was ` +
        `generated, so declaration mode can no longer safely scope the repo's recorded promises — refusing to run ` +
        `a silently smaller matrix. Restore the template the repo was generated from, regenerate the repo ` +
        `(cyanprint update) so its state matches the current template, or debug with an explicit source: ` +
        `cyanprint probe <repo> --probes <dir> --features <file>.`,
      { templateRef, features: drifted },
    ),
  );
}

/** The install's features that are also in the persisted union, deterministically ordered. */
function intersectFeatures(
  union: ProbeFeatureIdentity[],
  installFeatures: ProbeFeatureIdentity[],
): ProbeFeatureIdentity[] {
  const unionKeys = new Set(union.map(featureIdentityKey));
  return sortFeatureIdentities(installFeatures.filter(feature => unionKeys.has(featureIdentityKey(feature))));
}
