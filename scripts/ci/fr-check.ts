const body = await Bun.file('docs/requirements/fr-coverage.md').text();
const rows = body
  .split('\n')
  .filter(line => /^\|\s*FR\d+\s*\|/.test(line))
  .map(line => line.split('|').map(cell => cell.trim()));
const counts = new Map<number, number>();
const invalid: string[] = [];
for (const row of rows) {
  const id = Number(row[1]?.replace(/^FR/, ''));
  counts.set(id, (counts.get(id) ?? 0) + 1);
  if (row[6] !== 'implemented') {
    invalid.push(`FR${id}:${row[6] ?? ''}`);
  }
}
const missing: number[] = [];
for (let id = 1; id <= 213; id += 1) {
  if (!counts.has(id)) {
    missing.push(id);
  }
}
if (missing.length > 0) {
  throw new Error(`FR coverage matrix is missing: ${missing.map(id => `FR${id}`).join(', ')}`);
}
if (/\|\s*FR\d+\s*\|[^\n]*\|\s*(deferred|todo|tbd)\s*\|/i.test(body)) {
  throw new Error('FR coverage matrix contains deferred, todo, or tbd status.');
}
const duplicates = [...counts.entries()].filter(([, count]) => count !== 1);
if (duplicates.length > 0) {
  throw new Error(`FR coverage matrix has duplicate rows: ${duplicates.map(([id]) => `FR${id}`).join(', ')}`);
}
const extras = [...counts.keys()].filter(id => id < 1 || id > 213);
if (extras.length > 0) {
  throw new Error(`FR coverage matrix has out-of-range rows: ${extras.map(id => `FR${id}`).join(', ')}`);
}
if (invalid.length > 0) {
  throw new Error(`FR coverage matrix has non-implemented statuses: ${invalid.join(', ')}`);
}
console.log(JSON.stringify({ status: 'done', range: 'FR1-FR213', missing }));

export {};
