'use client';

import { useState } from 'react';
import { Button } from '../../components/ui/button';

export function TokenForm() {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <form
      className="panel"
      onSubmit={async event => {
        event.preventDefault();
        setPending(true);
        setError('');
        setSecret('');
        const form = new FormData(event.currentTarget);
        try {
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: String(form.get('name') || 'default') }),
          });
          const body = (await response.json()) as { token?: string; error?: string };
          if (!response.ok || !body.token) {
            throw new Error(body.error ?? 'Unable to mint token.');
          }
          setSecret(body.token);
          window.dispatchEvent(new Event('cyanprint-token-changed'));
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Unable to mint token.');
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Mint token</h2>
      <input aria-label="Token name" name="name" placeholder="release-bot" />
      <Button disabled={pending} type="submit">
        {pending ? 'Creating...' : 'Create token'}
      </Button>
      {secret ? <code className="secret">{secret}</code> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
