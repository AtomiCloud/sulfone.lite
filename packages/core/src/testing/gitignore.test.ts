import { describe, expect, test } from 'bun:test';
import { parseGitignore } from './gitignore';

describe('parseGitignore', () => {
  test('does not re-include a file under an excluded parent directory (git semantics)', () => {
    const ignored = parseGitignore('dist/\n!dist/keep\n');
    expect(ignored('dist/keep')).toBe(true);
    expect(ignored('dist/other')).toBe(true);
  });

  test('re-includes a file when only its contents (not the parent dir) are excluded', () => {
    const ignored = parseGitignore('dist/*\n!dist/keep\n');
    expect(ignored('dist/keep')).toBe(false);
    expect(ignored('dist/other')).toBe(true);
  });

  test('anchors patterns with a middle slash and supports negation of files', () => {
    const ignored = parseGitignore('a/b\n*.log\n!important.log\n');
    expect(ignored('a/b')).toBe(true);
    expect(ignored('x/a/b')).toBe(false);
    expect(ignored('x.log')).toBe(true);
    expect(ignored('important.log')).toBe(false);
  });

  test('a directory-only negation does not un-ignore files beneath that directory', () => {
    const ignored = parseGitignore('*\n!*/\n!*.ts\n');
    expect(ignored('src/a.ts')).toBe(false);
    expect(ignored('src/a.js')).toBe(true);
    expect(ignored('src/deep/b.js')).toBe(true);
    expect(ignored('src/deep/b.ts')).toBe(false);
  });
});
