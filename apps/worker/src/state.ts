import type { ArtifactVersion } from '@cyanprint/contracts';
import { seedArtifacts, seedObjectPayloads } from '@cyanprint/registry-client';
import { createCloudflareLocalStorage } from './storage/cloudflare-local-storage';

export const storage = createCloudflareLocalStorage(seedArtifacts satisfies ArtifactVersion[], seedObjectPayloads);
