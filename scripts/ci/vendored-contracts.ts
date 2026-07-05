// Single source of truth for the vendored type contracts that ship inside
// generated projects (`@cyanprint/sdk` for artifact authoring, `@cyanprint/probe`
// for probe authoring — FR19). Both the emitter (`emit-sdk-types.ts`) and the
// parity gate (`package-check.ts`) import this, so the roots and the EXACT
// per-root vendored file locations can never drift between the two scripts —
// the emitter and the checker share one source of truth.
//
// Each contract enumerates its vendored destinations EXPLICITLY (not by glob):
// glob-based discovery only ever touches files that already exist, so a deleted
// copy silently passes an aggregate count and is never re-emitted. Listing the
// expected paths turns "a copy is missing from one root" into a hard failure
// (package-check) and a guaranteed re-creation (emit) — per-root enforcement,
// not an aggregate counter (FR19/NFC3: BOTH meta-template copies pipeline-enforced).

/** The two meta-template copies that must stay in lockstep. */
export const VENDORED_ROOTS = ['in-tree/official/templates/new', 'examples/templates/new'];

export type VendoredContract = {
  /** Package name the generated project imports the types from. */
  name: string;
  /** In-repo source of truth, copied verbatim into every vendored destination. */
  source: string;
  /**
   * Every vendored destination, relative to each root in {@link VENDORED_ROOTS}.
   * Both the source `template/` copy and its `expected/` snapshot are listed so a
   * missing copy in either is caught per-root.
   */
  vendored: string[];
};

export const VENDORED_CONTRACTS: VendoredContract[] = [
  {
    name: '@cyanprint/sdk',
    source: 'packages/artifact-runner/src/sdk-types.ts',
    // Artifact authoring surfaces: plugin / processor / resolver kinds.
    vendored: [
      'template/plugin/types/cyanprint-sdk.d.ts',
      'template/processor/types/cyanprint-sdk.d.ts',
      'template/resolver/types/cyanprint-sdk.d.ts',
      'expected/plugin/types/cyanprint-sdk.d.ts',
      'expected/processor/types/cyanprint-sdk.d.ts',
      'expected/resolver/types/cyanprint-sdk.d.ts',
    ],
  },
  {
    name: '@cyanprint/probe',
    source: 'packages/core/src/probe/probe-contract-types.ts',
    // Probe authoring is a template concern only — one destination per root.
    vendored: ['template/template/types/cyanprint-probe.d.ts', 'expected/template/types/cyanprint-probe.d.ts'],
  },
];
