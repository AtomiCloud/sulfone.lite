'use client';

import { useState } from 'react';
import { Button } from '../../components/ui/button';
import type { AccountUser } from './token-service';

export function ProfileForm({ user }: { user: AccountUser }) {
  const [handle, setHandle] = useState(user.handle);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  return (
    <form
      className="panel"
      onSubmit={async event => {
        event.preventDefault();
        setPending(true);
        setMessage('');
        setError('');
        try {
          const response = await fetch('/api/account', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle }),
          });
          const body = (await response.json().catch(() => ({}))) as { user?: AccountUser; error?: string };
          if (!response.ok || !body.user) {
            throw new Error(body.error ?? 'Unable to update username.');
          }
          setHandle(body.user.handle);
          setMessage('Username updated. Refreshing session...');
          window.location.reload();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Unable to update username.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Public username</p>
          <h2>Publishing handle</h2>
        </div>
      </div>
      <label className="field">
        <span>CyanPrint username</span>
        <input
          aria-label="CyanPrint username"
          autoComplete="username"
          maxLength={39}
          minLength={3}
          onChange={event => setHandle(event.target.value)}
          pattern="[A-Za-z0-9][A-Za-z0-9-]{2,38}"
          required
          value={handle}
        />
      </label>
      <p className="field-help">Used as your artifact owner namespace. GitHub still handles sign-in.</p>
      <div className="inline-actions">
        <Button disabled={pending || handle === user.handle} type="submit">
          {pending ? 'Saving...' : 'Save username'}
        </Button>
      </div>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
