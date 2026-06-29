'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ArtifactVersion } from '@cyanprint/contracts';
import {
  Boxes,
  ChevronDown,
  CircleUserRound,
  FileText,
  KeyRound,
  LayoutDashboard,
  Menu,
  Moon,
  Search,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FocusEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/cn';
import { artifactKinds, filterArtifacts, normalizeArtifactKind } from '../registry/artifact-search';
import { artifactDetailHref, artifactTypeHref } from '../registry/artifact-url';
import { useUrlState } from './url-state';

const navItems = [
  { href: '/artifacts/template', label: 'Templates', icon: Boxes },
  { href: '/artifacts/processor', label: 'Processors', icon: LayoutDashboard },
  { href: '/artifacts/plugin', label: 'Plugins', icon: ShieldCheck },
  { href: '/artifacts/resolver', label: 'Resolvers', icon: FileText },
  { href: '/docs/user/quickstart', label: 'Docs', icon: FileText },
];

export function AppShell({ artifacts, children }: { artifacts: ArtifactVersion[]; children: ReactNode }) {
  const router = useRouter();
  const deferredNavigation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigateWithoutScroll = useCallback(
    (url: string, navigation?: { defer?: boolean }) => {
      if (deferredNavigation.current) {
        clearTimeout(deferredNavigation.current);
      }
      if (navigation?.defer) {
        deferredNavigation.current = setTimeout(() => {
          const currentUrl = `${window.location.pathname}${window.location.search}`;
          if (currentUrl === url) {
            router.replace(url, { scroll: false });
          }
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
  const [searchResults, setSearchResults] = useState(artifacts);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [themePreferenceReady, setThemePreferenceReady] = useState(false);
  const [storedTheme, setStoredTheme] = useState<'dark' | 'light'>('light');
  const query = params.get('q') ?? '';
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
    if (query) {
      search.set('q', query);
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
        setSearchResults(filterArtifacts(artifacts, { query, kind }));
        setSearchHasMore(false);
      });
    return () => controller.abort();
  }, [artifacts, query, kind]);

  function updateState(
    next: { q?: string; kind?: string; theme?: string; cursor?: string },
    navigation?: { defer?: boolean },
  ) {
    update(next, navigation);
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
      <header className="shell-header">
        <Link className="brand" href="/">
          <Image alt="CyanPrint" height={38} src="/logo/cyanprint-logo.svg" width={38} priority />
          <span>CyanPrint v4</span>
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
            onChange={event => updateState({ q: event.currentTarget.value, cursor: undefined }, { defer: true })}
            placeholder="Search templates, processors, plugins, resolvers"
            value={query}
          />
          <select
            aria-label="Artifact kind"
            onChange={event => updateState({ kind: event.currentTarget.value, cursor: undefined })}
            value={artifactKinds.includes(kind as (typeof artifactKinds)[number]) ? kind : 'all'}
          >
            {artifactKinds.map(item => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          {searchOpen && (query || kind !== 'all') && (
            <div aria-label="Search results" className="search-popover" data-testid="search-results" role="region">
              <div className="search-popover-head">
                <span aria-live="polite">
                  {searchResults.length}
                  {searchHasMore ? '+' : ''} matches
                </span>
                <Link href={artifactTypeHref(kind === 'all' ? 'template' : kind, ensureExplicitKind(params, kind))}>
                  Open
                </Link>
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
          )}
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
          <AccountDropdown />
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
    </>
  );
}

function AccountDropdown() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label="Open account menu" className="profile-trigger">
        <span className="avatar">CP</span>
        <span className="profile-copy">
          <strong>Local Owner</strong>
          <small>publisher workspace</small>
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="profile-menu" data-testid="account-menu" sideOffset={10}>
          <DropdownMenu.Label className="profile-menu-label">
            <CircleUserRound aria-hidden="true" size={18} />
            <span>
              <strong>local</strong>
              <small>admin owner</small>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item asChild className="menu-item">
            <Link href="/account">
              <CircleUserRound aria-hidden="true" size={16} />
              Personal info
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="menu-item">
            <Link href="/account/tokens">
              <KeyRound aria-hidden="true" size={16} />
              API tokens
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="menu-item">
            <Link href="/admin">
              <ShieldCheck aria-hidden="true" size={16} />
              Admin review
            </Link>
          </DropdownMenu.Item>
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
  const artifactKind = artifactKindFromHref(href);
  if (artifactKind) {
    next.set('kind', artifactKind);
    next.delete('cursor');
  } else if (!href.startsWith('/artifacts/')) {
    next.delete('cursor');
  }
  const query = next.toString();
  return query ? `${href}?${query}` : href;
}

function artifactKindFromHref(href: string): string | undefined {
  const match = href.match(/^\/artifacts\/([^/?]+)/);
  return match?.[1];
}

function ensureExplicitKind(params: URLSearchParams, kind: string): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  if (kind === 'all') {
    next.set('kind', 'all');
  }
  next.delete('cursor');
  return next;
}
