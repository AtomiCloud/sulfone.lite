# Utilities in TypeScript/Bun

## Library: Lodash

Lodash provides utility functions for common programming tasks. Use tree-shakeable imports.

```bash
bun add lodash-es lodash
bun add -D @types/lodash
```

```typescript
// Tree-shakeable imports with lodash-es (ESM build - recommended)
import { groupBy, sortBy, uniqBy } from 'lodash-es';

// Alternative: per-method imports (also tree-shakeable)
// import groupBy from 'lodash/groupBy';

// Note: Named imports from 'lodash' are CommonJS/UMD and aren't reliably
// tree-shakeable with Bun. Use 'lodash-es' or per-method paths instead.
```

## Collections

### map, filter, reduce (Native)

For basic operations, use native array methods:

```typescript
// Native array methods are sufficient
const names = users.map(u => u.name);
const active = users.filter(u => u.active);
const total = items.reduce((sum, item) => sum + item.price, 0);
```

### groupBy

Group elements by a key:

```typescript
import { groupBy } from 'lodash';

const users = [
  { name: 'Alice', role: 'admin' },
  { name: 'Bob', role: 'user' },
  { name: 'Carol', role: 'admin' },
];

const grouped = groupBy(users, 'role');
// { admin: [{ name: 'Alice', ... }, { name: 'Carol', ... }],
//   user: [{ name: 'Bob', ... }] }

// With function
const groupedByFn = groupBy(users, u => u.role);
```

### sortBy

Sort by one or more properties:

```typescript
import { sortBy } from 'lodash';

const sorted = sortBy(users, ['role', 'name']);
// Sorts by role, then by name

// With function
const sortedByFn = sortBy(users, [u => u.role, u => u.name.toLowerCase()]);
```

### orderBy

Sort with direction control:

```typescript
import { orderBy } from 'lodash';

const sorted = orderBy(users, ['age', 'name'], ['desc', 'asc']);
```

### find, findLast

Find elements:

```typescript
import { find, findLast } from 'lodash';

const user = find(users, { role: 'admin' });
const userByAge = find(users, u => u.age > 30);
const last = findLast(users, { active: true });
```

### uniq, uniqBy

Remove duplicates:

```typescript
import { uniq, uniqBy } from 'lodash';

const unique = uniq([1, 2, 1, 3, 2]); // [1, 2, 3]

const uniqueUsers = uniqBy(users, 'email');
const uniqueUsersByFn = uniqBy(users, u => u.email);
```

### flatten, flattenDeep

Flatten nested arrays:

```typescript
import { flatten, flattenDeep } from 'lodash';

const flat = flatten([
  [1, 2],
  [3, 4],
]); // [1, 2, 3, 4]
const deep = flattenDeep([1, [2, [3, [4]]]]); // [1, 2, 3, 4]
```

### chunk

Split into chunks:

```typescript
import { chunk } from 'lodash';

const chunks = chunk([1, 2, 3, 4, 5, 6], 2);
// [[1, 2], [3, 4], [5, 6]]
```

### zip, unzip

Combine arrays:

```typescript
import { zip, unzip } from 'lodash';

const zipped = zip(['a', 'b'], [1, 2], [true, false]);
// [['a', 1, true], ['b', 2, false]]

const unzipped = unzip(zipped);
// [['a', 'b'], [1, 2], [true, false]]
```

### difference, intersection

Set operations:

```typescript
import { difference, intersection, union } from 'lodash';

const diff = difference([1, 2, 3, 4], [2, 4]); // [1, 3]
const inter = intersection([1, 2, 3], [2, 3, 4]); // [2, 3]
const uni = union([1, 2], [2, 3]); // [1, 2, 3]
```

## Objects

### pick, omit

Select or exclude properties:

```typescript
import { pick, omit } from 'lodash';

const user = { id: 1, name: 'Alice', email: 'a@b.com', password: 'secret' };

const safe = pick(user, ['id', 'name', 'email']);
// { id: 1, name: 'Alice', email: 'a@b.com' }

const safe2 = omit(user, ['password']);
// { id: 1, name: 'Alice', email: 'a@b.com' }
```

### merge, defaults

Deep merge objects:

```typescript
import { merge, defaults } from 'lodash';

const merged = merge({ a: 1, b: { c: 2 } }, { b: { d: 3 }, e: 4 });
// { a: 1, b: { c: 2, d: 3 }, e: 4 }

const withDefaults = defaults({ a: 1 }, { a: 0, b: 2 });
// { a: 1, b: 2 }
```

### cloneDeep

Deep clone:

```typescript
import { cloneDeep } from 'lodash';

const original = { a: { b: [1, 2, 3] } };
const copy = cloneDeep(original);
copy.a.b.push(4);
original.a.b; // [1, 2, 3] (unchanged)
```

### keys, values, entries (Native)

For basic operations, use native:

```typescript
const obj = { a: 1, b: 2, c: 3 };
const keys = Object.keys(obj); // ['a', 'b', 'c']
const values = Object.values(obj); // [1, 2, 3]
const entries = Object.entries(obj); // [['a', 1], ['b', 2], ['c', 3]]
const reconstructed = Object.fromEntries(entries); // { a: 1, b: 2, c: 3 }
```

### get, set, has

Safely access nested properties:

```typescript
import { get, set, has } from 'lodash';

const value = get(user, 'address.city.name', 'Unknown');
set(user, 'preferences.theme', 'dark');
const exists = has(user, 'address.city');
```

## Strings

### Case Conversion

```typescript
import { camelCase, snakeCase, kebabCase, startCase, capitalize } from 'lodash';

camelCase('hello world'); // 'helloWorld'
snakeCase('helloWorld'); // 'hello_world'
kebabCase('helloWorld'); // 'hello-world'
startCase('hello_world'); // 'Hello World'
capitalize('hello world'); // 'Hello world'
```

### truncate

```typescript
import { truncate } from 'lodash';

truncate('hello world this is long', { length: 15 });
// 'hello world...'
```

### template

```typescript
import { template } from 'lodash';

const compiled = template('Hello <%= name %>!');
compiled({ name: 'Alice' }); // 'Hello Alice!'
```

### pad, repeat

```typescript
import { pad, repeat } from 'lodash';

pad('abc', 8); // '  abc   '
pad('abc', 8, '_-'); // '_-abc_-_'
repeat('ab', 3); // 'ababab'
```

## Functions

### debounce

Delay execution until pause:

```typescript
import { debounce } from 'lodash';

const debouncedSearch = debounce((query: string) => {
  fetchResults(query);
}, 300);

input.addEventListener('input', (e: Event) => {
  const target = e.currentTarget as HTMLInputElement;
  debouncedSearch(target.value);
});

// Cancel pending execution
debouncedSearch.cancel();
```

### throttle

Limit rate of calls:

```typescript
import { throttle } from 'lodash';

const throttledScroll = throttle(() => {
  saveScrollPosition();
}, 1000);

window.addEventListener('scroll', throttledScroll);
```

### memoize

Cache function results:

```typescript
import { memoize } from 'lodash';

const expensiveCalculation = memoize((n: number) => {
  console.log('Calculating...');
  return n * n;
});

expensiveCalculation(5); // Logs, returns 25
expensiveCalculation(5); // Returns 25 (cached)
```

### once

Execute only once:

```typescript
import { once } from 'lodash';

const initialize = once(() => {
  console.log('Initializing...');
  // Setup code
});

initialize(); // Logs
initialize(); // Does nothing
```

## Math

```typescript
import { sum, mean, min, max, clamp, range } from 'lodash';

sum([1, 2, 3, 4]); // 10
mean([1, 2, 3, 4]); // 2.5
min([3, 1, 4, 1, 5]); // 1
max([3, 1, 4, 1, 5]); // 5
clamp(10, 1, 5); // 5 (clamped to max)
range(1, 5); // [1, 2, 3, 4]
range(0, 10, 2); // [0, 2, 4, 6, 8]
```

## Best Practices

### Use Tree-Shakeable Imports

```typescript
// WRONG - Imports entire library
import _ from 'lodash';
_.groupBy(items, 'category');

// RIGHT - Import only what you need
import { groupBy } from 'lodash';
groupBy(items, 'category');
```

### Prefer Native When Sufficient

```typescript
// Use native for simple operations
const filtered = items.filter(x => x.active);
const mapped = items.map(x => x.name);
const found = items.find(x => x.id === id);

// Use Lodash for complex operations
const grouped = groupBy(items, 'category');
const sorted = sortBy(items, ['priority', 'name']);
const unique = uniqBy(items, 'id');
```

### Chain with Flow

For multiple operations, use `flow` or pipe:

```typescript
import { flow, filter, map, sortBy, take } from 'lodash/fp';

const process = flow(
  filter(u => u.active),
  map(u => u.name),
  sortBy(name => name.toLowerCase()),
  take(10),
);

const topNames = process(users);
```
