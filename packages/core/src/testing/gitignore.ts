// Minimal .gitignore matcher for template test output comparison. Supports comments,
// blank lines, negation (`!`), root-anchored patterns (leading `/`), directory patterns
// (trailing `/`), and `*`/`**`/`?` globs. Later patterns override earlier ones.

type IgnoreRule = {
  negated: boolean;
  matches: (path: string) => boolean;
};

export function parseGitignore(content: string): (path: string) => boolean {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    let pattern = line.trim();
    const negated = pattern.startsWith('!');
    if (negated) {
      pattern = pattern.slice(1);
    }
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) {
      pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
    if (pattern.startsWith('/')) {
      pattern = pattern.slice(1);
    }
    if (!pattern) {
      continue;
    }
    const globs: Bun.Glob[] = [];
    const push = (glob: string): void => {
      globs.push(new Bun.Glob(glob));
    };
    if (anchored) {
      if (!directoryOnly) {
        push(pattern);
      }
      push(`${pattern}/**`);
    } else {
      if (!directoryOnly) {
        push(pattern);
        push(`**/${pattern}`);
      }
      push(`${pattern}/**`);
      push(`**/${pattern}/**`);
    }
    rules.push({ negated, matches: path => globs.some(glob => glob.match(path)) });
  }
  return (path: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.matches(path)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}
