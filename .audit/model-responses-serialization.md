# Model Responses serialization.

## Selected source contract

`Responses` now owns the complete return path. `completeResponses` parses the received text once, converts `created_at`, validates the whole response, and falls back to construction from the original body. A validated response may keep invalid nested records as dictionaries. A constructed response keeps all nested output raw.

The nested field tables cover function, message, reasoning, tool-search, usage, and the top-level nullable defaults the source fixtures prove. Default success dumps and JSON-mode diagnostics are distinct. Null filtering happens on dumps without mutating live output. Provider `extra` survives the return and is stripped only in replay preparation. Raw error text comes from the received bytes, not a parsed-body stringification.

The comment review fixes are included. The response wrappers install provider fields without assigning and deleting `model_dump`. The three model test files use response mocks with a fixed test URL instead of the stale listener façade.

## Verification

The model suite passes 92 tests across seven files. `bun check` passes 51 files. The formatter passes 56 files. The fixture file holds 11 source-derived input and expected-dump cases. No HTTP, fetch, live provider, Docker, install, full-suite run, git hook, or subagent was used.

## Open gates

- Remaining nested output models, union precedence, coercion edges, and non-empty annotation, logprob, and tool conversions.
- Non-JSON dump-mode differences, broader constructed values, and charset, BOM, or invalid-UTF-8 decoding.
- Provider-specific error mapping, authentication suffix, context-window mapping, SIGINT, source parse-error wording, and representation fidelity.
- Routing and provider bodies, including Bedrock Converse, the other source-reachable providers, and the separate OpenRouter, Portkey, and Requesty components.
- Chat SDK and wrapper retry policy, jitter, timeouts, cancellation, retry headers, HTTP 429, and the Responses wrapper and rewrite behavior.
- Connected billing corrections for Responses totals, cache durations, tiers, reasoning, Anthropic usage conversion, and the remaining price schedules.
- The held request checks for gpt-5 temperature, minimum output tokens, cache-control stripping, frequency-penalty punctuation, `top_p`, schema combinators, foreign tool-call IDs, and prompt-cache breakpoint renaming.
- Streaming, live-provider shapes, the numeric-role protocol limitation, and the non-model tests.
