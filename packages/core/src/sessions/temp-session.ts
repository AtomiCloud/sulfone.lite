import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeEngineRunDir } from '@cyanprint/contracts/run-dir';

export type TempSession = {
  path: string;
  cleanup(): Promise<void>;
};

export async function createTempSession(): Promise<TempSession> {
  const path = await makeEngineRunDir('cyanprint-session');
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export async function withTempSession<T>(fn: (session: TempSession) => Promise<T>): Promise<T> {
  const session = await createTempSession();
  try {
    return await fn(session);
  } finally {
    await session.cleanup();
  }
}
