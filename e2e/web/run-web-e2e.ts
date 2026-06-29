import { listRegistryArtifacts } from '../../apps/web/src/features/registry/registry-data';
import { MarkdownReadme } from '../../apps/web/src/features/artifacts/markdown-readme';
import { createApp } from '../../apps/worker/src/index';
import { createCloudflareLocalStorage } from '../../apps/worker/src/storage/cloudflare-local-storage';
import { seedArtifacts, seedObjectPayloads } from '@cyanprint/registry-client';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import HomePage from '../../apps/web/src/app/page';
import SearchPage from '../../apps/web/src/app/search/page';
import AccountPage from '../../apps/web/src/app/account/page';
import TokensPage from '../../apps/web/src/app/account/tokens/page';
import ArtifactTypePage from '../../apps/web/src/app/artifacts/[type]/page';
import ArtifactDetailPage from '../../apps/web/src/app/artifacts/[type]/[owner]/[name]/page';
import DocsPage from '../../apps/web/src/app/docs/[...slug]/page';

const spec = Bun.argv.slice(2).join(' ') || 'all';
const artifacts = await listRegistryArtifacts();
if (!artifacts.some(artifact => artifact.kind === 'template')) {
  throw new Error('web catalog data boundary returned no templates');
}
const unsafeReadmeHtml = await renderHtml(createElement(MarkdownReadme, { markdown: '# Safe\n\n<script>x</script>' }));
if (unsafeReadmeHtml.includes('<script>') || !unsafeReadmeHtml.includes('&lt;script&gt;')) {
  throw new Error('web README renderer content safety check failed');
}
if (!(await Bun.file('apps/web/public/logo/cyanprint-logo.svg').exists())) {
  throw new Error('logo artifact is missing');
}

type SpawnedWebServer = {
  exited: Promise<number>;
  stderr?: ReadableStream<Uint8Array> | null;
  stdout?: ReadableStream<Uint8Array> | null;
};

async function assertRendered(label: string, element: ReactNode | Promise<ReactNode>, expected: string): Promise<void> {
  const html = await renderHtml(element);
  if (!html.includes(expected)) {
    throw new Error(`${label} did not render expected content: ${expected}`);
  }
}

async function renderHtml(element: ReactNode | Promise<ReactNode>): Promise<string> {
  const stream = await renderToReadableStream(await Promise.resolve(element));
  await stream.allReady;
  return (await new Response(stream).text()).replaceAll(/<!--.*?-->/g, '');
}

await assertRendered('home page', HomePage(), 'CyanPrint');
await assertRendered('search page', SearchPage({ searchParams: Promise.resolve({}) }), 'Registry search');
await assertRendered(
  'artifact type page',
  ArtifactTypePage({ params: Promise.resolve({ type: 'template' }), searchParams: Promise.resolve({}) }),
  'templates',
);
await assertRendered(
  'artifact detail page',
  ArtifactDetailPage({ params: Promise.resolve({ type: 'template', owner: 'cyanprint', name: 'hello' }) }),
  'cyanprint/hello',
);
await assertRendered(
  'docs page',
  DocsPage({ params: Promise.resolve({ slug: ['user', 'quickstart'] }) }),
  'Quickstart',
);
await assertRendered('account page', AccountPage({ searchParams: Promise.resolve({}) }), 'Publishing identity');
const tokenPageHtml = await renderHtml(TokensPage());
for (const expected of ['Sign in required', 'Sign in with GitHub']) {
  if (!tokenPageHtml.includes(expected)) {
    throw new Error(`tokens page did not render expected control: ${expected}`);
  }
}

const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
const app = createApp(createCloudflareLocalStorage(seedArtifacts, seedObjectPayloads));
const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
let tokenRoutesVerified = false;
let shellInteractionsVerified = false;
try {
  process.env.CYANPRINT_REGISTRY_URL = server.url.toString().replace(/\/$/, '');
  const tokenRoute = await import('../../apps/web/src/app/api/tokens/route');
  const tokenByIdRoute = await import('../../apps/web/src/app/api/tokens/[id]/route');
  const denied = await tokenRoute.POST(
    new Request('http://cyanprint.local/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'denied' }),
    }),
  );
  if (denied.status !== 401) {
    throw new Error('web token route did not require a signed-in session');
  }
  const sessionResponse = await fetch(`${process.env.CYANPRINT_REGISTRY_URL}/auth/local-session`, {
    method: 'POST',
    headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
    body: JSON.stringify({ userId: 'user_local' }),
  });
  if (!sessionResponse.ok) {
    throw new Error('web token setup could not create a local registry session');
  }
  const session = ((await sessionResponse.json()) as { session: string }).session;
  const authHeaders = { cookie: `cyanprint_session=${encodeURIComponent(session)}` };
  const emptyList = (await tokenRoute.GET(new Request('http://cyanprint.local/api/tokens', { headers: authHeaders })))
    .status;
  if (emptyList !== 200) {
    throw new Error('web token list route failed before mint');
  }
  const minted = await tokenRoute.POST(
    new Request('http://cyanprint.local/api/tokens', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'web-e2e' }),
    }),
  );
  const mintedBody = (await minted.json()) as { id?: string; token?: string };
  if (minted.status !== 200 || !mintedBody.id || !mintedBody.token?.startsWith('cp4_')) {
    throw new Error('web token mint route did not return a real token');
  }
  const revoke = await tokenByIdRoute.DELETE(
    new Request(`http://cyanprint.local/api/tokens/${mintedBody.id}`, { headers: authHeaders }),
    {
      params: Promise.resolve({ id: mintedBody.id }),
    },
  );
  if (revoke.status !== 200) {
    throw new Error('web token revoke route failed');
  }
  tokenRoutesVerified = true;
} finally {
  server.stop(true);
}

await runBrowserShellE2e();
shellInteractionsVerified = true;

console.log(
  JSON.stringify({
    status: 'done',
    spec,
    catalogData: true,
    branding: true,
    contentSafety: true,
    tokenRoutesVerified,
    shellInteractionsVerified,
    renderedPages: true,
  }),
);

async function runBrowserShellE2e(): Promise<void> {
  const e2eBuildEnv = { CYANPRINT_NEXT_DIST_DIR: '.next-e2e' };
  await runCommand(['bun', 'run', '--filter', '@cyanprint/web', 'build'], e2eBuildEnv);
  const portServer = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = new URL(portServer.url).port;
  portServer.stop(true);

  const web = Bun.spawn(
    ['bun', 'run', '--filter', '@cyanprint/web', 'start', '--hostname', '127.0.0.1', '--port', port],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CYANPRINT_REGISTRY_URL: '', ...e2eBuildEnv },
    },
  );
  const webLogs = captureProcessOutput(web);
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  try {
    await waitForHttpOrExit(baseUrl, web, webLogs);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 390, height: 820 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.dataset.cyanprintShell === 'ready');
    await assertLandingLayout(page, 'initial mobile landing');

    const search = page.getByLabel('Search registry');
    await search.click();
    await search.pressSequentially('resolver');
    await waitForUrlParam(page, 'q', 'resolver');
    await waitForPathname(page, '/search');
    await page.getByLabel('Artifact kind filter').click();
    await page.getByRole('menuitem', { name: 'Resolvers' }).click();
    await waitForUrlParam(page, 'kind', 'resolver');
    await page.getByTestId('search-result').first().waitFor();
    await assertBoxInsideViewport(page, '[data-testid="search-results"]', 'search results popover');
    const searchText = await page.getByTestId('search-results').textContent();
    if (!searchText?.includes('keep-user')) {
      throw new Error('browser search did not live-render resolver results.');
    }

    const signIn = page.getByRole('link', { name: 'Sign in' });
    await signIn.waitFor();
    if ((await page.getByTestId('account-menu').count()) !== 0) {
      throw new Error('signed-out shell still renders an account dropdown.');
    }

    await page.getByLabel('Open navigation').click();
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Search' }).waitFor();
    if (
      (await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Templates' }).count()) !== 0
    ) {
      throw new Error('primary nav still exposes artifact tab links.');
    }
    await assertBoxInsideViewport(page, '[data-testid="primary-nav"]', 'mobile navigation');

    await page.getByLabel('Switch to dark mode').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await waitForUrlParam(page, 'theme', 'dark');
    const storedTheme = await page.evaluate(() => window.localStorage.getItem('cyanprint-theme'));
    if (storedTheme !== 'dark') {
      throw new Error('theme switch did not persist dark preference.');
    }
    await page.getByLabel('Switch to light mode').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    await waitForMissingUrlParam(page, 'theme');
    const storedLightTheme = await page.evaluate(() => window.localStorage.getItem('cyanprint-theme'));
    if (storedLightTheme !== 'light') {
      throw new Error('theme switch did not persist light preference.');
    }
    await page.goto(`${baseUrl}?theme=dark`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await waitForUrlParam(page, 'theme', 'dark');

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await waitForUrlParam(page, 'theme', 'dark');
    await page.goto(`${baseUrl}/account?theme=dark`, { waitUntil: 'networkidle' });
    await waitForPathname(page, '/account');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await waitForUrlParam(page, 'theme', 'dark');

    await page.goto(`${baseUrl}/artifacts/template`, { waitUntil: 'networkidle' });
    await assertNoHorizontalOverflow(page, 'typed catalog route');
    if ((await page.locator('.kind-tabs').count()) !== 0) {
      throw new Error('catalog route still rendered a second artifact filter control.');
    }
    await page.getByLabel('Artifact kind filter').click();
    await page.getByRole('menuitem', { name: 'All' }).click();
    await waitForPathname(page, '/search');
    const allCatalogText = await page.getByRole('main').textContent();
    if (!allCatalogText?.includes('cyanprint/keep-user')) {
      throw new Error('typed catalog route did not preserve the explicit all-artifacts URL state.');
    }
    await page.getByLabel('Artifact kind filter').click();
    await page.getByRole('menuitem', { name: 'Resolvers' }).click();
    await waitForUrlParam(page, 'kind', 'resolver');
    await page.goto(`${baseUrl}/search?kind=template&theme=dark`, { waitUntil: 'networkidle' });
    await waitForUrlParam(page, 'kind', 'template');
    const templateCards = page.getByTestId('artifact-card');
    try {
      await templateCards.filter({ hasText: 'cyanprint/hello' }).first().waitFor();
      await assertCatalogCardsLayout(page);
    } catch (error) {
      const state = await page.evaluate(() => ({
        href: window.location.href,
        main: document.querySelector('main')?.textContent?.slice(0, 1000),
      }));
      throw new Error(
        `typed artifact navigation did not render template cards: ${JSON.stringify(state)}; ${String(error)}`,
      );
    }
    if ((await templateCards.filter({ hasText: 'cyanprint/keep-user' }).count()) !== 0) {
      throw new Error('typed artifact navigation did not replace the previous artifact kind URL state.');
    }

    await templateCards.filter({ hasText: 'cyanprint/hello' }).first().click();
    await waitForPathname(page, '/artifacts/template/cyanprint/hello');
    await assertArtifactDetailLayout(page);

    await assertResponsiveThemeMatrix(page, baseUrl);
  } finally {
    await browser?.close();
    web.kill();
    await web.exited.catch(() => undefined);
  }
}

async function assertResponsiveThemeMatrix(page: Page, baseUrl: string): Promise<void> {
  const routes = [
    '/',
    '/search',
    '/search?q=hello&kind=template',
    '/docs/user/quickstart',
    '/docs/user/artifact-authoring',
    '/account',
    '/account/tokens',
    '/artifacts/template',
    '/artifacts/template/cyanprint/hello',
  ];
  const viewports = [
    { label: 'mobile', width: 390, height: 820 },
    { label: 'desktop', width: 1440, height: 920 },
  ];
  const themes = ['light', 'dark'] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of themes) {
      for (const route of routes) {
        const url = themedUrl(baseUrl, route, theme);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (!response?.ok()) {
          throw new Error(`${viewport.label} ${theme} ${route}: HTTP ${response?.status() ?? 'unknown'}`);
        }
        await page.waitForFunction(() => document.documentElement.dataset.cyanprintShell === 'ready');
        await assertNoHorizontalOverflow(page, `${viewport.label} ${theme} ${route}`);
        await assertThemeApplied(page, theme, `${viewport.label} ${theme} ${route}`);
        await assertReadableText(page, `${viewport.label} ${theme} ${route}`);
        if (route.startsWith('/docs/')) {
          await assertMarkdownLayout(page, `${viewport.label} ${theme} ${route}`);
        }
      }
    }
  }
}

function themedUrl(baseUrl: string, route: string, theme: 'light' | 'dark'): string {
  const url = new URL(route, baseUrl);
  if (theme === 'dark') {
    url.searchParams.set('theme', 'dark');
  } else {
    url.searchParams.set('theme', 'light');
  }
  return url.toString();
}

async function assertThemeApplied(page: Page, theme: 'light' | 'dark', label: string): Promise<void> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (theme === 'dark' && !dark) {
    throw new Error(`${label}: dark theme class was not applied`);
  }
  if (theme === 'light' && dark) {
    throw new Error(`${label}: light route still has dark theme class`);
  }
}

async function assertReadableText(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => {
    const visibleElements = Array.from(document.querySelectorAll('main h1, main h2, main p, main li, main code'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          color: style.color,
          height: rect.height,
          text: element.textContent?.trim() ?? '',
          width: rect.width,
        };
      })
      .filter(element => element.text && element.width > 0 && element.height > 0);
    return {
      blankTextCount: visibleElements.filter(element => element.color === 'rgba(0, 0, 0, 0)').length,
      count: visibleElements.length,
    };
  });
  if (state.count === 0 || state.blankTextCount > 0) {
    throw new Error(`${label}: readable text check failed: ${JSON.stringify(state)}`);
  }
}

async function assertMarkdownLayout(page: Page, label: string): Promise<void> {
  await page.locator('.markdown-body').first().waitFor();
  const state = await page.evaluate(() => {
    const body = document.querySelector('.markdown-body')?.getBoundingClientRect();
    const pre = document.querySelector('.markdown-body pre')?.getBoundingClientRect();
    const preStyle = document.querySelector('.markdown-body pre')
      ? window.getComputedStyle(document.querySelector('.markdown-body pre')!)
      : undefined;
    return {
      bodyHeight: body?.height ?? 0,
      bodyWidth: body?.width ?? 0,
      preBackground: preStyle?.backgroundColor ?? '',
      preColor: preStyle?.color ?? '',
      preHeight: pre?.height ?? 0,
      preWidth: pre?.width ?? 0,
    };
  });
  if (state.bodyHeight <= 0 || state.bodyWidth <= 0) {
    throw new Error(`${label}: markdown body is empty: ${JSON.stringify(state)}`);
  }
  if (state.preHeight > 0 && (state.preColor === state.preBackground || state.preWidth <= 0)) {
    throw new Error(`${label}: markdown code block is unreadable: ${JSON.stringify(state)}`);
  }
}

async function assertArtifactDetailLayout(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'cyanprint/hello' }).waitFor();
  await page.getByText('cyanprint create cyanprint/hello').waitFor();
  await page.getByText('templates:').waitFor();
  await page.getByTestId('version-list').waitFor();
  await page.getByRole('heading', { name: 'README' }).waitFor();
  await page.getByRole('heading', { level: 2, name: 'Hello template' }).waitFor();
  await assertNoHorizontalOverflow(page, 'artifact detail route');
  const state = await page.evaluate(() => {
    const readme = document.querySelector('.readme-panel')?.getBoundingClientRect();
    const sidebar = document.querySelector('.artifact-sidebar')?.getBoundingClientRect();
    const commands = Array.from(document.querySelectorAll('.command-block')).map(
      block => block.getBoundingClientRect().width,
    );
    return {
      commandCount: commands.length,
      minCommandWidth: commands.length ? Math.min(...commands) : 0,
      readmeHeight: readme?.height ?? 0,
      sidebarHeight: sidebar?.height ?? 0,
    };
  });
  if (state.commandCount < 2 || state.minCommandWidth <= 0 || state.readmeHeight <= 0 || state.sidebarHeight <= 0) {
    throw new Error(`artifact detail layout is incomplete: ${JSON.stringify(state)}`);
  }
}

async function assertLandingLayout(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => {
    const hero = document.querySelector('.hero')?.getBoundingClientRect();
    const ledger = document.querySelector('.hero-ledger')?.getBoundingClientRect();
    const catalog = document.querySelector('.catalog-section')?.getBoundingClientRect();
    const stylesheetCount = document.styleSheets.length;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    return {
      catalogTop: catalog?.top ?? null,
      ledgerBottom: ledger?.bottom ?? null,
      ledgerTop: ledger?.top ?? null,
      heroBottom: hero?.bottom ?? null,
      heroTop: hero?.top ?? null,
      scrollWidth: document.documentElement.scrollWidth,
      stylesheetCount,
      viewportHeight,
      viewportWidth,
    };
  });
  if (state.stylesheetCount === 0) {
    throw new Error(`${label}: no stylesheets loaded`);
  }
  if (state.scrollWidth > state.viewportWidth) {
    throw new Error(`${label}: horizontal overflow ${state.scrollWidth} > ${state.viewportWidth}`);
  }
  if (state.catalogTop !== null) {
    throw new Error(`${label}: landing page still renders the catalog section: ${JSON.stringify(state)}`);
  }
  if (
    state.heroTop === null ||
    state.heroBottom === null ||
    state.ledgerTop === null ||
    state.ledgerBottom === null ||
    state.ledgerTop < state.heroTop ||
    state.ledgerBottom > state.heroBottom + 1
  ) {
    throw new Error(`${label}: hero ledger escapes hero bounds: ${JSON.stringify(state)}`);
  }
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (state.scrollWidth > state.clientWidth) {
    throw new Error(`${label}: horizontal overflow ${state.scrollWidth} > ${state.clientWidth}`);
  }
}

async function assertBoxInsideViewport(page: Page, selector: string, label: string): Promise<void> {
  const state = await page.evaluate(targetSelector => {
    const element = document.querySelector(targetSelector);
    if (!element) {
      return {
        bottom: 0,
        height: 0,
        left: 0,
        missing: true,
        right: 0,
        top: 0,
        viewportHeight: window.innerHeight,
        viewportWidth: document.documentElement.clientWidth,
        width: 0,
      };
    }
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      missing: false,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: document.documentElement.clientWidth,
      width: rect.width,
    };
  }, selector);
  if (state.missing || state.width <= 0 || state.height <= 0) {
    throw new Error(`${label}: element is missing or empty: ${JSON.stringify(state)}`);
  }
  if (state.left < 0 || state.right > state.viewportWidth || state.top < 0 || state.bottom > state.viewportHeight) {
    throw new Error(`${label}: element escapes viewport: ${JSON.stringify(state)}`);
  }
}

async function assertCatalogCardsLayout(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="artifact-card"]'))
      .slice(0, 8)
      .map(card => {
        const rect = card.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      });
    const overlap = cards.some((card, index) =>
      cards
        .slice(index + 1)
        .some(
          other =>
            card.left < other.right && card.right > other.left && card.top < other.bottom && card.bottom > other.top,
        ),
    );
    return {
      cardCount: cards.length,
      clientWidth: document.documentElement.clientWidth,
      overlap,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  if (state.cardCount === 0 || state.overlap || state.scrollWidth > state.clientWidth) {
    throw new Error(`catalog cards layout is broken: ${JSON.stringify(state)}`);
  }
}

async function runCommand(command: string[], env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, CYANPRINT_REGISTRY_URL: '', ...env },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}`);
  }
}

async function waitForUrlParam(page: Page, key: string, value: string): Promise<void> {
  try {
    await page.waitForFunction(
      ({ paramKey, expected }) => new URLSearchParams(window.location.search).get(paramKey) === expected,
      { paramKey: key, expected: value },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      href: window.location.href,
      searchValue: (document.querySelector('input[aria-label="Search registry"]') as HTMLInputElement | null)?.value,
      body: document.body.innerText.slice(0, 500),
    }));
    throw new Error(`URL state did not update ${key}=${value}: ${JSON.stringify(state)}; ${String(error)}`);
  }
}

async function waitForMissingUrlParam(page: Page, key: string): Promise<void> {
  try {
    await page.waitForFunction(paramKey => !new URLSearchParams(window.location.search).has(paramKey), key);
  } catch (error) {
    throw new Error(`URL state did not remove ${key}: ${page.url()}; ${String(error)}`);
  }
}

async function waitForPathname(page: Page, pathname: string): Promise<void> {
  await page.waitForFunction(expected => window.location.pathname === expected, pathname);
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = await findBrowserExecutable();
  try {
    return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (error) {
    throw new Error(
      `Unable to launch a browser for web e2e. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Playwright browsers. ${String(error)}`,
    );
  }
}

async function findBrowserExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    if (await Bun.file(path).exists()) {
      return path;
    }
  }
  return undefined;
}

function captureProcessOutput(proc: SpawnedWebServer): () => string {
  const chunks: string[] = [];
  captureStream(proc.stdout, chunks, 'stdout');
  captureStream(proc.stderr, chunks, 'stderr');
  return () => trimLogs(chunks.join(''));
}

function captureStream(stream: ReadableStream<Uint8Array> | null | undefined, chunks: string[], label: string): void {
  if (!stream) {
    return;
  }
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        const joined = chunks.join('');
        if (joined.length > 12_000) {
          chunks.splice(0, chunks.length, joined.slice(-8_000));
        }
      }
      const tail = decoder.decode();
      if (tail) {
        chunks.push(tail);
      }
    } catch (error) {
      chunks.push(`[${label} capture failed] ${String(error)}\n`);
    }
  })();
}

function trimLogs(logs: string): string {
  const normalized = logs.trim();
  return normalized ? normalized.slice(-8_000) : '<no server logs captured>';
}

async function waitForHttpOrExit(url: string, proc: SpawnedWebServer, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exit = await Promise.race([
      proc.exited.then(code => ({ code, exited: true })),
      Bun.sleep(1).then(() => ({ code: undefined, exited: false })),
    ]);
    if (exit.exited) {
      throw new Error(`Web server exited before it was ready with code ${exit.code}.\n${logs()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for web server: ${String(lastError)}\n${logs()}`);
}
