import { expect, test } from 'bun:test';
import type {
  Probe,
  ProbeCtx,
  ProbeDefinition,
  ProbeExecResult,
  ProbeFeatureIdentity,
  ProbeRepo,
  ProbeSandboxConfig,
  ProbeSetupConfig,
  ProbeVerdict,
  PROBE_CONTRACT_VERSION as CANONICAL_VERSION_TYPE,
} from '@cyanprint/contracts';
import { PROBE_CONTRACT_VERSION } from '@cyanprint/contracts';
import type * as Vendored from './probe-contract-types';

// FR19 — the vendored probe contract (`probe-contract-types.ts`, emitted into
// scaffolded template projects as `types/cyanprint-probe.d.ts`) must stay
// assignability-identical to the canonical `@cyanprint/contracts` probe types.
// These are COMPILE-TIME assertions: any drift between the two declarations
// fails `bun run typecheck` (and this suite), not just a human review.

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const parity: {
  verdict: MutuallyAssignable<ProbeVerdict, Vendored.ProbeVerdict>;
  execResult: MutuallyAssignable<ProbeExecResult, Vendored.ProbeExecResult>;
  repo: MutuallyAssignable<ProbeRepo, Vendored.ProbeRepo>;
  featureIdentity: MutuallyAssignable<ProbeFeatureIdentity, Vendored.ProbeFeatureIdentity>;
  ctx: MutuallyAssignable<ProbeCtx, Vendored.ProbeCtx>;
  probe: MutuallyAssignable<Probe, Vendored.Probe>;
  sandboxConfig: MutuallyAssignable<ProbeSandboxConfig, Vendored.ProbeSandboxConfig>;
  setupConfig: MutuallyAssignable<ProbeSetupConfig, Vendored.ProbeSetupConfig>;
  definition: MutuallyAssignable<ProbeDefinition, Vendored.ProbeDefinition>;
  contractVersion: MutuallyAssignable<typeof CANONICAL_VERSION_TYPE, typeof Vendored.PROBE_CONTRACT_VERSION>;
} = {
  verdict: true,
  execResult: true,
  repo: true,
  featureIdentity: true,
  ctx: true,
  probe: true,
  sandboxConfig: true,
  setupConfig: true,
  definition: true,
  contractVersion: true,
};

test('vendored probe contract types are mutually assignable with @cyanprint/contracts', () => {
  // Arrange: the `parity` table above is the subject — a compile-time witness that
  // every vendored type is mutually assignable with its canonical counterpart.

  // Act
  // Collapse the witness table to a single runtime boolean; any type drift would
  // already have made a witness `never` and failed typecheck before this runs.
  const allAssignable = Object.values(parity).every(Boolean);

  // Assert
  expect(allAssignable).toBe(true);
  // The vendored version pins the literal the engine serves today.
  expect(PROBE_CONTRACT_VERSION).toBe(1);
});
