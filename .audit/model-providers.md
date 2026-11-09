# Provider scope.

## Behavior

Bedrock Converse now converts the captured response shape. Text, tool calls, empty content, sampled stop reasons, cached and uncached usage, and the missing total are covered. The request body and its existing gates are unchanged. AWS endpoint selection and SigV4 stay a no-send gate.

Dedicated OpenRouter and Requesty components preserve their raw dictionary responses and their source configuration dumps. Request bodies, headers, kwargs precedence, returned messages, actions, cost, timestamps, and FormatError persistence are covered. HTTP 401, 429, and 500 and the source cost policies are covered. Portkey preserves the missing-key error and keeps positive requests gated. Model-class selection stays separate from provider-prefix routing.

The comment review fixes are included. Absent usage and explicit null are distinct. Non-array tool calls gate instead of becoming an empty list. The request tests assert POST and the single Bedrock send. The Portkey test compares both the error name and the complete message.

## Verification

The model suite passes 347 tests with 10 existing todos across eleven files. `bun check` passes 61 files and the formatter passes 68. The capture script pins reference commit `04d809ce`, records source hashes and package versions, and forbids network connections. Bedrock controls run through the real reference completion path with an intercepted transport. No HTTP, fetch, live provider, install, Docker, full-suite run, or hook was used.

## Open gates

- Portkey SDK requests, nested response serialization, and cost conversion.
- AWS default endpoint selection, credentials, and SigV4 signing.
- Bedrock non-text, tool-replay, parameter, cache-control, and `extra_body` requests; reasoning, citations, trace, service tier, unsampled stop reasons, cache TTL splits, usage aliases, fractional counts, and malformed shapes.
- Bedrock connected query, replay, and billing parity.
- Dedicated-provider malformed responses, non-numeric cost-error representation, network-error details, redirects, and unsampled retry and timeout behavior.
- Streaming, non-OpenAI Responses providers, other provider handlers, and the remaining serialization gates.
