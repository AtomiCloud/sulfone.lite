'use client';

import { ButtonLink } from '../../components/ui/button';
import { useShellAccountUser } from './account-context';
import { TokenForm } from './token-form';
import { TokenList } from './token-list';
import type { AccountUser } from './token-service';

export function TokensPanel({ serverUser }: { serverUser?: AccountUser }) {
  const user = useShellAccountUser() ?? serverUser;
  return user ? (
    <>
      <div className="panel">
        <h2>{user.handle ?? user.login ?? 'Your account'}</h2>
        <p className="lede">Mint scoped publishing credentials for `cyanprint push`.</p>
      </div>
      <TokenForm />
      <TokenList />
    </>
  ) : (
    <div className="panel">
      <h2>Sign in required</h2>
      <p className="lede">Use GitHub to mint, inspect, and revoke CyanPrint API tokens.</p>
      <ButtonLink href="/login" prefetch={false}>
        Sign in with GitHub
      </ButtonLink>
    </div>
  );
}
