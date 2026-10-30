import type { ArtifactVersion } from '@cyanprint/contracts';
import { listLatestRegistryArtifacts } from '../registry/registry-data';

export async function loadShellArtifacts(): Promise<{ artifacts: ArtifactVersion[]; registryUnavailable: boolean }> {
  try {
    return { artifacts: await listLatestRegistryArtifacts(), registryUnavailable: false };
  } catch (error) {
    console.error('registry unavailable, rendering without catalog', error);
    return { artifacts: [], registryUnavailable: true };
  }
}
