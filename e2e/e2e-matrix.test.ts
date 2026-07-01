import { expect, test } from 'bun:test';

type MatrixCase = {
  id: number;
  requiredCase: string;
  status: string;
  owningCoverage: string;
};

type CaseDetail = {
  command: string;
  fixtures: string;
};

const caseDetails: Record<number, CaseDetail> = {
  1: {
    command: 'cyan create examples/templates/hello --headless --answers examples/templates/hello/answers.json',
    fixtures: 'examples/templates/hello',
  },
  2: {
    command: 'createProject(<all-prompt-types fixture>)',
    fixtures: 'temp all-prompt template fixture in packages/core/src/core.test.ts',
  },
  3: {
    command: 'cyan create examples/template-groups/basic --answers examples/template-groups/basic/answers.json',
    fixtures: 'examples/template-groups/basic, examples/templates/hello, examples/templates/with-artifacts',
  },
  4: {
    command: 'cyan create cyanprint/with-artifacts --registry <local-worker>',
    fixtures: 'examples/templates/with-artifacts, processor-default, plugin-footer, resolver-keep-user',
  },
  5: {
    command: 'cyan update <project> --template cyanprint/update-example --registry <local-worker>',
    fixtures: 'examples/templates/update-v1, examples/templates/update-v2',
  },
  6: {
    command: 'updateProject(template-resolver-1 -> template-resolver-2)',
    fixtures: 'examples/templates/template-resolver-1, examples/templates/template-resolver-2',
  },
  7: {
    command: 'cyan update <edited-project> --template examples/templates/update-v2',
    fixtures: 'examples/templates/update-v1, examples/templates/update-v2',
  },
  8: {
    command: 'cyan update <project> --template cyanprint/template-resolver-2 --registry <local-worker>',
    fixtures: 'examples/templates/template-resolver-1, examples/templates/template-resolver-2',
  },
  9: {
    command: 'createProject(<same-layer resolver group>) + updateProject(template-resolver-1 -> template-resolver-2)',
    fixtures: 'same-path temp fixtures, template-resolver-1, template-resolver-2',
  },
  10: {
    command:
      'cyan create cyanprint/basic-group --answers examples/template-groups/basic/answers.json + runTemplateTest(<inline deterministicState>) + updateProject(<prior deterministicState>)',
    fixtures:
      'examples/template-groups/basic child preset answers; core inline deterministic state and update reuse fixtures',
  },
  11: {
    command: 'createProject(<multiple scoped processors fixture>)',
    fixtures: 'temp processor-default scoped processor fixture',
  },
  12: {
    command: 'createProject(<same-path matching resolver fixture>)',
    fixtures: 'temp same-a/same-b templates with cyanprint/merge-a',
  },
  13: {
    command: 'createProject(<same-path no-resolver fixture>)',
    fixtures: 'temp same-a/same-b templates',
  },
  14: {
    command: 'createProject(<same-path different-resolver fixture>)',
    fixtures: 'temp same-a/same-b templates with cyanprint/merge-a and cyanprint/merge-b',
  },
  15: {
    command: 'createProject(<same resolver different config fixture>)',
    fixtures: 'temp same-b/same-c templates with cyanprint/merge-b config mismatch',
  },
  16: {
    command: 'createProject(<same resolver same config fixture>)',
    fixtures: 'temp same-a/same-b templates with cyanprint/merge-a same config',
  },
  17: {
    command: 'createProject(<resolver subset plus no-resolver fixture>)',
    fixtures: 'temp same-a/same-b resolver pair plus same-c no resolver',
  },
  18: {
    command: 'createProject(<different resolver groups fixture>)',
    fixtures: 'temp merge-a pair plus merge-b pair',
  },
  19: {
    command: 'cyan try examples/templates/hello',
    fixtures: 'examples/templates/hello',
  },
  20: {
    command: 'cyan try cyanprint/with-artifacts --registry <local-worker>',
    fixtures: 'examples/templates/with-artifacts with processor/plugin/resolver dependencies',
  },
  21: {
    command: 'cyanprint test examples/artifacts/processor-uppercase',
    fixtures: 'examples/artifacts/processor-uppercase/tests/basic',
  },
  22: {
    command: 'cyanprint test examples/artifacts/processor-default',
    fixtures: 'examples/artifacts/processor-default/cyan.test.yaml validations',
  },
  23: {
    command: 'cyanprint test examples/artifacts/plugin-footer',
    fixtures: 'examples/artifacts/plugin-footer/tests/basic',
  },
  24: {
    command: 'cyanprint test examples/artifacts/plugin-footer',
    fixtures: 'examples/artifacts/plugin-footer/cyan.test.yaml validations',
  },
  25: {
    command: 'cyanprint test examples/artifacts/resolver-keep-user',
    fixtures: 'examples/artifacts/resolver-keep-user/tests/current-wins and folder-current-wins',
  },
  26: {
    command:
      'cyanprint test examples/templates/with-artifacts --answers examples/templates/with-artifacts/answers.json',
    fixtures: 'examples/templates/with-artifacts/expected/basic',
  },
  27: {
    command:
      'cyanprint test examples/templates/with-artifacts --answers examples/templates/with-artifacts/answers.json',
    fixtures: 'examples/templates/with-artifacts/cyan.test.yaml validations',
  },
  28: {
    command: 'cyan push examples/templates/{new,workspace,nix,with-artifacts} --registry <local-worker>',
    fixtures: 'examples/templates/new, workspace, nix, with-artifacts',
  },
  29: {
    command: 'cyan push examples/templates/with-artifacts twice --registry <local-worker>',
    fixtures: 'examples/templates/with-artifacts',
  },
  30: {
    command: 'cyan push examples/artifacts/plugin-footer --registry <local-worker>',
    fixtures: 'examples/artifacts/plugin-footer',
  },
  31: {
    command: 'cyan push examples/artifacts/plugin-footer twice --registry <local-worker>',
    fixtures: 'examples/artifacts/plugin-footer',
  },
  32: {
    command: 'cyan push examples/artifacts/processor-{default,uppercase} --registry <local-worker>',
    fixtures: 'examples/artifacts/processor-default, processor-uppercase',
  },
  33: {
    command: 'cyan push examples/artifacts/processor-default twice --registry <local-worker>',
    fixtures: 'examples/artifacts/processor-default',
  },
  34: {
    command: 'cyan push examples/artifacts/resolver-keep-user --registry <local-worker>',
    fixtures: 'examples/artifacts/resolver-keep-user',
  },
  35: {
    command: 'cyan push examples/artifacts/resolver-keep-user twice --registry <local-worker>',
    fixtures: 'examples/artifacts/resolver-keep-user',
  },
  36: {
    command: 'cyan create cyanprint/tri-suite@1, then cyan update <project> --template cyanprint/tri-suite',
    fixtures: 'temp tri-a, tri-b, tri-c templates with cyanprint/tri-merge resolver v1 -> v2',
  },
};

function parseMatrix(markdown: string): MatrixCase[] {
  return markdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\|\s*\d+\s*\|/.test(line))
    .map(line => {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map(cell => cell.trim());
      const [id, requiredCase, status, owningCoverage] = cells;
      if (!id || !requiredCase || !status || !owningCoverage) {
        throw new Error(`Malformed e2e.md matrix row: ${line}`);
      }
      return {
        id: Number(id),
        requiredCase,
        status,
        owningCoverage,
      };
    });
}

const matrix = parseMatrix(await Bun.file('e2e.md').text());

function requireDetail(id: number): CaseDetail {
  const detail = caseDetails[id];
  if (!detail) {
    throw new Error(`Missing e2e command/fixture details for case ${id}.`);
  }
  return detail;
}

test('e2e.md lists the complete 36-case parity matrix in order', () => {
  expect(matrix).toHaveLength(36);
  expect(matrix.map(entry => entry.id)).toEqual(Array.from({ length: 36 }, (_, index) => index + 1));
  expect(
    Object.keys(caseDetails)
      .map(Number)
      .sort((a, b) => a - b),
  ).toEqual(matrix.map(entry => entry.id));
});

for (const entry of matrix) {
  const detail = requireDetail(entry.id);
  test(`e2e case ${entry.id}: ${entry.requiredCase} | command: ${detail.command} | fixtures: ${detail.fixtures}`, () => {
    expect(entry.status).toBe('covered');
    expect(entry.owningCoverage.length).toBeGreaterThan(0);
    expect(detail.command.length).toBeGreaterThan(0);
    expect(detail.fixtures.length).toBeGreaterThan(0);
  });
}
