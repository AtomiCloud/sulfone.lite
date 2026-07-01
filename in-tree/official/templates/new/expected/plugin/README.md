# Footer Plugin

A CyanPrint v4 plugin.

This plugin receives `(input, helper)` after processors have merged. Use `helper.read()` / `helper.write()` for the output folder and `helper.exec()` to run idempotent commands such as `git init`. `input.outputDir` stays available for raw access.

## Test

```bash
cyanprint test .
```

## Push

```bash
CYANPRINT_TOKEN="<token>" cyanprint push .
```
