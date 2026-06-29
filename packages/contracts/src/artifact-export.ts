export function exportedFunctionParameterCount(source: string, exportName: string): number | undefined {
  const masked = maskCommentsAndStrings(source);
  const declaration = topLevelFunctionDeclaration(masked, exportName);
  if (!declaration) {
    return undefined;
  }
  const openParen = declaration.openParen;
  const closeParen = findMatchingParen(masked, openParen);
  if (closeParen === undefined) {
    return undefined;
  }
  return countTopLevelParameters(masked.slice(openParen + 1, closeParen));
}

function topLevelFunctionDeclaration(source: string, exportName: string): { openParen: number } | undefined {
  let depth = 0;
  let index = 0;
  const pattern = new RegExp(`(export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(exportName)}\\s*\\(`, 'y');
  while (index < source.length) {
    const char = source[index];
    if (depth === 0) {
      pattern.lastIndex = index;
      const match = pattern.exec(source);
      if (match && startsDeclaration(source, index) && (match[1] || hasTopLevelDirectExport(source, exportName))) {
        return { openParen: pattern.lastIndex - 1 };
      }
    }
    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    }
    index += 1;
  }
  return undefined;
}

function startsDeclaration(source: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === undefined) {
      return true;
    }
    if (!/\s/.test(char)) {
      return char === ';' || char === '}';
    }
  }
  return true;
}

function hasTopLevelDirectExport(source: string, exportName: string): boolean {
  let depth = 0;
  let index = 0;
  const pattern = /export\s*\{/y;
  while (index < source.length) {
    const char = source[index];
    if (depth === 0) {
      pattern.lastIndex = index;
      const match = pattern.exec(source);
      if (match) {
        const openBrace = pattern.lastIndex - 1;
        const closeBrace = findMatchingBrace(source, openBrace);
        if (closeBrace !== undefined && exportListIncludesName(source.slice(openBrace + 1, closeBrace), exportName)) {
          return true;
        }
      }
    }
    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    }
    index += 1;
  }
  return false;
}

function findMatchingBrace(source: string, openBrace: number): number | undefined {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function exportListIncludesName(list: string, exportName: string): boolean {
  return list
    .split(',')
    .map(part => part.trim())
    .some(part => part === exportName || part === `${exportName} as ${exportName}`);
}

function maskCommentsAndStrings(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const stop = end === -1 ? source.length : end;
      output += ' '.repeat(stop - index);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += ' '.repeat(stop - index);
      index = stop;
    } else if (char === '/') {
      const stop = regexEnd(source, index);
      output += ' '.repeat(stop - index);
      index = stop;
    } else if (char === '"' || char === "'" || char === '`') {
      const stop = stringEnd(source, index, char);
      output += ' '.repeat(stop - index);
      index = stop;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function regexEnd(source: string, start: number): number {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\n') {
      return start + 1;
    }
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      inCharacterClass = true;
    } else if (char === ']') {
      inCharacterClass = false;
    } else if (char === '/' && !inCharacterClass) {
      let stop = index + 1;
      while (/[a-z]/i.test(source[stop] ?? '')) {
        stop += 1;
      }
      return stop;
    }
  }
  return start + 1;
}

function stringEnd(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
    } else if (char === quote) {
      return index + 1;
    }
  }
  return source.length;
}

function findMatchingParen(source: string, openParen: number): number | undefined {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function countTopLevelParameters(parameters: string): number {
  const trimmed = parameters.trim();
  if (!trimmed) {
    return 0;
  }
  let count = 1;
  let depth = 0;
  for (const char of parameters) {
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      count += 1;
    }
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
