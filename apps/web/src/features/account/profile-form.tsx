'use client';

import { useState } from 'react';
import { Button } from '../../components/ui/button';
import type { AccountUser } from './token-service';

export function ProfileForm({ user }: { user: AccountUser }) {
  if (user.handle) {
    return (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Public username</p>
            <h2>Publishing handle</h2>
          </div>
        </div>
        <dl className="facts">
          <dt>CyanPrint username</dt>
          <dd>{user.handle}</dd>
        </dl>
        <p className="field-help">Usernames are permanent and cannot be changed.</p>
      </div>
    );
  }
  return <ChooseUsernameForm />;
}

function ChooseUsernameForm() {
  const [handle, setHandle] = useState('');
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
            throw new Error(body.error ?? 'Unable to set username.');
          }
          setMessage('Username set. Refreshing session...');
          window.location.reload();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Unable to set username.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Public username</p>
          <h2>Choose your username</h2>
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
      <p className="field-help">
        Used as your artifact owner namespace. Choose carefully &mdash; this cannot be changed later. You must set a
        username before you can publish.
      </p>
      <div className="inline-actions">
        <Button disabled={pending || !handle} type="submit">
          {pending ? 'Saving...' : 'Set username'}
        </Button>
      </div>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
