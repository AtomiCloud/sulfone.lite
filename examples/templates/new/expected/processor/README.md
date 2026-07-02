# Trim Lines Processor

A CyanPrint v4 processor.

This processor receives `(input, fs)`. Use `fs.read()` to load the input files as a VFS, transform them, and `fs.write(files)` to emit the result. `input.inputDir` and `input.outputDir` stay available for raw filesystem access. Keep output deterministic.

## Test

```bash
cyanprint test .
```

## Push

```bash
CYANPRINT_TOKEN="<token>" cyanprint push .
```
