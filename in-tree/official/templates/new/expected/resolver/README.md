# Keep Latest Resolver

A CyanPrint v4 resolver.

This resolver receives all versions of the same path and folds them into one output. Use resolvers when multiple templates may touch the same file.

## Test

```bash
cyanprint test .
```

## Push

```bash
cyanprint push . --token "$CYANPRINT_TOKEN"
```
