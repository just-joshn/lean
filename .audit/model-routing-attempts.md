# Model routing and attempts.

## Behavior

The complete seams select executable handlers. The source branch order keeps the earlier provider-specific and text-completion conditions ahead of the compatible bucket. Bedrock builds the captured Converse body and reaches the transport, then fails at the response-conversion gate. OpenRouter, Portkey, and Requesty select dedicated components that refuse rather than fall through to the generic model. Fallback, model-list, and streaming paths are explicit gates.

OpenAI chat uses the SDK retry budget with jitter, then the wrapper. A persistent timeout exhausts the SDK budget and makes one wrapper call without another SDK budget. Cancellation is terminal. Every attempt gets a fresh timeout signal. Anthropic and Responses use the wrapper only and do not inherit the chat SDK loop. The outer four-second retry owner is unchanged.

## Verification

The model suite passes 135 tests across eight files, including 43 attempt-policy tests. `bun check` passes 56 files and the formatter passes 61. The owner used fake transport functions, injected sleeps, and seeded randomness. No HTTP, fetch, live provider, install, Docker, full-suite run, or hook was used.

## Open gates

- Earlier provider-specific branches, compatible-provider defaults, credential resolution, transforms, and unsampled provider-selection rules.
- Bedrock AWS endpoint selection, SigV4 signing, successful response conversion, usage, non-text content, tool replay, and extended cache controls.
- Dedicated OpenRouter, Portkey, and Requesty component behavior; only selection and refusal are implemented.
- Fallback and model-list dispatch, streaming, and additional provider model variants.
- Fresh source execution of HTTP 429 and retry headers; other retry strategies, global policy, provider exception mapping, and unsampled Responses paths.
- Usage and cost, the held Responses request checks, and the remaining serialization gates.
