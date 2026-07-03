# Keep Latest Resolver

A CyanPrint v4 resolver.

This resolver is invoked once per conflicting path with every variation of that path at once. It receives `{ config, files }` — each `files` entry carries `path`, `content`, and its `origin` (the contributing `template`, its `layer`, and the source `processor` for processor-output merges) — and returns the merged `{ path, content }`. This scaffold keeps the highest layer's content (latest-wins).

## Test

```bash
cyanprint test .
```

## Push

```bash
CYANPRINT_TOKEN="<token>" cyanprint push .
```
