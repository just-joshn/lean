# Model rebase and integration.

## Behavior

The model branch is rebased onto the port branch at `69e3100`. All 16 model commits replay. The audit file keeps the port rows and appends each model row. The shared model files combine the port's validated config construction, identity, and observation contracts with the model's request, response, routing, and billing behavior.

The dedicated providers use the port's static identity contract and no longer inject a duplicate `config_class`. Required-field validation remains. The multimodal expansion handles Python's leading `(?s)` flag. The old-contract tests supply the now-required model names, use the static identities, and select Anthropic explicitly for unknown models. A native-loop TUI regression covers an OpenRouter model through mocked transport, including approval, multimodal observations, displayed text, billing, and saved identity.

## Verification

The full suite passes 1168 tests with 20 todos across 45 files plus one skipped file, including the prompt PTY and environment tests. The model files pass 676 tests with 19 todos. `bun check` passes 116 files and the formatter passes 132. No test declaration was removed. The 20 todos remain the declared gates. No live provider, network, install outside the package manager, Docker, signal, or hook was used.

## Open gates

- The 20 existing todo gates remain.
- The signature and CodeQL rules remain for both PRs.
