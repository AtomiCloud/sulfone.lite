# Trim Lines Processor

A CyanPrint v4 processor.

This processor receives `{ files, config }` and returns a file map. Use processors for deterministic file transformations after template files are loaded.

## Test

```bash
cyanprint test .
```

## Push

```bash
cyanprint push . --token "$CYANPRINT_TOKEN"
```
