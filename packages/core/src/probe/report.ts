import type { ProbeRunReport } from '@cyanprint/contracts';

/**
 * Per-verdict counts for a probe run, plus the report itself. A generic
 * probe-domain reducer used by BOTH the standalone `cyanprint probe` command
 * and the `probe: true` test tier — it is not template-test-specific, so it
 * lives here rather than in the testing module, letting both entry points share
 * one reducer.
 */
export type ProbeReportSummary = {
  proven: number;
  caught: number;
  missed: number;
  invalid: number;
  broken: number;
  report: ProbeRunReport;
};

/** Count each probe's verdict across the report, carrying the report through. */
export function summarizeProbeReport(report: ProbeRunReport): ProbeReportSummary {
  const summary: ProbeReportSummary = { proven: 0, caught: 0, missed: 0, invalid: 0, broken: 0, report };
  for (const feature of report.features) {
    for (const probe of feature.probes) {
      summary[probe.verdict] += 1;
    }
  }
  return summary;
}
