import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownReadme } from '../features/artifacts/markdown-readme';

describe('content safety csp unsafe html', () => {
  test('README markdown renderer does not emit script tags', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownReadme, { markdown: '# Safe\n\n<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
