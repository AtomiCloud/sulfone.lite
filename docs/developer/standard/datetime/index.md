# Date/Time Handling

Date and time handling is notoriously error-prone. This guide defines the types, patterns, and best practices for working with dates, times, timezones, and durations across AtomiCloud projects.

This article builds on [Domain Modeling](../domain-driven-design/index.md) and [Software Design Philosophy](../software-design-philosophy/index.md). Understanding domain types helps choose the right date/time representation.

---

## Core Concepts

### Instant

A specific point on the global timeline. Instants are timezone-agnostic—they represent the same moment everywhere on Earth.

**Use when:**

- Timestamping events (created_at, updated_at)
- Logging and auditing
- Scheduling future events
- Measuring elapsed time

**Example:** `2024-03-15T14:30:00Z` is the same instant whether you're in New York or Tokyo.

### Date

A calendar date without time or timezone. Represents "what day on the calendar."

**Use when:**

- Birthdays
- Holidays
- Due dates (when time doesn't matter)
- Reporting periods

**Example:** March 15, 2024—no associated time.

### Time

A time of day without date or timezone. Represents "what time on a clock."

**Use when:**

- Store hours (opens at 9:00 AM)
- Recurring schedules (meeting at 2:00 PM)
- Time-based rules (no logins before 6:00 AM)

**Example:** 14:30:00—no associated date.

### DateTime

A combination of date and time. Can be timezone-aware or timezone-naive.

**Warning:** Timezone-naive DateTimes are ambiguous. Always prefer timezone-aware types.

**Use when:**

- Events with specific times (meeting at March 15, 2:00 PM EST)
- Scheduling with local context

### Offset

A fixed offset from UTC (e.g., +05:00, -08:00). Unlike timezones, offsets don't change with DST.

**Use when:**

- Storing unambiguous points in time
- Interoperating with systems that use offsets

### Timezone

A region with rules for UTC offset, including DST transitions. Examples: "America/New_York", "Europe/London".

**Use when:**

- Displaying times to users in their local context
- Recurring events that must respect DST changes

**Warning:** Never store "EST" or "PST"—these are abbreviations, not timezones. Use IANA identifiers like "America/New_York".

### Duration

An amount of time (e.g., 2 hours, 30 minutes). Durations are timezone-independent.

**Use when:**

- Timeouts and deadlines
- Measuring elapsed time
- Intervals (every 15 minutes)

---

## When to Use Each Type

| Scenario               | Type                | Why                                |
| ---------------------- | ------------------- | ---------------------------------- |
| `created_at` timestamp | Instant             | Unambiguous point in time          |
| User's birthday        | Date                | No time component, same everywhere |
| Store opening time     | Time                | Recurring daily, no date           |
| Meeting invitation     | DateTime + Timezone | Specific moment in a location      |
| "3 hours from now"     | Instant + Duration  | Calculate from now                 |
| Due date (end of day)  | Date                | Time doesn't matter                |
| Session timeout        | Duration            | Amount of time, not a point        |
| Flight departure       | Instant             | Precise moment, stored in UTC      |

---

## Choosing the Right Type for Your Use Case

The type you choose depends on **what you're representing** and **where the values live**.

| Use Case            | What to Store                     | Where to Store                                  | Why                                                          |
| ------------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| **Birthday**        | `Date` + `Timezone`               | Date on entity, TZ for context                  | Only need calendar date; TZ provides "start of day" context  |
| **Alarm/Reminder**  | `Time` + `DayOfWeek` + `Timezone` | Time/DoW on alarm entity, **TZ on user/device** | When user moves countries, alarm fires at correct local time |
| **Event Timestamp** | `Instant`                         | On the event entity                             | Point-in-time, globally unambiguous, sortable                |
| **Meeting**         | `DateTime` + `Timezone`           | Both on meeting entity                          | Specific date+time at a location                             |

---

## Database Sortability

All datetime values stored in DB must be sortable for efficient querying.

| Type              | Storage Format                                | Sortable              |
| ----------------- | --------------------------------------------- | --------------------- |
| `Instant`         | ISO 8601 / Unix timestamp                     | ✅ Yes                |
| `Date`            | `YYYY-MM-DD`                                  | ✅ Yes                |
| `Time`            | `HH:MM:SS`                                    | ✅ Yes (within a day) |
| `DateTime` + `TZ` | Store as `Instant` (UTC), store TZ separately | ✅ Yes                |

**Rule:** Always store in a format that preserves chronological ordering. For zoned datetimes, store the instant AND the timezone separately.

---

## Where to Store Timezone

A critical design decision—timezone belongs at the right level of your domain:

| Use Case           | Timezone Location       | Reasoning                                                                    |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| **Alarm/Reminder** | User/Device preferences | User moves → timezone updates → all alarms adjust automatically              |
| **Meeting**        | Meeting entity          | Meeting is at a specific location/timezone                                   |
| **Birthday**       | Entity (or omit)        | Birthday is a calendar date; timezone is optional context for "start of day" |
| **Log/Audit**      | Omit (use UTC)          | System events are global, no user context                                    |

**Anti-pattern:** Don't hardcode timezone on time values when the timezone should be inherited from user/device preferences.

**Example - Alarm Done Right:**

```yaml
User {
  id: "user-123"
  timezone: "America/New_York"  // ← TZ lives here
}

Alarm {
  id: "alarm-456"
  userId: "user-123"
  time: "07:00:00"              // ← Just time, no TZ
  daysOfWeek: ["MON", "TUE", "WED", "THU", "FRI"]
}
```

When the user moves to "Europe/London", update the user's timezone once—all alarms automatically adjust.

---

## Key Principles

1. **Match granularity to use case** — Don't store an Instant when a Date will do
2. **Store timezone at the right level** — User/device for recurring events, entity for fixed events
3. **Always be sortable** — Choose storage formats that preserve chronological order
4. **Separate storage from display** — Store in UTC/Instant, convert to user's timezone for display

---

## Common Pitfalls

### 1. Timezone Confusion

```typescript
// WRONG - Uses local time, ambiguous
const createdAt = new Date();

// RIGHT - Explicitly UTC
const createdAt = Temporal.Now.instant();
```

### 2. DST Transitions

During DST "spring forward," 2:00 AM becomes 3:00 AM—some times don't exist. During "fall back," 2:00 AM happens twice.

```csharp
// WRONG - May fail during DST transition
var nextDay = dateTime.AddDays(1);

// RIGHT - Use UTC to avoid DST issues
var nextDay = DateTimeOffset.UtcNow.AddHours(24);
```

### 3. Birthday Timezone Problem

If a user's birthday is March 15, it should remain March 15 regardless of timezone.

```go
// Use carbon.Date for birthdays - no time or timezone
birthday := carbon.Date{Year: 1990, Month: 3, Day: 15}
```

### 4. Ambiguous `DateTime.Now`

In C#, `DateTime.Now` has `Kind = Local`, which is ambiguous.

```csharp
// WRONG - Kind is Local, ambiguous
var now = DateTime.Now;

// RIGHT - Unambiguous UTC
var now = DateTimeOffset.UtcNow;
```

---

## Storage vs Display

**Always store timestamped instants (Instants/DateTimes) in UTC.** Convert to local time only for display. Note: Date-only and Time-only values (birthdays, store hours) are exempt—store those as local or domain-specific types without UTC conversion.

| Storage | Display                         |
| ------- | ------------------------------- |
| Instant | ZonedDateTime (user's timezone) |
| UTC     | Local time                      |

This ensures:

- Consistent ordering across servers
- No ambiguity during timezone transitions
- Simple comparison operations

---

## Quick Checklist

**For Timestamps:**

- [ ] Use Instant type (not local DateTime)
- [ ] Store in UTC
- [ ] Convert to user's timezone only for display

**For Dates (birthdays, holidays):**

- [ ] Use Date-only type (PlainDate, DateOnly, carbon.Date)
- [ ] No time component
- [ ] No timezone component

**For Times (daily schedules):**

- [ ] Use Time-only type (PlainTime, TimeOnly, carbon.Time)
- [ ] Consider timezone for display

**For Durations:**

- [ ] Use Duration type, not integers
- [ ] Prefer built-in duration types over custom implementations

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md) — Temporal API via `@js-temporal/polyfill`
- [C#/.NET](./languages/csharp.md) — Native types: DateTime, DateTimeOffset, DateOnly, TimeOnly
- [Go](./languages/go.md) — Carbon library (`dromara/carbon/v2`) + `time.Duration`

## Related Articles

- [Domain Modeling](../domain-driven-design/index.md) — Date/time as domain types
- [Validation](../validation/index.md) — Validating date inputs
