# Service Template

A CyanPrint v4 template.

This artifact is a folder-first CyanPrint template. It asks questions in `cyan.ts`, returns pure data, and lets the CyanPrint CLI run processors and merge output.

## Test

```bash
cyanprint test . --answers answers.json
```

## Push

```bash
cyanprint push . --token "$CYANPRINT_TOKEN"
```
