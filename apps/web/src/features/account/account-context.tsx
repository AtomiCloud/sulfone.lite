'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { AccountUser } from './token-service';

const AccountUserContext = createContext<AccountUser | undefined>(undefined);

export function AccountUserProvider({ children, user }: { children: ReactNode; user?: AccountUser }) {
  return <AccountUserContext.Provider value={user}>{children}</AccountUserContext.Provider>;
}

export function useShellAccountUser(): AccountUser | undefined {
  return useContext(AccountUserContext);
}
