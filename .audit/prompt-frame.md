# Native prompt frame decision.

## Selected design

Candidate A is the base. The cross-judge scored it higher on error precedence, reset fidelity, timer ownership, warning ownership, executable controls, and integration safety. Three grafts from candidate B are included.

- The initial open-paint and resize-paint failure path skips the done redraw and both resets, then still runs input exit and CPR-timer cancellation.
- The reset adapter tracks paste and cursor visibility and emits only when the tracked state needs the operation. The flush boundary stays explicit.
- The reset-count formula and representative saved cases are documented. Executable expectations come from the saved rows.

The symbol-property chain, a synchronous background cancel, and unconditional coordination completion were rejected.

## Source contract

The 32 saved rows are a full 2^5 grid of body, done, reset, detach, and raw faults. The chain is newest first: raw, detach, reset-N down to reset-1, done, body. The latest cleanup error is the rejected object. Earlier errors stay in order. `cause` stays unset and no `AggregateError` is built. A reset fault retries at the outer reset when the done render fails first.

The committed fixture is `src/agents/prompt/read-lifecycle-cases.jsonl`. Its rows are trimmed from the saved source controls. The full controls and the design records remain in the workspace store.

## Implementation

- `src/agents/prompt/context.ts` owns the private `Failure` chain, the WeakMap association, newest-first context, oldest-first formatting, and async diagnostics.
- `src/agents/prompt/feed.ts` owns the read status, the single claim, the close nesting, input exits, the binding timer, the warning gate, and the CPR warning task.
- `src/agents/prompt/frame.ts` owns capability, geometry, the grid, the diff, the reset adapter, the CPR response queue, the CPR timeout, and the warning write.
- `src/agents/prompt.ts` keeps only the three public readers.
- `src/utils/global-config-dir.ts` owns the config directory helper that used to live in the prompt module.
- `interactive.ts` and `run/mini.ts` use `readInteractive`, `readSetup`, and `readBuiltinLimit`.

## Verification

The unmodified copied config typechecks. The focused suite passes 80 tests across the lifecycle, paint, editor, and interactive files. The lifecycle matrix covers all 32 saved rows, the open-paint skip, binding-timer ownership, the CPR timer surviving reset, capability across reset, the warning short and long branches, and a warning write failure that stays off the prompt result.

## Open gates

- Warning prelude failure and background-wait failure are not forced by a test.
- Cursor shape, show cursor, and flush are not faulted as separate reset steps.
- A second overlapping warning is not reached through the public reader.
- Real terminal and PTY acceptance, full prompt behavior, the full suite, normal hooks, and product integration remain open.

The private proof is committed on `refactor/mini-swe-agent-parity` as a checkpoint. It is not a merge-ready prompt implementation.
