'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ArtifactVersion } from '@cyanprint/contracts';
import {
  ChevronDown,
  FileText,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings2,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FocusEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/cn';
import { AccountUserProvider } from '../account/account-context';
import type { AccountUser } from '../account/token-service';
import { artifactKinds, filterArtifacts, normalizeArtifactKind } from '../registry/artifact-search';
import { artifactDetailHref } from '../registry/artifact-url';
import { useUrlState } from './url-state';

const navItems = [
  { href: '/search', label: 'Search', icon: Search },
  { href: '/docs/user/quickstart', label: 'Docs', icon: FileText },
];

export function AppShell({
  artifacts,
  children,
  user,
}: {
  artifacts: ArtifactVersion[];
  children: ReactNode;
  user?: AccountUser;
}) {
  const router = useRouter();
  const deferredNavigation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigateWithoutScroll = useCallback(
    (url: string, navigation?: { defer?: boolean }) => {
      if (deferredNavigation.current) {
        clearTimeout(deferredNavigation.current);
      }
      if (navigation?.defer) {
        deferredNavigation.current = setTimeout(() => {
          router.replace(url, { scroll: false });
        }, 120);
        return;
      }
      router.replace(url, { scroll: false });
    },
    [router],
  );
  const { pathname, params, update } = useUrlState({
    onNavigate: navigateWithoutScroll,
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(params.get('q') ?? '');
  const [searchResults, setSearchResults] = useState(artifacts);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [themePreferenceReady, setThemePreferenceReady] = useState(false);
  const [storedTheme, setStoredTheme] = useState<'dark' | 'light'>('light');
  const pathKind = normalizeArtifactKind(kindFromPath(pathname));
  const kind = params.has('kind') ? normalizeArtifactKind(params.get('kind'), pathKind) : pathKind;
  const hasThemeParam = params.has('theme');
  const theme = hasThemeParam ? (params.get('theme') === 'dark' ? 'dark' : 'light') : storedTheme;

  useEffect(() => {
    document.documentElement.dataset.cyanprintShell = 'ready';
    return () => {
      if (deferredNavigation.current) {
        clearTimeout(deferredNavigation.current);
      }
      delete document.documentElement.dataset.cyanprintShell;
    };
  }, []);

  useEffect(() => {
    setSearchDraft(params.get('q') ?? '');
  }, [params]);

  useEffect(() => {
    if (themePreferenceReady) {
      return;
    }
    const savedTheme = hasThemeParam
      ? params.get('theme') === 'dark'
        ? 'dark'
        : 'light'
      : window.localStorage.getItem('cyanprint-theme') === 'dark'
        ? 'dark'
        : 'light';
    setStoredTheme(savedTheme);
    if (!hasThemeParam) {
      updateState({ theme: savedTheme });
    }
    setThemePreferenceReady(true);
  }, [hasThemeParam, params, themePreferenceReady]);

  useEffect(() => {
    if (!themePreferenceReady || hasThemeParam || storedTheme !== 'dark') {
      return;
    }
    updateState({ theme: 'dark' });
  }, [hasThemeParam, pathname, storedTheme, themePreferenceReady]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    if (!themePreferenceReady) {
      return;
    }
    setStoredTheme(theme);
    window.localStorage.setItem('cyanprint-theme', theme);
  }, [theme, themePreferenceReady]);

  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams();
    search.set('limit', '8');
    if (searchDraft) {
      search.set('q', searchDraft);
    }
    if (kind !== 'all') {
      search.set('kind', kind);
    }
    fetch(`/api/artifacts/search?${search.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json() as Promise<{ artifacts: ArtifactVersion[]; nextCursor?: string }>;
      })
      .then(page => {
        setSearchResults(page.artifacts);
        setSearchHasMore(Boolean(page.nextCursor));
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setSearchResults(filterArtifacts(artifacts, { query: searchDraft, kind }));
        setSearchHasMore(false);
      });
    return () => controller.abort();
  }, [artifacts, searchDraft, kind]);

  function updateState(
    next: { q?: string; kind?: string; theme?: string; cursor?: string },
    navigation?: { defer?: boolean },
  ) {
    update(next, navigation);
  }

  function updateSearchState(next: { q?: string; kind?: string }, navigation?: { defer?: boolean }) {
    const search = new URLSearchParams(params.toString());
    if (!search.has('kind') && kind !== 'all') {
      search.set('kind', kind);
    }
    for (const [key, value] of Object.entries(next)) {
      if (!value || (key === 'kind' && value === 'all')) {
        search.delete(key);
      } else {
        search.set(key, value);
      }
    }
    search.delete('cursor');
    const queryString = search.toString();
    navigateWithoutScroll(`/search${queryString ? `?${queryString}` : ''}`, navigation);
  }

  function setThemePreference(nextTheme: 'dark' | 'light') {
    setStoredTheme(nextTheme);
    window.localStorage.setItem('cyanprint-theme', nextTheme);
    updateState({ theme: nextTheme });
  }

  function handleSearchBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setSearchOpen(false);
    }
  }

  return (
    <>
      <AccountUserProvider user={user}>
        <header className="shell-header">
          <Link className="brand" href="/">
            <Image alt="CyanPrint" height={38} src="/logo/cyanprint-logo.svg" width={38} priority />
            <span>CyanPrint</span>
          </Link>

          <div
            className="top-search"
            onBlur={handleSearchBlur}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setSearchOpen(false);
              }
            }}
            role="search"
          >
            <Search aria-hidden="true" size={18} />
            <input
              aria-label="Search registry"
              onChange={event => {
                const value = event.currentTarget.value;
                setSearchDraft(value);
                updateSearchState({ q: value }, { defer: true });
              }}
              placeholder="Search the registry"
              value={searchDraft}
            />
            <ArtifactKindDropdown
              kind={artifactKinds.includes(kind as (typeof artifactKinds)[number]) ? kind : 'all'}
              onChange={nextKind => updateSearchState({ kind: nextKind })}
            />
            {searchOpen && (searchDraft || kind !== 'all') ? (
              <div aria-label="Search results" className="search-popover" data-testid="search-results" role="region">
                <div className="search-popover-head">
                  <span aria-live="polite">
                    {searchResults.length}
                    {searchHasMore ? '+' : ''} matches
                  </span>
                  <Link href={searchHref(params, kind)}>Open search</Link>
                </div>
                {searchResults.map(artifact => (
                  <Link
                    className="search-result"
                    data-testid="search-result"
                    href={artifactDetailHref(artifact, params)}
                    key={artifact.id}
                  >
                    <Badge>{artifact.kind}</Badge>
                    <span>
                      {artifact.owner}/{artifact.name}
                    </span>
                    <small>v{artifact.version}</small>
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <nav
            className={cn('shell-nav', mobileOpen && 'open')}
            aria-label="Primary"
            data-testid="primary-nav"
            id="primary-navigation"
          >
            {navItems.map(item => (
              <Link key={item.href} href={withNavQuery(item.href, params)}>
                <item.icon aria-hidden="true" size={16} />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="shell-actions">
            <button
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              className="icon-button"
              onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
              type="button"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <AccountControl user={user} />
            <button
              aria-controls="primary-navigation"
              aria-expanded={mobileOpen}
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
              className="icon-button mobile-menu"
              onClick={() => setMobileOpen(value => !value)}
              type="button"
            >
              {mobileOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </header>
        <main>{children}</main>
      </AccountUserProvider>
    </>
  );
}

function ArtifactKindDropdown({ kind, onChange }: { kind: string; onChange: (kind: string) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="kind-trigger" aria-label="Artifact kind filter">
        <span>{kindLabel(kind)}</span>
        <ChevronDown aria-hidden="true" size={15} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="kind-menu" sideOffset={10}>
          {artifactKinds.map(item => (
            <DropdownMenu.Item
              className={cn('menu-item', item === kind && 'selected')}
              key={item}
              onSelect={() => onChange(item)}
            >
              {kindLabel(item)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AccountControl({ user }: { user?: AccountUser }) {
  if (!user) {
    return (
      <Link className="sign-in-button" href="/login" prefetch={false}>
        <UserRound aria-hidden="true" size={16} />
        Sign in
      </Link>
    );
  }

  const displayName = user.handle ?? user.login ?? 'New account';
  const initials = displayName.slice(0, 2).toUpperCase();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label="Open account menu" className="profile-trigger">
        <span className="avatar">{initials}</span>
        <span className="profile-copy">
          <strong>{displayName}</strong>
          <small>{user.login ? `@${user.login}` : 'local account'}</small>
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="profile-menu" data-testid="account-menu" sideOffset={10}>
          <DropdownMenu.Label className="profile-menu-label">
            <span className="avatar large">{initials}</span>
            <span>
              <strong>{displayName}</strong>
              <small>{user.login ? `GitHub @${user.login}` : 'CyanPrint account'}</small>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item asChild className="menu-item">
            <Link href="/account">
              <Settings2 aria-hidden="true" size={16} />
              Account settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="menu-item">
            <Link href="/account/tokens">
              <KeyRound aria-hidden="true" size={16} />
              API tokens
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <form action="/logout" method="post">
            <DropdownMenu.Item asChild className="menu-item danger">
              <button className="menu-button" type="submit">
                <LogOut aria-hidden="true" size={16} />
                Sign out
              </button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function kindFromPath(pathname: string): string {
  const match = pathname.match(/^\/artifacts\/([^/]+)/);
  return match?.[1] ?? 'all';
}

function withNavQuery(href: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params.toString());
  next.delete('cursor');
  const query = next.toString();
  return query ? `${href}?${query}` : href;
}

function searchHref(params: URLSearchParams, kind: string): string {
  const next = new URLSearchParams(params.toString());
  if (kind === 'all') {
    next.delete('kind');
  } else {
    next.set('kind', kind);
  }
  next.delete('cursor');
  const query = next.toString();
  return query ? `/search?${query}` : '/search';
}

function kindLabel(kind: string): string {
  if (kind === 'all') {
    return 'All';
  }
  if (kind === 'template-group') {
    return 'Groups';
  }
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`;
}
