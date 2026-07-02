'use client';

import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';

type Token = {
  id: string;
  name: string;
  revoked?: boolean;
};

export function TokenList() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [error, setError] = useState('');

  async function loadTokens() {
    setError('');
    try {
      const response = await fetch('/api/tokens', { cache: 'no-store' });
      const body = (await response.json()) as { tokens?: Token[]; error?: string };
      if (!response.ok || !body.tokens) {
        throw new Error(body.error ?? 'Unable to load tokens.');
      }
      setTokens(body.tokens);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load tokens.');
    }
  }

  async function revoke(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/tokens/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Unable to revoke token.');
      }
      await loadTokens();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to revoke token.');
    }
  }

  useEffect(() => {
    void loadTokens();
    window.addEventListener('cyanprint-token-changed', loadTokens);
    return () => window.removeEventListener('cyanprint-token-changed', loadTokens);
  }, []);

  return (
    <div className="panel">
      <h2>Issued tokens</h2>
      <form
        className="inline-form"
        onSubmit={event => {
          event.preventDefault();
          void loadTokens();
        }}
      >
        <Button tone="secondary" type="submit">
          Refresh
        </Button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Secret</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 ? (
            <tr>
              <td colSpan={4}>No tokens issued.</td>
            </tr>
          ) : (
            tokens.map(token => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{token.revoked ? 'revoked' : 'active'}</td>
                <td>redacted</td>
                <td>
                  <Button tone="secondary" disabled={token.revoked} onClick={() => void revoke(token.id)} type="button">
                    Revoke
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
