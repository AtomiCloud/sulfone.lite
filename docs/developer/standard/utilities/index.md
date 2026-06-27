# Utility Libraries

Utility libraries provide common operations for collections, strings, objects, and functions. They reduce boilerplate code, improve readability, and are battle-tested.

This article builds on [Software Design Philosophy](../software-design-philosophy/index.md). The goal is to write less code by using proven utilities.

---

## Why Use Utility Libraries

### Reduce Code

Without utilities, common operations require repetitive code:

```typescript
// Manual implementation
function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce(
    (acc, item) => {
      const k = key(item);
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    },
    {} as Record<string, T[]>,
  );
}
```

With a utility library:

```typescript
import { groupBy } from 'lodash-es';
const grouped = groupBy(items, item => item.category);
```

### Reduce Tests

Utility libraries are battle-tested. Don't retest library internals; still write tests for your business logic and integration behavior.

You don't need to test that the library correctly implements:

- Sorting algorithms
- Debounce/throttle behavior
- Deep cloning
- Object merging

### Improve Readability

Named utilities are self-documenting:

```go
// Without utility
unique := make([]string, 0)
seen := make(map[string]bool)
for _, s := range items {
    if !seen[s] {
        seen[s] = true
        unique = append(unique, s)
    }
}

// With utility
unique := lo.Uniq(items)
```

---

## Categories of Utilities

### Collections

Operations on arrays, slices, and lists.

| Operation | Description                 |
| --------- | --------------------------- |
| map       | Transform each element      |
| filter    | Keep matching elements      |
| reduce    | Fold into single value      |
| find      | Find first matching element |
| groupBy   | Group elements by key       |
| sortBy    | Sort by property            |
| flatten   | Flatten nested arrays       |
| chunk     | Split into chunks           |
| uniq      | Remove duplicates           |
| zip/unzip | Combine/separate arrays     |

### Strings

String manipulation utilities.

| Operation       | Description                 |
| --------------- | --------------------------- |
| trim            | Remove whitespace           |
| case conversion | camelCase, snake_case, etc. |
| truncate        | Limit length with ellipsis  |
| template        | Interpolate values          |
| pad             | Pad to length               |
| split/join      | Split into array, join back |
| capitalize      | Uppercase first letter      |

### Objects

Object manipulation utilities.

| Operation   | Description                |
| ----------- | -------------------------- |
| pick        | Select properties          |
| omit        | Exclude properties         |
| merge       | Deep merge objects         |
| cloneDeep   | Deep clone object          |
| keys/values | Get property names/values  |
| entries     | Convert to key-value pairs |
| fromEntries | Convert pairs to object    |

### Functions

Function utilities.

| Operation | Description         |
| --------- | ------------------- |
| debounce  | Delay until pause   |
| throttle  | Limit rate of calls |
| memoize   | Cache results       |
| once      | Execute only once   |
| curry     | Partial application |
| compose   | Chain functions     |

---

## Choosing the Right Tool

### TypeScript: Lodash

Use Lodash for operations not covered by native array methods.

```typescript
// Native is sufficient
items.filter(x => x.active);
items.map(x => x.name);
items.reduce((acc, x) => acc + x.value, 0);

// Lodash for more complex operations
import { groupBy, sortBy, uniqBy, merge } from 'lodash';
```

### C#: LINQ

LINQ is built into .NET and covers most needs.

```csharp
// LINQ covers almost everything
items.Where(x => x.Active)
     .Select(x => x.Name)
     .OrderBy(x => x)
     .GroupBy(x => x.Category)
```

### Go: stdlib + samber/lo

Use stdlib `slices` and `maps` packages first (Go 1.21+). Use `samber/lo` for functional operations.

```go
// stdlib first
slices.Contains(items, "target")
slices.Sort(items)
maps.Keys(m)

// lo for functional operations
lo.Map(items, func(x T, _ int) U { return x.Value })
lo.Filter(items, func(x T, _ int) bool { return x.Active })
```

---

## Quick Checklist

**Before adding a utility function:**

- [ ] Check if native features suffice
- [ ] Check if utility library provides it
- [ ] Consider if the utility is actually needed
- [ ] Ensure tree-shakeable import (Lodash, lo)

**When using utilities:**

- [ ] Import only what you need
- [ ] Use named imports for clarity
- [ ] Prefer functional style over loops
- [ ] Document complex transformations

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md) — Lodash with tree-shakeable imports
- [C#/.NET](./languages/csharp.md) — LINQ native usage
- [Go](./languages/go.md) — stdlib `slices`/`maps` + `samber/lo`

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) — Why write less code
- [Testing](../testing/index.md) — Testing with utility functions
- [Domain Modeling](../domain-driven-design/index.md) — Using utilities in domain logic
