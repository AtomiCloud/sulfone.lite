# Keep Latest Resolver

A CyanPrint v4 resolver.

This resolver merges two files at a time. It receives `{ path, config, current, next }` and returns `{ path, content }`. CyanPrint folds N conflicting candidates by calling it repeatedly in a deterministic order. Set `api: 2` in `cyan.yaml`; if your merge is order-independent, set `commutative: true`.

## Test

```bash
cyanprint test .
```

## Push

```bash
CYANPRINT_TOKEN="<token>" cyanprint push .
```
