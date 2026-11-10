# Remaining Responses serialization.

## Behavior

The Responses return now uses one source-derived field table for the nested output models, their required fields, types, aliases, and representation annotations. Whole-response validation keeps the dictionary fallback, and the sampled coercion precedence is preserved. Dump modes are covered, including iterator consumption. The default success dump and JSON diagnostics stay distinct.

Received text now has two paths. Raw diagnostic text decodes by the declared charset, while JSON parsing uses strict bytes. Charset, BOM, Latin-1, and invalid UTF-8 controls cover the difference. The complete seam maps the sampled OpenAI HTTP errors, including the authentication suffix, and removes its SIGINT listener. The action parser uses the source argument syntax-error wording.

The comment review fixes are included. The capture scripts no longer narrate their purpose. The live assertions compare scalar values, plain dictionaries, and model attributes against the saved controls. The mapped error test checks the local authentication, not-found, and context-window classes. The SIGINT test compares the actual exception name and message.

## Verification

The model suite passes 606 tests with 19 explicit todos across twelve files. The 19 todos are the nine serialization gates and the ten existing request gates. The source controls cover 221 serialization cases, four dump modes, seven decoding cases, twelve HTTP mappings, and thirteen action-parser cases. `bun check` passes 63 files and the formatter passes 73. The two capture scripts assert the installed versions and forbid network connections. No HTTP, fetch, live provider, install, Docker, full-suite run, or hook was used.

## Open gates

- Nested union alternatives beyond the saved minimal and populated-first-branch controls.
- Recursive namespace tools and recursive schema payloads.
- Python-only constructed values, nonfinite numbers, and integers outside JavaScript precision.
- Dump options other than `mode`, and mutation of live provider attributes.
- Allowed-tools iterator partial consumption and delayed invalid-item errors.
- BOM-less UTF-16 and UTF-32, malformed wide encodings, and charsets outside the saved controls.
- Exception remapping after a successful HTTP status with malformed response bytes.
- Provider error statuses, context phrases, and special error bodies outside the saved controls.
- Python JSON extensions and other argument syntax-error combinations.
- The ten existing request gates and streaming.
