# Utilities in C#/.NET

## Native: LINQ

LINQ (Language Integrated Query) is built into .NET and provides comprehensive collection utilities. No external library needed.

```csharp
using System.Linq;
```

## Collections

### Where (Filter)

```csharp
var activeUsers = users.Where(u => u.IsActive);
var adults = users.Where(u => u.Age >= 18);
```

### Select (Map)

```csharp
var names = users.Select(u => u.Name);
var emails = users.Select(u => u.Email).ToList();
```

### Aggregate (Reduce)

```csharp
var total = items.Aggregate(0, (sum, item) => sum + item.Price);
var concatenated = words.Aggregate((a, b) => a + " " + b);
```

### First, FirstOrDefault, Single

```csharp
var first = users.First();                         // Throws if empty
var firstActive = users.First(u => u.IsActive);
var firstOrDefault = users.FirstOrDefault();       // Returns null/default if empty
var firstActiveDefault = users.FirstOrDefault(u => u.IsActive);

var single = users.Single(u => u.Id == id);        // Throws if not exactly one
var singleDefault = users.SingleOrDefault(u => u.Id == id);
```

### GroupBy

```csharp
var byRole = users.GroupBy(u => u.Role);
// IEnumerable<IGrouping<string, User>>

foreach (var group in byRole)
{
    Console.WriteLine($"Role: {group.Key}");
    foreach (var user in group)
    {
        Console.WriteLine($"  {user.Name}");
    }
}

// Project to dictionary
var byRoleDict = users.GroupBy(u => u.Role)
                      .ToDictionary(g => g.Key, g => g.ToList());
```

### OrderBy, ThenBy

```csharp
var sorted = users.OrderBy(u => u.Name);
var sortedDesc = users.OrderByDescending(u => u.Age);
var multi = users.OrderBy(u => u.Role).ThenBy(u => u.Name);
var multiDesc = users.OrderBy(u => u.Role).ThenByDescending(u => u.Age);
```

### Distinct

```csharp
var unique = numbers.Distinct();
var uniqueBy = users.DistinctBy(u => u.Email); // .NET 6+
```

### SelectMany (Flatten)

```csharp
// Flatten nested collections
var allOrders = customers.SelectMany(c => c.Orders);
var allTags = posts.SelectMany(p => p.Tags).Distinct();

// With result selector
var pairs = users.SelectMany(
    u => u.Roles,
    (user, role) => new { User = user.Name, Role = role }
);
```

### Chunk (.NET 6+)

```csharp
var chunks = users.Chunk(10);
// IEnumerable<User[]>
```

### Zip

```csharp
var pairs = names.Zip(ages, (name, age) => new { Name = name, Age = age });
```

### Set Operations

```csharp
var except = allUsers.Except(activeUsers);
var intersect = admins.Intersect(managers);
var union = list1.Union(list2);
```

### Contains, Any, All

```csharp
var hasAdmin = users.Any(u => u.Role == "Admin");
var allActive = users.All(u => u.IsActive);
var contains = users.Contains(specificUser);
```

### Take, Skip

```csharp
var first10 = users.Take(10);
var skip10 = users.Skip(10);
var pagedUsers = users.Skip((pageNumber - 1) * pageSize).Take(pageSize);

// TakeWhile, SkipWhile
var upTo100 = numbers.TakeWhile(n => n < 100);
var after100 = numbers.SkipWhile(n => n < 100);
```

### To Collections

```csharp
var list = items.ToList();
var array = items.ToArray();
var dict = items.ToDictionary(i => i.Id);
var lookup = items.ToLookup(i => i.Category);
var hashSet = items.ToHashSet();
```

## Objects

### Dictionary Operations

```csharp
var dict = new Dictionary<string, int> { { "a", 1 }, { "b", 2 } };

var keys = dict.Keys;
var values = dict.Values;

// Merge dictionaries
var merged = dict1.Concat(dict2).ToDictionary(kvp => kvp.Key, kvp => kvp.Value);

// TryGetValue
if (dict.TryGetValue("key", out var value))
{
    // Use value
}
```

### Object Initialization

```csharp
// Record initialization
var user = new User { Name = "Alice", Email = "a@b.com" };

// With expression (non-destructive mutation)
var updated = user with { Name = "New Name" };
```

### Anonymous Types

```csharp
var projected = users.Select(u => new { u.Name, u.Email });
```

## Strings

### String Manipulation

```csharp
// Native string methods
var upper = name.ToUpper();
var lower = name.ToLower();
var trimmed = input.Trim();
var parts = csv.Split(',');
var joined = string.Join(", ", items);

// StringBuilder for multiple operations
var sb = new StringBuilder();
foreach (var item in items)
{
    sb.AppendLine(item);
}
var result = sb.ToString();

// Interpolation
var message = $"Hello, {name}!";
```

### String.Format

```csharp
var formatted = string.Format("{0:N2}", 1234.56); // "1,234.56"
var formattedCurrency = $"{amount:C}"; // Currency format
```

## Aggregations

```csharp
var sum = items.Sum(i => i.Price);
var avg = items.Average(i => i.Price);
var min = items.Min(i => i.Price);
var max = items.Max(i => i.Price);
var count = items.Count();
var countFiltered = items.Count(i => i.IsActive);
```

## Best Practices

### Use LINQ for Readability

```csharp
// Verbose loop
var names = new List<string>();
foreach (var user in users)
{
    if (user.IsActive)
    {
        names.Add(user.Name);
    }
}

// LINQ - more readable
var names = users
    .Where(u => u.IsActive)
    .Select(u => u.Name)
    .ToList();
```

### Materialize When Needed

LINQ uses deferred execution. Materialize with `ToList()` or `ToArray()` when:

- Results will be enumerated multiple times
- Data should be captured at a point in time
- Working with database queries

```csharp
// Deferred - query executes each iteration
var query = users.Where(u => u.IsActive);

// Materialized - query executes once
var list = users.Where(u => u.IsActive).ToList();
```

### Use Method Syntax

```csharp
// Query syntax (less common now)
var querySyntax = from u in users
                  where u.IsActive
                  select u.Name;

// Method syntax (preferred)
var methodSyntax = users
    .Where(u => u.IsActive)
    .Select(u => u.Name);
```

### Chain Operations

```csharp
var result = users
    .Where(u => u.IsActive)
    .OrderBy(u => u.Name)
    .GroupBy(u => u.Role)
    .Select(g => new { Role = g.Key, Count = g.Count() })
    .ToList();
```

## Common Patterns

### Pagination

```csharp
public static class QueryableExtensions
{
    public static async Task<PagedResult<T>> ToPagedAsync<T>(
        this IQueryable<T> query,
        int page,
        int pageSize)
    {
        var total = await query.CountAsync();
        var items = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();

        return new PagedResult<T>(items, total, page, pageSize);
    }
}
```

### Lookup Table

```csharp
// Create efficient lookup for repeated access
var lookup = orders.ToLookup(o => o.CustomerId);

// Access all orders for a customer
var customerOrders = lookup[customerId];
```

### Left Join

```csharp
var result = from u in users
             join r in roles on u.RoleId equals r.Id into roleGroup
             from r in roleGroup.DefaultIfEmpty()
             select new { User = u, Role = r?.Name ?? "None" };
```
