'use client';

import { ButtonLink } from '../../components/ui/button';
import { useShellAccountUser } from './account-context';
import { ProfileForm } from './profile-form';
import type { AccountUser } from './token-service';

export function AccountPanel({ error, serverUser }: { error?: string; serverUser?: AccountUser }) {
  const user = useShellAccountUser() ?? serverUser;
  return (
    <>
      <div className="panel">
        <h2>Session</h2>
        <dl className="facts">
          <dt>User</dt>
          <dd>{user ? (user.handle ?? 'No username chosen yet') : 'Not signed in'}</dd>
          <dt>GitHub</dt>
          <dd>{user?.login ? `@${user.login}` : user ? 'Local account' : 'Not connected'}</dd>
          <dt>Role</dt>
          <dd>{user?.admin ? 'Admin publisher' : user ? 'Publisher' : 'Guest'}</dd>
        </dl>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {user ? (
          <div className="inline-actions">
            <ButtonLink href="/account/tokens">Manage tokens</ButtonLink>
            <form action="/logout" method="post">
              <button className="btn btn-secondary" type="submit">
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <ButtonLink href="/login" prefetch={false}>
            Sign in with GitHub
          </ButtonLink>
        )}
      </div>
      {user ? <ProfileForm user={user} /> : null}
    </>
  );
}
