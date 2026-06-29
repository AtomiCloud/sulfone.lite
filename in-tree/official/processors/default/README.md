# Default Processor

Renders generated text files and file paths with Eta, then normalizes trailing whitespace.

Use this processor for folder-based templates that contain Eta placeholders such as `var__ PROJECT __`.
For compatibility with older CyanPrint templates, the default syntax also supports `__PROJECT__`.

## Config

```yaml
config:
  vars:
    PROJECT: Example
  parser:
    varSyntax:
      - ["var__", "__"]
```

The processor renders each syntax in order against both the path and the text content. Eta runs with `useWith`, no HTML escaping, and no automatic trimming so templates can stay terse and predictable.
