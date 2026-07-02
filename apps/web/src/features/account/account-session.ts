import { cookies } from 'next/headers';
import { getCurrentUser, sessionCookieName, type AccountUser } from './token-service';

export type AccountSession = {
  session: string;
  user: AccountUser;
};

export async function getAccountSession(): Promise<AccountSession | undefined> {
  let cookieStore;
  try {
    cookieStore = await cookies();
  } catch {
    return undefined;
  }
  const session = cookieStore.get(sessionCookieName)?.value;
  if (!session) {
    return undefined;
  }
  try {
    const user = await getCurrentUser(session);
    return user ? { session, user } : undefined;
  } catch {
    return undefined;
  }
}
