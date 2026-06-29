import { artifactKinds, RegistryClient } from '@cyanprint/registry-client';
import { parseFlags, flagBool, flagString } from '../args';
import { info, kv, pathLabel, printJson, printSection, success } from '../ui';

const VALID_KINDS = new Set<string>(artifactKinds.filter(kind => kind !== 'all'));

export async function searchCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const query = positional[0] ?? flagString(flags, 'query') ?? '';
  const registry = flagString(flags, 'registry', 'http://127.0.0.1:8787') ?? 'http://127.0.0.1:8787';
  const kind = flagString(flags, 'kind');
  const limit = Number(flagString(flags, 'limit', '20'));
  const json = flagBool(flags, 'json');
  if (kind && !VALID_KINDS.has(kind)) {
    throw new Error(`search --kind must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('search --limit must be a positive integer.');
  }

  if (!json) {
    console.log(info(`searching ${pathLabel(registry)}`));
  }
  const result = await new RegistryClient(registry).search({ kind, query, limit });
  const artifacts = result.artifacts;
  const report = { query, kind: kind ?? 'all', registry, artifacts };

  if (json) {
    printJson(report);
    return;
  }

  console.log(success(`found ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`));
  printSection(
    'Artifacts',
    artifacts.length === 0
      ? ['no matches']
      : artifacts.map(artifact =>
          [
            kv('ref', `${artifact.owner}/${artifact.name}@${artifact.version}`),
            kv('kind', artifact.kind),
            kv('downloads', artifact.downloads),
          ].join('\n  '),
        ),
  );
}
