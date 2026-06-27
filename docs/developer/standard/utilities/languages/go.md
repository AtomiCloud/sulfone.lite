# Utilities in Go

## Standard Library: `slices` and `maps` (Go 1.21+)

Use standard library packages for basic operations. Use `samber/lo` for functional operations.

```go
import (
    "slices"
    "maps"
)
```

## Standard Library: slices

### Contains

```go
// Check if slice contains element
found := slices.Contains(items, "target")
found := slices.ContainsFunc(items, func(x T) bool { return x.Active })
```

### Sort

```go
// Sort ordered slices (int, float, string) - ascending
slices.Sort(nums)

// Custom sort with comparison function
slices.SortFunc(items, func(a, b Item) int {
    return cmp.Compare(a.Name, b.Name)
})

// Sort with stable sort (preserves order of equal elements)
slices.SortStableFunc(items, func(a, b Item) int {
    return cmp.Compare(a.Priority, b.Priority)
})

// Reverse sort (sort first, then reverse)
slices.Sort(nums)
slices.Reverse(nums)
```

### Delete, Insert

```go
// Delete element at index
items = slices.Delete(items, 2, 4) // removes elements at index 2 and 3

// Insert at index
items = slices.Insert(items, 2, newItem)
items = slices.Insert(items, 2, item1, item2)
```

### Clone, Equal

```go
// Clone slice
copy := slices.Clone(items)

// Compare slices
equal := slices.Equal(a, b)
equal := slices.EqualFunc(a, b, func(x, y T) bool { return x.ID == y.ID })

// Compare for ordering
cmp := slices.Compare(a, b) // -1, 0, 1
```

### Compact (Remove consecutive duplicates)

```go
nums := []int{1, 1, 2, 2, 2, 3}
nums = slices.Compact(nums) // [1, 2, 3]

// With custom equality
items = slices.CompactFunc(items, func(a, b Item) bool {
    return a.ID == b.ID
})
```

### Index, Replace

```go
// Find index
idx := slices.Index(items, target)
idx := slices.IndexFunc(items, func(x T) bool { return x.Active })

// Replace elements
items = slices.Replace(items, 2, 4, newItem)
```

### Min, Max

```go
smallest := slices.Min(nums)
largest := slices.Max(nums)
```

## Standard Library: maps

### Keys, Values

```go
// Get keys (Go 1.23+ returns iterator)
keys := slices.Collect(maps.Keys(m)) // Collect iterator to slice

// Or iterate directly
for k := range maps.Keys(m) {
    fmt.Println(k)
}

// Get values (Go 1.23+ returns iterator, not []V)
// Note: maps.Values returns iter.Seq[V], not a slice
values := slices.Collect(maps.Values(m))

// Or iterate directly
for v := range maps.Values(m) {
    fmt.Println(v)
}
```

### Clone, Copy

```go
// Clone map
copy := maps.Clone(m)

// Copy entries from src to dst
maps.Copy(dst, src)
```

### Equal

```go
equal := maps.Equal(a, b)
equal := maps.EqualFunc(a, b, func(v1, v2 V) bool {
    return v1.ID == v2.ID
})
```

### DeleteFunc

```go
// Delete entries matching predicate
maps.DeleteFunc(m, func(k string, v Item) bool {
    return v.Deleted
})
```

## samber/lo

For functional operations not in stdlib.

```bash
go get github.com/samber/lo@v1.39.0
```

```go
import "github.com/samber/lo"
```

### Map, Filter, Reduce

```go
// Map - transform each element
names := lo.Map(users, func(u User, _ int) string {
    return u.Name
})

// Filter - keep matching elements
active := lo.Filter(users, func(u User, _ int) bool {
    return u.IsActive
})

// Reduce - fold into single value
total := lo.Reduce(items, func(acc int, item Item, _ int) int {
    return acc + item.Price
}, 0)
```

### Find, FindOrElse

```go
item, ok := lo.Find(items, func(x Item) bool { return x.ID == "123" })
if ok {
    // Found
}

// With default
item := lo.FindOrElse(items, defaultItem, func(x Item) bool {
    return x.ID == "123"
})
```

### GroupBy

```go
grouped := lo.GroupBy(items, func(item Item) string {
    return item.Category
})
// map[string][]Item

// Group by multiple fields
grouped := lo.GroupBy(items, func(item Item) [2]string {
    return [2]string{item.Category, item.Status}
})
```

### Chunk, Flatten

```go
// Split into chunks
chunks := lo.Chunk(items, 10) // [][]Item

// Flatten
flat := lo.Flatten(nested) // []T from [][]T
```

### Uniq, UniqBy

```go
// Remove duplicates
unique := lo.Uniq(items)

// Uniq by property
unique := lo.UniqBy(items, func(item Item) string {
    return item.Email
})
```

### Keys, Values, Pick, Omit

```go
// Map operations
keys := lo.Keys(m)           // []K
values := lo.Values(m)       // []V
entries := lo.Entries(m)     // []lo.Entry[K, V]
fromEntries := lo.FromEntries(entries) // map[K]V

// Pick/omit keys from map
picked := lo.PickBy(m, func(k string, v Item) bool {
    return v.Active
})
omitted := lo.OmitBy(m, func(k string, v Item) bool {
    return v.Deleted
})
```

### Contains, ContainsBy

```go
contains := lo.Contains(items, target)
contains := lo.ContainsBy(items, func(x Item) bool {
    return x.ID == "123"
})
```

### Difference, Intersection, Union

```go
diff := lo.Difference(a, b)       // Elements in a not in b
inter := lo.Intersection(a, b)    // Elements in both
uni := lo.Union(a, b)             // All unique elements
```

### Reverse, Shuffle

```go
reversed := lo.Reverse(items)
shuffled := lo.Shuffle(items)
```

### IndexOf, LastIndexOf

```go
idx := lo.IndexOf(items, target)
idx := lo.LastIndexOf(items, target)

idx := lo.IndexOfBy(items, func(x Item) bool {
    return x.ID == "123"
})
```

### SliceToMap, Associate

```go
// Convert slice to map
m := lo.SliceToMap(items, func(item Item) (string, Item) {
    return item.ID, item
})

// Associate - same as SliceToMap with different signature
m := lo.Associate(items, func(item Item) (string, string) {
    return item.ID, item.Name
})
```

### Repeat, Range

```go
repeated := lo.Repeat(3, item) // [item, item, item]

// Range of numbers
nums := lo.Range(5)            // [0, 1, 2, 3, 4]
nums := lo.RangeFrom(10, 3)    // [10, 11, 12]
nums := lo.RangeWithSteps(0, 10, 2) // [0, 2, 4, 6, 8]
```

## Best Practices

### stdlib First

```go
// Use stdlib for basic operations
slices.Contains(items, target)
slices.Sort(items)
maps.Keys(m)

// Use lo for functional operations
lo.Map(items, func(x T, _ int) U { ... })
lo.Filter(items, func(x T, _ int) bool { ... })
lo.GroupBy(items, func(x T) K { ... })
```

### Functional Style

```go
// Prefer functional operations over loops
var active []User
for _, u := range users {
    if u.IsActive {
        active = append(active, u)
    }
}

// More readable with lo
active := lo.Filter(users, func(u User, _ int) bool {
    return u.IsActive
})
```

### Chaining

```go
// Chain operations (each creates new slice)
result := lo.Filter(
    lo.Map(users, func(u User, _ int) UserDTO {
        return ToDTO(u)
    }),
    func(dto UserDTO, _ int) bool {
        return dto.Active
    },
)

// Or break into steps for readability
dtos := lo.Map(users, ToDTO)
active := lo.Filter(dtos, func(dto UserDTO, _ int) bool {
    return dto.Active
})
```

### Pointer Handling

```go
// lo provides pointer helpers
ptr := lo.ToPtr(value)      // *T
value := lo.FromPtr(ptr)    // T (zero value if nil)
value := lo.FromPtrOr(ptr, defaultValue)
```

### Empty Slice Handling

```go
// lo handles empty slices gracefully
result := lo.Map([]int{}, func(x int, _ int) int { return x * 2 }) // []
result := lo.Find([]int{}, func(x int) bool { return x > 0 })       // 0, false
```
