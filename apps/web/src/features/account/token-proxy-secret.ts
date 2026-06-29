'use client';

const storageKey = 'cyanprint.webTokenProxySecret';

export function saveTokenProxySecret(secret: string): void {
  const value = secret.trim();
  if (value) {
    window.localStorage.setItem(storageKey, value);
  }
}

export function tokenProxyHeaders(extra?: HeadersInit): HeadersInit {
  return {
    ...extra,
    'x-cyanprint-web-token-secret': window.localStorage.getItem(storageKey) ?? '',
  };
}
