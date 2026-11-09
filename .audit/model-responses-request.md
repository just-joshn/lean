# Held Responses request checks.

## Behavior

The API-owned request module now owns the source-proven Responses transformations. It covers the GPT-5 temperature rejection and drop conditions, explicit reasoning effort, catalog defaults, the chat-model exclusion, `top_p`, the minimum output-token clamp, recursive cache-control stripping, prompt-cache breakpoint renaming, simple top-level schema combinator flattening, foreign tool-call identifier removal, and the Anthropic frequency-penalty punctuation.

The request is built once at the complete seam. The saved controls compare the full serialized body, or the saved error and the absence of a transport call. The replay fixtures now use the source request input rather than a locally derived shape.

## Verification

The model suite passes 317 tests across ten files, with 10 explicit todo entries. The request inventory holds 149 full-body request cases, four focused frequency-penalty cases, and two refusal cases. Seven saved source-file hashes match the cached LiteLLM 1.108.3 reference. `bun check` passes 60 files and the formatter passes 66. The capture script asserts the installed version and forbids socket connections. No HTTP, fetch, live provider, install, Docker, full-suite run, or hook was used.

## Open gates

- Non-OpenAI Responses providers and provider bodies.
- Local, external, and cyclic schema references and recursive combinators.
- Schema `enum`, `const`, and `not`, fine-tuned model names, and `model_info.base_model`.
- Python-regex schema sanitation.
- String-encoded tool schemas and invalid parameter types.
- Tool-search mapping and `defer_loading`.
- Reasoning-item replay conversion and bridge-minted reasoning removal.
- Catalog overrides, hosted-provider cache breakpoints, other reasoning-effort levels, streaming, and the remaining response serialization.
