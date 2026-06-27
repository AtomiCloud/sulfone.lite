---
name: datetime
description: Date and time handling across languages using Temporal (TS), native types (C#), and Carbon (Go). Use when working with dates, times, timezones, durations, or scheduling.
invocation:
  - datetime
  - date
  - time
  - timezone
  - duration
  - instant
  - temporal
  - carbon
  - schedule
  - calendar
---

# Date/Time Handling

## Quick Reference

### Types by Purpose

| Use Case          | TypeScript               | C#                          | Go                |
| ----------------- | ------------------------ | --------------------------- | ----------------- |
| **Point in time** | `Temporal.Instant`       | `DateTimeOffset`            | `carbon.Carbon`   |
| **Date only**     | `Temporal.PlainDate`     | `DateOnly`                  | `carbon.Date`     |
| **Time only**     | `Temporal.PlainTime`     | `TimeOnly`                  | `carbon.Time`     |
| **Date + Time**   | `Temporal.PlainDateTime` | `DateTime` (kind=Local/Utc) | `carbon.DateTime` |
| **With timezone** | `Temporal.ZonedDateTime` | `DateTimeOffset`            | `carbon.Carbon`   |
| **Duration**      | `Temporal.Duration`      | `TimeSpan`                  | `time.Duration`   |
| **Timezone info** | `Temporal.TimeZone`      | `TimeZoneInfo`              | `carbon.Carbon`   |

### Library Support

| Language       | Library/Type System                         |
| -------------- | ------------------------------------------- |
| TypeScript/Bun | `@js-temporal/polyfill` (Temporal API)      |
| C#/.NET        | Native (`DateTime`, `DateTimeOffset`, etc.) |
| Go             | `dromara/carbon/v2` + `time.Duration`       |

## Core Principles

1. **Know Your Types** — Instant (point in time), Date (calendar), Time (clock), Duration (elapsed)
2. **Timezone Awareness** — Always be explicit about timezones; prefer UTC for storage
3. **Use the Right Type** — DateOnly for birthdays, Instant for timestamps, Duration for intervals
4. **Avoid `Date` Object in JS** — Use Temporal; native Date is broken (months 0-indexed, etc.)
5. **Prefer `DateTimeOffset` in C#** — Unambiguous point in time; avoid `DateTime` kind confusion
6. **Carbon for Go** — Rich date/time operations beyond standard `time` package

## Common Pitfalls

| Pitfall                    | Problem                     | Solution                             |
| -------------------------- | --------------------------- | ------------------------------------ |
| Timezone confusion         | System vs user vs UTC       | Always store UTC, display local      |
| DST transitions            | 1 hour may not equal 1 hour | Use Instant/Durations for scheduling |
| Birthday in wrong tz       | Date changes with timezone  | Use PlainDate/DateOnly for birthdays |
| `DateTime.Now` in C#       | Kind=Local, ambiguous       | Use `DateTimeOffset.UtcNow`          |
| JS `Date` month index      | Months are 0-indexed        | Use Temporal API                     |
| `time.Sleep` for durations | Not precise, blocks thread  | Use `time.Duration` calculations     |

## See Also

Full documentation: [datetime/](../../../docs/developer/standard/datetime/)

Related skills:

- [`/validation`](../validation/) — For validating date inputs
- [`/domain-modeling`](../domain-modeling/) — For date/time domain types
