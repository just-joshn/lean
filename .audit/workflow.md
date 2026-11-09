# Native TypeScript parity workflow

## Goal

Lean remains an independent TypeScript coding agent. Its agent, model, environment, interactive behavior, and required helpers match mini-swe-agent revision `04d809ceab9df28f9adaed044884180159172930`, version 2.4.6. That revision still matched upstream main when checked after the revised request.

The former Python launcher design is rejected. Its research checkpoint is `98d7c1a`. No production implementation of that design was made. Python is permitted only as an external development reference, never as Lean's runtime, transport, action parser, or control flow.

## Instructions and isolation

Use the updated `AGENTS.md` in this worktree. The user committed it in `769023b` and corrected the table label in `de22c8c`. Its current protected Git blob is `937517a3e229ebde8ad857834ddd6da7b64deae7`. Preserve those user commits and bytes. Earlier records of `1b7f0e8` are historical, not instructions to restore an older copy. The original checkout contains unrelated work and stays untouched. Do not append to README.md.

The source's Python-specific implementation rules do not introduce Python into Lean. TypeScript code, Vitest, TypeScript config types, and a TypeScript Jinja implementation provide the corresponding mechanisms. Preserve source behavior where the abbreviated documentation disagrees.

## Done predicate

The actual Lean command and public TypeScript components pass executable checks for every row in `parity-contract.md`. The production dependency graph contains no Python interpreter, Python mini-swe-agent dependency, or launcher delegation. One Bash-only action interface and one chronological message history are visible in the TypeScript code. The interactive command defaults to confirmation.

Verify native and text parsing, ordered tool identifiers, malformed-response accounting and recovery, limits, strict templates, trajectories, local process results and descendant cleanup, interactive rejection and continuation, configuration merging, and component substitution. Compare source behavior through reference fixtures and real local HTTP and PTY scenarios. Type checking alone is not evidence of behavioral parity. Untested provider paths remain unverified, not implicit passes.

## Rigor and scope

This replaces a tightly coupled SDK-owned runtime and its callers. Use high rigor because control flow, action execution, accounting, persistence, and interactive safety all change. The main production units are shared protocols and helpers, local environment, model adapters, default agent, interactive agent, and run/config composition. Required helpers include native and text actions, recursive merging, templates, multimodal expansion, provider request transformations, retry policy, and cost metadata. Cookbook composition and subclassing must remain possible in TypeScript.

Do not expand into unrelated benchmark runners or every backend mentioned in an external link. Track required examples and dependency behavior in the contract. Reject any candidate that hides an omitted requirement behind a new abstraction or assumes an SDK preserves malformed output without testing it.

## Execution units

1. Reuse completed upstream research and baseline evidence. Read the revised instructions, reject the wrapper conclusion, and compare two native designs. Verify dependency APIs against current documentation and installed source. Fix the protocols before implementation fan-out.
2. Build reference fixtures and failing public-contract checks before replacing each component. Introduce the smallest shared TypeScript shapes and helpers needed by all components. Verify those directly.
3. Implement the environment and model components behind the fixed protocols. Execute real commands and local provider responses. Check partial output, submission, parsing, transformations, retry and cost failures.
4. Implement the default and interactive loops. Verify accounting, histories, all flow exceptions, per-iteration saves, human commands, confirmation, and continuation through public component tests.
5. Migrate the command and custom-script entry points, then delete SDK orchestration and obsolete callers. Exercise the real command and PTY against deterministic provider responses. Verify that no production path delegates to Python.
6. Independently review the diff and contract coverage. Run formatting, type checks, tests, and pre-commit. Keep coherent linear commits, open a PR without merging, and report verified behavior and remaining gaps precisely.

## Throughput checkpoint

- Blocking first steps. The updated user instructions, source contract, native data shapes, template behavior, and provider transport boundaries settle before implementation.
- Independent workstreams. Reference fixture generation and dependency experiments can run separately. One implementation owner coordinates the coupled rewrite and only splits files after shared interfaces are fixed. Verification has independent ownership.
- Shared mutable state. The original checkout is off limits. Candidate designs have isolated output directories. Concurrent code writers use isolated worktrees. The implementation owner owns integration and package locks.
- Smallest safe decomposition. Keep one TypeScript component for each core responsibility. Use alternative components for genuinely different model formats or environments. Delete replaced SDK APIs after their callers migrate. Do not retain two competing default runtimes.

## Decision trail

`.audit/mini-swe-parity.tsv` is append-only. New rows explicitly supersede the rejected wrapper decision. Candidate designs and supporting experiments live in the task store. Final verification checks the real artifact and the trail against the task, not delegate self-reports.

## Implementation checkpoint

The native implementation is committed locally at `240590e3172181db001b3a78668aae4511820242`. Root reran formatting, type checking and all 59 implementation tests successfully. These are component checks, not proof that the parity contract is satisfied.

Root then compared Lean's actual renderer with the development oracle. Only 88 of 121 cases matched. A separate development renderer passed all cases, but that implementation was not integrated. Keep the failing product result and repair the real component before accepting template parity.

Live PTY checks also found that coalesced Escape and Enter do not submit multiline input, and first-run `--help` starts setup. Separate Escape and Enter work in the positive control. The pinned reference shows help without setup under the same isolated conditions. These regressions must be fixed before delivery.

The four independent source reviews have returned. The production review freeze has ended. Corrections now have separate renderer, model, prompt and environment worktrees. A separate integration worktree holds the red public-contract tests, so those tests cannot block green component commits or be silently weakened to get a hook through.

Root ran the corrected 56-case gate against the unchanged native production snapshot. Forty-nine passed and seven failed. Source inspection attributes five failures to remaining test defects and two to the already assigned strict-renderer defect. The false expectations concern a missing template field, a globally registered supposedly unpriced model, serialized class-key nesting and macOS temporary path aliases. Correct the artifacts, not the source behavior. Additional source type errors need honest helper typing and the agreed flexible component boundaries.

Root also reproduced Ctrl-D reaching Environment.execute without approval in a real confirmation PTY with a safe fake environment. The model wire probe confirms leaked drop_params, an empty final Claude tool observation and lost cache metadata. Prompt and model owners must fix those at their actual boundaries. A proposed cache-helper relaxation is rejected because the pinned source asserts one content block. A cache-price claim from a different LiteLLM version is conditional, not an accepted correction.

The next blocking unit settles config subclass hydration, startup ordering, minimal class loading and public protocol types. It does not redesign the central loop. Integrate only reviewed green repairs, then run corrected unit, HTTP/process and CLI/PTY gates. No behavioral exception has been approved. Full state and rerunnable evidence are in `native-implementation-review-status.md` and `native-source-review-triage.md` in the task store.
