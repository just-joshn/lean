# Model usage and billing.

## Behavior

Usage reaches cost through the real query and complete seams. The Responses totals keep cached input as a subset, normalize input and output detail, and keep unrounded source fractions. Service tiers, reasoning rates, cache-duration prices, and long-context thresholds follow the source tables. The Anthropic conversion sums iteration totals, splits creation durations, keeps reported thinking tokens, and preserves malformed counts for the billing gate. The returned model name is retained.

The comment review fixes are included. Invalid counts are no longer truncated or replaced with zero. Unreported thinking stays null and the billing boundary rejects it. Provider-stated cost survives the Anthropic projection and reaches the existing gate. The explicit-zero billing test now asserts the complete result bills exactly zero as well as the query guard.

## Verification

The model suite passes 162 tests across nine files, including 27 connected billing tests. Seven initial failures reproduced the billing defects. `bun check` passes 58 files and the formatter passes 63. The owner used real complete and query paths with fixture responses and fresh pinned-venv controls with network connections disabled. No HTTP, fetch, install, Docker, full-suite run, or hook was used.

## Open gates

- Unknown or invalid usage, missing prices, unsupported provider schedules, modality-specific prices, provider-stated costs, tool charges, geo and speed schedules, and off-peak windows remain explicit errors.
- Anthropic thinking-token estimation from unreported thinking text is not implemented. Reported counts convert; unknown counts reject.
- Batch and per-request pricing, hidden regional and deployment pricing, and exhaustive provider billing remain unverified.
- Provider bodies, streaming, the held Responses request checks, and the remaining serialization gates are unchanged.
