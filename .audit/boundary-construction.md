# Boundary construction, configuration, and loading.

## Behavior

Configuration now has one inherited field table for hydration, validation, and serialization. Required fields, the sampled coercions, and the exact `ValidationError` messages, locations, inputs, and contexts are preserved. Callable `config_class`, dictionary selection, subclass normalization, duplicate-argument errors, supplied dictionary shallow copies, and independent defaults are covered. `PosixPath` values and JSON-mode path serialization follow the source.

Native classes load synchronously through the actual public factories. Builtin shortcuts, dotted names, and native imports share constructor identity. The sampled factory precedence, direct-subclass identity, deep-copied configs, model-name precedence, suffix replacement, file-search precedence, and YAML loading are corrected. Captured module defaults remain raw, including the invalid omitted cost-tracking default and the empty Docker executable.

## Verification

The saved construction baseline moves from 17 mismatches of 21 to zero, the fresh public-constructor replay from 18 of 21 to zero, and the loading baseline from 9 failures of 16 to zero. The focused suite passes 160 tests with one todo across ten files. `bun check` passes 71 files and the formatter passes 80. No full suite, Docker execution, install, hook, commit, or push was used.

## Offline control incident

Two initial reference registry probes imported LiteLLM before forcing the local pricing map, and that import attempted a pricing fetch. No provider was called. The controls were rerun with local pricing forced and socket connections blocked. The saved results matched, and the evidence records zero network attempts.

## Open gates

- Startup dotenv ordering, quoting, interpolation, setup persistence, reload precedence, and first-run help.
- Actual CLI parsing-to-construction and run or save comparisons, including empty output, task precedence, and numeric parsing.
- Missing required model and environment inventory; no substitute aliases were added.
- Ordinary JavaScript initialized-field config subclasses; only the selected static-field syntax is verified.
- Coercions and error representations outside the saved cases, including malformed bytes, nested dictionary and path errors, large integers, and nonfinite integer inputs.
- Nonfinite trajectory encoding and nested `model_dump` copy semantics.
- YAML behavior outside the saved controls, malformed YAML and registry error equivalence, and the complete unknown-class diagnostic.
- Full environment and process acceptance.
