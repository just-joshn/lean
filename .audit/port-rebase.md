# Port rebase and TUI integration.

## Behavior

The port branch is rebased onto main at the TUI commit. The package and lockfile conflicts keep both sides: the TUI scripts and Rezi and Shiki dependencies, and the port's Jinja and YAML dependencies. The deleted CLI verification scripts are removed from the package scripts; the TUI scripts remain.

The TUI now runs on the native agent loop through a small `DefaultAgent` adapter. Command approval and denial, model switching, transcript paging, cancellation rollback, and output inspection remain. The `--output` flag saves the latest task as a native trajectory. Screen history stays in memory, so each task starts with fresh model context. `--session`, `--provider`, and `--trace` reject unsupported behavior with migration guidance rather than reading old files.

The color and Shiki failures came from `NO_COLOR=1` in the inherited environment. The dependency versions match main, so no lockfile change was needed. The color fixtures now explicitly enable color; the monochrome tests explicitly disable it.

## Verification

The full suite passes 562 tests with one todo across 37 files, including the prompt PTY and environment tests, with `NO_COLOR=1`. `bun check` passes 94 files and the formatter passes 104. The TUI files pass 92 tests across eight files. A separate demo PTY check passed startup, submission, help, and exit.

## Open gates

- The TUI session file, provider selection, and trace commands have explicit migration boundaries.
- The environment lifetime, judge adoption, model todos, and signature and CodeQL gates are unchanged.
