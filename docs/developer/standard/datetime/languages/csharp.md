# Date/Time in C#/.NET

## Native Types

.NET has comprehensive built-in date/time types.

## Types

### DateTime

Date + time, optionally with Kind (Utc, Local, Unspecified).

**Warning:** `DateTime` with `Kind = Local` is ambiguous. Prefer `DateTimeOffset` for most cases.

```csharp
// Create
var now = DateTime.Now;        // Kind = Local
var utcNow = DateTime.UtcNow;  // Kind = Utc
var specific = new DateTime(2024, 3, 15, 14, 30, 0);

// Components
specific.Year;    // 2024
specific.Month;   // 3
specific.Day;     // 15
specific.Hour;    // 14
specific.Kind;    // Unspecified

// Operations
var tomorrow = specific.AddDays(1);
var nextMonth = specific.AddMonths(1);

// Formatting
specific.ToString("yyyy-MM-dd HH:mm:ss");
```

### DateTimeOffset

Date + time + UTC offset. Unambiguous point in time.

```csharp
// Create
var now = DateTimeOffset.Now;           // With local offset
var utcNow = DateTimeOffset.UtcNow;     // Offset = +00:00
var specific = new DateTimeOffset(2024, 3, 15, 14, 30, 0, TimeSpan.FromHours(-5));

// From DateTime
var fromDateTime = new DateTimeOffset(dateTime, TimeSpan.FromHours(-5));

// Components
specific.Offset;    // -05:00:00
specific.UtcDateTime;  // DateTime in UTC
specific.LocalDateTime; // DateTime in local zone

// Operations
var later = specific.AddHours(2);

// Convert timezone
var eastern = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
var inEastern = TimeZoneInfo.ConvertTime(specific, eastern);
```

### DateOnly

Date without time component (.NET 6+).

```csharp
// Create
var date = new DateOnly(2024, 3, 15);
var today = DateOnly.FromDateTime(DateTime.Now);

// Components
date.Year;   // 2024
date.Month;  // 3
date.Day;    // 15
date.DayOfWeek; // DayOfWeek.Friday

// Operations
var tomorrow = date.AddDays(1);
var nextMonth = date.AddMonths(1);

// Parsing
var parsedIso = DateOnly.Parse("2024-03-15");
var parsedExact = DateOnly.ParseExact("03/15/2024", "MM/dd/yyyy");

// Formatting
date.ToString("yyyy-MM-dd"); // "2024-03-15"
```

### TimeOnly

Time without date component (NET 6+).

```csharp
// Create
var time = new TimeOnly(14, 30, 0);
var now = TimeOnly.FromDateTime(DateTime.Now);

// Components
time.Hour;     // 14
time.Minute;   // 30
time.Second;   // 0

// Operations
var later = time.AddHours(2);
var rounded = new TimeOnly(time.Ticks / TimeSpan.TicksPerMinute * TimeSpan.TicksPerMinute);

// Comparison
time.IsBetween(new TimeOnly(9, 0), new TimeOnly(17, 0)); // true if 9 AM - 5 PM

// Parsing
var parsed = TimeOnly.Parse("14:30:00");
```

### TimeSpan

Duration of time.

```csharp
// Create
var durationHours = TimeSpan.FromHours(2);
var durationMinutes = TimeSpan.FromMinutes(30);
var durationHms = new TimeSpan(2, 30, 0); // 2h 30m 0s

// Components
durationHms.TotalHours;   // 2.5
durationHms.TotalMinutes; // 150
durationHms.Hours;        // 2
durationHms.Minutes;      // 30

// Operations
var doubled = durationHms + durationHms;
var negated = durationHms.Negate();

// Add to DateTime
var deadline = DateTime.UtcNow.Add(durationHms);
```

### TimeZoneInfo

Timezone information and conversion.

```csharp
// Get timezone
var utc = TimeZoneInfo.Utc;
var eastern = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
var local = TimeZoneInfo.Local;

// Note: IANA IDs (e.g., "America/New_York") require .NET 6+ with ICU on Windows.
// Windows-only platforms may need Windows IDs (e.g., "Eastern Standard Time").

// List all timezones
var allZones = TimeZoneInfo.GetSystemTimeZones();

// Convert
var utcTime = DateTime.UtcNow;
var easternTime = TimeZoneInfo.ConvertTimeFromUtc(utcTime, eastern);

// Check DST
eastern.IsDaylightSavingTime(easternTime);
```

## Best Practices

### Prefer DateTimeOffset Over DateTime

```csharp
// WRONG - Ambiguous, Kind may be Unspecified
var timestamp = DateTime.Parse("2024-03-15T14:30:00");

// RIGHT - Unambiguous point in time
var timestamp = DateTimeOffset.Parse("2024-03-15T14:30:00Z");
```

### Use DateOnly for Birthdays

```csharp
public record Person(string Name, DateOnly Birthday);

var person = new Person("Alice", new DateOnly(1990, 3, 15));

// Calculate age
var today = DateOnly.FromDateTime(DateTime.Today);
var age = today.Year - person.Birthday.Year;
if (person.Birthday > today.AddYears(-age)) age--;
```

### Use TimeOnly for Store Hours

```csharp
public record StoreHours(TimeOnly OpensAt, TimeOnly ClosesAt);

var hours = new StoreHours(
    OpensAt: new TimeOnly(9, 0),
    ClosesAt: new TimeOnly(17, 0)
);

var now = TimeOnly.FromDateTime(DateTime.Now);
var isOpen = now.IsBetween(hours.OpensAt, hours.ClosesAt);
```

### Store UTC, Display Local

```csharp
// Store in database
public record Order(
    Guid Id,
    DateTimeOffset CreatedAt  // Always UTC
);

var order = new Order(
    Id: Guid.NewGuid(),
    CreatedAt: DateTimeOffset.UtcNow
);

// Display in user's timezone
var userZone = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
var localTime = TimeZoneInfo.ConvertTime(order.CreatedAt, userZone);
```

## JSON Serialization

```csharp
// System.Text.Json handles these automatically
public record Event(
    DateTimeOffset Timestamp,
    DateOnly EventDate,
    TimeOnly StartTime
);

var json = JsonSerializer.Serialize(new Event(
    Timestamp: DateTimeOffset.UtcNow,
    EventDate: DateOnly.FromDateTime(DateTime.Today),
    StartTime: new TimeOnly(14, 30)
));

// JSON output:
// {"Timestamp":"2024-03-15T14:30:00Z","EventDate":"2024-03-15","StartTime":"14:30:00"}
```

## Formatting

```csharp
var dto = DateTimeOffset.UtcNow;

// Standard formats
dto.ToString("o");   // ISO 8601: 2024-03-15T14:30:00.0000000Z
dto.ToString("R");   // RFC 1123: Fri, 15 Mar 2024 14:30:00 GMT
dto.ToString("u");   // Universal sortable: 2024-03-15 14:30:00Z

// Custom formats
dto.ToString("yyyy-MM-dd HH:mm:ss zzz");
// 2024-03-15 14:30:00 +00:00
```
