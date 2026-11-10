# Prompt terminal.

## Behavior

The PTY harness now requires explicit readiness. CPR readiness waits for the `ESC[6n` request and answers `ESC[1;1R`; the cooked limit reader uses the marker. The prompt test selects the matching mode and enables CPR explicitly.

The terminal-size brands and redundant guards are removed. The frame and renderer use the source numeric size and the zero or missing fallback. The paint test checks 80-column wrapping and 24-row geometry for both.

The lifecycle tests add the warning prelude wait and erase faults, the background-wait fault, the separate paste-disable, show-cursor, and flush faults, and CPR readiness without the marker. The private reset-adapter reflection, its no-op fault cases, the calculated private-call sequence, and the implementation call counts are removed. Only reachable output-write faults and observable rejection, context, diagnostics, pending read, and terminal cleanup remain.

## Verification

The focused suite passes 95 tests with one todo across five files. The parent PTY command passes 9 tests. `bun check` passes 63 files and the formatter passes 69. The second overlapping warning remains a todo because no reachable public-reader control proves it.

## Open gates

- The second overlapping warning remains unproven through the public reader.
- Fresh reference-runtime fault captures for the separated boundaries remain unrun.
- Real-terminal acceptance beyond the fresh PTY fixture, full prompt behavior, full-suite verification, hooks, and product integration remain open.
