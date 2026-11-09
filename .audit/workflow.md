# Parity workflow and design decision

## Goal

Make Lean run the linked mini-swe-agent behavior at revision `04d809ceab9df28f9adaed044884180159172930`. Keep Lean's AGENTS.md unchanged and keep this work isolated from the original checkout.

## Rigor

This is a breaking runtime replacement. The checks must exercise the actual command, dependency installation, local process effects, saved trajectories, and terminal interactions. Passing TypeScript checks alone is insufficient. Live paid-provider entitlement is not part of deterministic verification and must remain unclaimed.

## Architecture

Use a single small Bun entry point that replaces itself with the repository's locked `.venv/bin/mini` executable. The runtime data shape is the executable path, unchanged argument vector, and inherited environment. The launcher never changes the caller's working directory. Python owns all messages, model calls, retries, costs, local processes, terminal interactions, exceptions, and saved trajectories.

Use the pinned Git package and its complete declared runtime dependency graph in uv.lock. Pin CPython to 3.13.15. Do not copy a hand-authored freeze into another registry. Keep upstream test-only packages in a separate dependency group. Do not install optional Portkey solely as a product requirement.

Keep the cookbook imports from `minisweagent`. A custom script runs with the locked interpreter. There is no Lean Python package, RPC, new `lean run` command, or extra interpreter bin.

Disable Bun's implicit `.env` loading in the executable shebang and package start command. Do not strip environment variables after startup. Do not set upstream global-config, silent-startup, or configured variables in production.

## Alternatives and synthesis

| Alternative | Decision | Reason |
| --- | --- | --- |
| Native TypeScript components | Reject | This creates another implementation of dependency-defined behavior instead of inheriting it. |
| TypeScript loop with Python RPC | Reject | It duplicates control flow and adds an unnecessary protocol. |
| Candidate A's spawned Python child | Reject | A Bun parent needs a second terminal and signal policy. |
| Candidate B's process replacement | Use as the base | Python becomes the process the shell waits for and the sole terminal owner. |
| Runtime pin probes, branded paths and a planner object | Reject | They add a policy layer without improving the required runtime behavior. Check installation metadata and the lock during verification. |
| Hand-copied dependency freezes | Reject | Both sketches omitted installed packages and included unrelated test extras. Let the package manager resolve and lock the declared graph. |
| SDK compatibility loop | Reject | The user requested replacement behavior, not a second default runtime. |

The independent cross-judge agreed with the parent on using B's process model only. Neither candidate's implementation sketch is copied wholesale. A contributes the single resolved lockfile and explicit separation between caller cwd and executable location. B contributes process replacement and suppression of Bun's implicit dotenv behavior.

## Execution units

1. Capture the old Lean checks and the pinned upstream checks. Verify actual installed source against the pinned source.
2. Build real-command verification separately. Prove expectations against upstream and demonstrate the old Lean command fails the new contract.
3. Replace the SDK-owned runtime and all its callers with the minimal launcher. Delete only code and tests made obsolete by that replacement. Verify installation, help and error behavior from another directory before advancing.
4. Merge the independently written CLI and PTY checks. Run the checks against Lean. Check source metadata, required installed source bytes, and the dependency lock. Run the upstream contract tests against Lean's installed package.
5. Review comments and code, run formatting, type checks and pre-commit, and inspect the final diff. Commit coherent work and open the PR without merging.
6. Audit the decision log against this run and have a different model family review it. Report tested parity and remaining gaps without claiming universal proof.

## Intentional breaks

Remove the SDK-specific agent loop, tools, saved-session protocol, subscription adapters, auth flags, trace flag, and positional-task parser. Old sessions and credentials are left on disk and are not read, converted, or deleted. The command accepts upstream mini flags. AGENTS.md remains a project instruction file but is no longer automatically used as the model's system prompt.

Upstream source takes precedence where documentation examples are simplified or stale. The control-flow guide omits the successful return-code check for submission and some error handling. The v2 exception diagram omits TimeExceeded. The cookbook's MSWEA_DEFAULT_RUN variable is not read by this pinned source. Preserve the executable behavior instead of inventing fixes.

Do not append to README.md. A separate current-command and migration document must describe setup and intentional incompatibilities. The old README will require a separate update, and that limitation must be explicit in the handoff.
