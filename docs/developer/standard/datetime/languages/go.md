# Date/Time in Go

## Library: `dromara/carbon/v2` + `time.Duration`

Use Carbon for rich date/time operations. Use `time.Duration` for durations.

```bash
go get github.com/dromara/carbon/v2
```

```go
import (
    "github.com/dromara/carbon/v2"
    "time"
)
```

## Types

### carbon.Carbon

A point in time with timezone support. The primary type for most operations.

```go
// Create
now := carbon.Now()                    // Local time
utc := carbon.Now(carbon.UTC)          // UTC
specific := carbon.Parse("2024-03-15 14:30:00")

// From time.Time
c := carbon.CreateFromTime(time.Now())

// Components
c.Year()        // 2024
c.Month()       // 3
c.Day()         // 15
c.Hour()        // 14
c.Minute()      // 30
c.Second()      // 0
c.Timezone()    // "UTC" or local

// Operations
tomorrow := c.AddDays(1)
nextMonth := c.AddMonths(1)
nextWeek := c.AddWeeks(1)

// Comparison
c.Gt(other)     // c > other
c.Lt(other)     // c < other
c.Eq(other)     // c == other
c.IsToday()
c.IsWeekend()

// Formatting
c.ToDateTimeString()      // "2024-03-15 14:30:00"
c.ToDateString()          // "2024-03-15"
c.ToTimeString()          // "14:30:00"
c.ToIso8601String()       // "2024-03-15T14:30:00Z"
```

### carbon.Date

Date only (no time component).

```go
// Create
date := carbon.Date{Year: 2024, Month: 3, Day: 15}
dateFromNow := carbon.DateFromCarbon(carbon.Now())

// Components
date.Year   // 2024
date.Month  // 3
date.Day    // 15

// To Carbon
c := date.ToCarbon()
```

### carbon.Time

Time only (no date component).

```go
// Create
t := carbon.Time{Hour: 14, Minute: 30, Second: 0}
tFromNow := carbon.TimeFromCarbon(carbon.Now())

// Components
t.Hour    // 14
t.Minute  // 30
t.Second  // 0

// To Carbon
c := t.ToCarbon()
```

### carbon.DateTime

Date + time (no timezone).

```go
// Create
dt := carbon.DateTime{
    Year: 2024, Month: 3, Day: 15,
    Hour: 14, Minute: 30, Second: 0,
}

// From Carbon
dtFromNow := carbon.DateTimeFromCarbon(carbon.Now())

// To Carbon
c := dt.ToCarbon()
```

### time.Duration

Duration of time (standard library).

```go
// Create
duration := 2 * time.Hour
duration30m := 30 * time.Minute
duration1500ms := 1500 * time.Millisecond

// Components
duration.Hours()         // float64 hours
duration.Minutes()       // float64 minutes
duration.Seconds()       // float64 seconds
duration.Milliseconds()  // int64 milliseconds

// Parse from string
d, _ := time.ParseDuration("2h30m")

// Add to Carbon
later := carbon.Now().AddDuration("2h30m")
later30m := carbon.Now().AddMinutes(30)
```

## Timezone Handling

```go
// Create with timezone
ny := carbon.Now(carbon.NewYork)       // America/New_York
tokyo := carbon.Now(carbon.Tokyo)      // Asia/Tokyo
utc := carbon.Now(carbon.UTC)          // UTC

// Convert timezone
local := carbon.Now()
utc := local.SetTimezone(carbon.UTC)

// Custom timezone
tz, _ := carbon.LoadLocation("America/Los_Angeles")
la := carbon.Now(tz)
```

## JSON Serialization

Carbon types implement `json.Marshaler` and `json.Unmarshaler`.

```go
type Event struct {
    Timestamp carbon.Carbon `json:"timestamp"`
    Date      carbon.Date   `json:"date"`
    Time      carbon.Time   `json:"time"`
}

// Marshal
event := Event{
    Timestamp: carbon.Now(),
    Date:      carbon.Date{Year: 2024, Month: 3, Day: 15},
    Time:      carbon.Time{Hour: 14, Minute: 30, Second: 0},
}
data, _ := json.Marshal(event)
// {"timestamp":"2024-03-15T14:30:00Z","date":"2024-03-15","time":"14:30:00"}

// Unmarshal
var parsed Event
json.Unmarshal(data, &parsed)
```

### Custom Format

```go
type CustomTime struct {
    carbon.Carbon
}

func (ct CustomTime) MarshalJSON() ([]byte, error) {
    return []byte(`"` + ct.ToIso8601String() + `"`), nil
}

func (ct *CustomTime) UnmarshalJSON(data []byte) error {
    s := string(data)
    s = strings.Trim(s, `"`)
    ct.Carbon = carbon.Parse(s)
    return nil
}
```

## Best Practices

### Store UTC, Display Local

```go
// Store in UTC
timestamp := carbon.Now(carbon.UTC)

// Display in user's timezone
userTime := timestamp.SetTimezone(carbon.NewYork)
fmt.Println(userTime.ToDateTimeString())
```

### Use carbon.Date for Birthdays

```go
type Person struct {
    Name     string
    Birthday carbon.Date
}

person := Person{
    Name:     "Alice",
    Birthday: carbon.Date{Year: 1990, Month: 3, Day: 15},
}

// Calculate age
today := carbon.Now()
birthday := person.Birthday.ToCarbon()
age := today.Year() - birthday.Year()
if birthday.SetYear(today.Year()).Gt(today) {
    age--
}
```

### Use carbon.Time for Store Hours

```go
type StoreHours struct {
    OpensAt  carbon.Time
    ClosesAt carbon.Time
}

hours := StoreHours{
    OpensAt:  carbon.Time{Hour: 9, Minute: 0, Second: 0},
    ClosesAt: carbon.Time{Hour: 17, Minute: 0, Second: 0},
}

now := carbon.Now()
currentTime := carbon.Time{Hour: now.Hour(), Minute: now.Minute(), Second: now.Second()}

isOpen := currentTime.ToCarbon().Gte(hours.OpensAt.ToCarbon()) &&
          currentTime.ToCarbon().Lte(hours.ClosesAt.ToCarbon())
```

### Use time.Duration for Timeouts

```go
const timeout = 30 * time.Second

ctx, cancel := context.WithTimeout(context.Background(), timeout)
defer cancel()

// Or calculate deadline
deadline := time.Now().Add(timeout)
```

## Common Patterns

### Difference Between Dates

```go
start := carbon.Parse("2024-03-15")
end := carbon.Parse("2024-03-20")

days := end.DiffInDays(start)          // 5
hours := end.DiffInHours(start)        // 120
duration := end.DiffAsDuration(start)  // time.Duration
```

### Start/End of Period

```go
c := carbon.Now()

startOfDay := c.StartOfDay()
endOfDay := c.EndOfDay()
startOfWeek := c.StartOfWeek()
endOfWeek := c.EndOfWeek()
startOfMonth := c.StartOfMonth()
endOfMonth := c.EndOfMonth()
```

### Is Workday/Weekend

```go
c := carbon.Now()

if c.IsWeekend() {
    // Weekend logic
}

if c.IsWorkday() {
    // Workday logic
}
```

## Comparison with Standard Library

| Feature         | `time.Time`          | `carbon.Carbon`             |
| --------------- | -------------------- | --------------------------- |
| Date arithmetic | Manual (AddDate)     | Fluent (AddDays, AddMonths) |
| Comparison      | Before(), After()    | Gt(), Lt(), Eq() + more     |
| Formatting      | Format("2006-01-02") | ToDateString(), etc.        |
| Timezone        | In(loc)              | SetTimezone()               |
| JSON            | RFC 3339 only        | Multiple formats            |
| IsWeekend       | Manual check         | Built-in                    |
| StartOfDay      | Manual               | Built-in                    |

Use `time.Time` for simple cases. Use Carbon when you need rich operations.
