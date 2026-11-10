# Model review fixes.

## Behavior

The nine model review threads are fixed at their public seams.

`Retry-After` accepts the source delta and email date forms through the public parser boundary. An ISO date is not parsed, so a 500 stays retryable. Tier selection matches by range across all tiers first. An unpriced matching tier abandons tier pricing instead of taking the last priced tier. Dashscope bills completion minus reasoning. xAI adds unnormalized reasoning into completion and clears the detail billing. Both use the source arithmetic, and the tests add distinct output and reasoning rates.

Bedrock hoists only a leading system prefix. A later system turn stays in the user turn with the operator note. Tool arguments come from one native parse that keeps each number's `context.source`, and serialization walks the actual tool input tree. A bad parse throws instead of falling back to altered arguments. A missing `tool_calls` list becomes an empty action list and the action parser raises `FormatError` with the cost and response. Boolean temperature accepts numeric `1` or boolean `true` and spells `False` in the error. A schemeless base is a non-OpenAI host. The FormatError response uses a repr-like dump.

## Verification

The model suite passes 619 tests with 19 existing todos across twelve files. `bun check` passes 63 files and the formatter passes 73. The date parser was checked under a Honolulu timezone: absent, unknown, and `-0000` offsets wait 30000 ms, and an ISO header waits the 500 ms jitter. The tool-argument check keeps the outer and nested floats on the correct calls and throws on broken JSON. No live provider, network, install, Docker, signal, full suite, or hook was used.

## Open gates

- The nine serialization and ten request todos remain.
- The provider, billing, streaming, and further error paths remain as declared in the model audit notes.
