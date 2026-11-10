# Model hook boundary.

## Selected design

Candidate A is the base. The cross-judge scored it higher on the actual class query path, serialization and raw errors, executable controls, and integration safety. Both candidates converged on an `unknown` customization hook, private API-owned result instances, and dictionary-versus-attribute access. The convergence is architectural, not an implementation-equivalence claim.

The four grafts from candidate B are the callable `model_dump` dictionary control, the live-versus-dumped assertions, the request-defect placement reminder, and the sampled-delay versus jitter-interval distinction.

## Shape

- `request`, `parseActions`, and `costOf` use `unknown` on the actual hierarchy.
- A private response-access module owns the dictionary-versus-attribute reads. Ordinary and null-prototype records are dictionaries. Class instances are attribute objects. `output` and `choices` use attributes only. Finish reason and usage use the dictionary-or-attribute rule. Diagnostics use JSON mode. Successful dumps use the default mode. Chat does not gain the Responses dictionary fallback.
- The builtin complete functions return the private `ResponseResult` wrapper. It is not exported from the package index. It preserves the wire body and exposes live fields, including `model` and `service_tier`.
- The numeric `role` remains an open `Message` type mismatch. The unchecked copy is confined to `messageFromDump`. The shared protocol is unchanged.

## Verification

The red baseline had four failing dictionary tests. The final unit passes 53 tests across five model files, typechecks 48 files, and formats 52 files. No HTTP, live provider, Docker, install, full-suite run, or git hook was executed. The 12 HTTP-dependent model tests remain unrun.

## Open gates

- Exact source representation fallback, cross-realm dictionaries, and unusual constructed values.
- Full Responses validation, construction fallback, nested conversion, serialization defaults, live-versus-dumped filtering, provider-extra retention, and raw-byte diagnostics.
- Connected complete, query, and replay for Responses.
- Routing and provider bodies, including the `UNIMPLEMENTED` providers and the separate OpenRouter, Portkey, and Requesty components.
- SDK and wrapper retry ownership, jitter, timeout versus cancellation, retry headers, HTTP 429, and Responses retry policy.
- Billing corrections for Responses input totals, split cache-creation rates, service tiers, provider reasoning rates, and the other schedules.
- Held Responses request defects: gpt-5 temperature and drop behavior, minimum output tokens, cache-control removal, frequency-penalty punctuation, `top_p`, schema combinators, foreign tool-call IDs, and cache-breakpoint renaming.
- Streaming, live provider shapes, the 12 excluded HTTP tests, and the non-model tests.
- The numeric-role protocol debt and the proof-helper limitations.
