import { describe, expect, test } from 'bun:test';
import { artifactIntegrity } from '@cyanprint/contracts';
import { batchResolve, createLocalRegistryState, seedArtifacts, seedObjectPayloads } from './local-registry';

const textEncoder = new TextEncoder();

describe('local registry resolution', () => {
  test('does not resolve artifacts in review moderation state', () => {
    const state = createLocalRegistryState();
    state.artifacts.push({
      id: 'template_review',
      kind: 'template',
      owner: 'cyanprint',
      name: 'review',
      version: '4',
      readme: '',
      dependencies: [],
      resolvedPins: [],
      disabled: false,
      moderationState: 'review',
      downloads: 0,
      likes: 0,
    });

    const resolved = batchResolve(state, {
      refs: [{ kind: 'template', owner: 'cyanprint', name: 'review', version: '4' }],
    });

    expect(resolved.resolved).toEqual([]);
    expect(resolved.missing).toEqual([{ kind: 'template', owner: 'cyanprint', name: 'review', version: '4' }]);
  });

  test('seed object payloads match refs and resolved pin integrities', () => {
    const objectRefs = new Set<string>();
    for (const object of seedObjectPayloads) {
      expect(object.ref.sha256).toBe(Bun.CryptoHasher.hash('sha256', object.payload, 'hex'));
      const size =
        typeof object.payload === 'string' ? textEncoder.encode(object.payload).byteLength : object.payload.byteLength;
      expect(object.ref.size).toBe(size);
      objectRefs.add(`${object.ref.key}:${object.ref.sha256}:${object.ref.size}`);
    }

    for (const artifact of seedArtifacts) {
      for (const ref of [
        artifact.artifactObjects?.manifest,
        artifact.artifactObjects?.readme,
        artifact.artifactObjects?.bundle,
        artifact.artifactObjects?.archive,
      ]) {
        if (ref) {
          expect(objectRefs.has(`${ref.key}:${ref.sha256}:${ref.size}`)).toBe(true);
        }
      }
      for (const pin of artifact.resolvedPins) {
        const target = seedArtifacts.find(
          item =>
            item.kind === pin.kind &&
            item.owner === pin.owner &&
            item.name === pin.name &&
            item.version === pin.version,
        );
        if (!target) {
          throw new Error(`missing seed target for ${pin.kind}:${pin.owner}/${pin.name}@${pin.version}`);
        }
        expect(pin.integrity).toBe(artifactIntegrity(target));
      }
    }
  });
});
