# Native TypeScript behavioral contract

Lean is an independent TypeScript implementation. The Python reference is a development oracle, not a production dependency or execution backend. The earlier wrapper decision is rejected.

## Revisions

Lean starts at `f61ba882fa19c442dd011b69c63d2777ca709e96`. The target is mini-swe-agent `04d809ceab9df28f9adaed044884180159172930`, version 2.4.6. GitHub `main` is moving, so parity refers to this revision rather than an unbounded future version.

## Required behavior

| Area | Contract | Source |
| --- | --- | --- |
| Composition | Run scripts choose interchangeable agent, model, and environment components. Custom implementations satisfy protocols without inheritance. | `docs/advanced/cookbook.md`, `src/minisweagent/__init__.py` |
| Messages | Preserve provider-native message fields and add metadata under `extra`. Maintain one linear message history. | `docs/advanced/v2_migration.md`, `agents/default.py` |
| Run initialization | Merge task variables, clear messages, render strict system and instance templates, then run steps until the final message has role `exit`. Reusing an agent does not reset all its counters. | `agents/default.py` |
| Step | Query the model, execute actions in order, format observations through the model, and append them. | `agents/default.py`, `docs/advanced/control_flow.md` |
| Limits | Check positive step and cost limits before a query. Check integer elapsed wall time separately. Increment calls before querying. Charge successful responses and billed format errors. | `agents/default.py` |
| Format errors | Add correction messages, preserve billed cost and raw response, count consecutive failures, reset after a clean step, and terminate at the configured positive threshold. | `agents/default.py`, `models/litellm_model.py` |
| Flow exceptions | Append messages carried by `InterruptAgentFlow`. An `exit` message terminates. Other exceptions add diagnostic exit metadata, save, and rethrow. | `exceptions.py`, `agents/default.py` |
| Saving | Save in every loop iteration's finally block. Include model statistics, component configs and type identifiers, native messages, exit metadata, version, and `mini-swe-agent-1.1` trajectory format. Recursively merge additional data. | `agents/default.py`, `utils/serialize.py` |
| Templates | Use strict Jinja rendering. Recursively merge agent, environment, model, live statistics, extra variables, and overrides in that order. | `agents/default.py`, `utils/serialize.py` |
| Model request | Reproduce LiteLLM completion behavior using TypeScript provider transports with the single native `bash` function tool. Strip `extra` before sending messages. Apply model kwargs followed by per-query overrides. | `models/litellm_model.py`, `models/utils/actions_toolcall.py` |
| Retries | Retry non-aborting exceptions with the upstream Tenacity policy and environment-controlled attempt count. Do not retry unsupported parameters, missing model, permission, context, authentication, or keyboard interruption errors. | `models/litellm_model.py`, `models/utils/retry.py` |
| Cost | Register an optional model registry. Require positive calculated cost unless configured to ignore errors. Update global statistics even for responses that fail action parsing. | `models/litellm_model.py`, `models/__init__.py` |
| Text actions | Provide an alternative model that parses exactly one regex action. Keep its regex and observation formatting in the model, not the agent. Preserve the migrated `mswea_bash_command` default. | `models/utils/actions_text.py`, `models/litellm_textbased_model.py`, `docs/advanced/v2_migration.md` |
| Actions | Require at least one native tool call. Reject unknown tools, invalid JSON, and missing command keys. Preserve ordered command values and tool call identifiers. Expose finish reason to error templates. | `models/utils/actions_toolcall.py` |
| Observations | Format one result per action. Pad unexecuted actions with return code -1 and the upstream exception text. Use role `tool` when an identifier exists and role `user` otherwise. Preserve raw output and metadata. | `models/utils/actions_toolcall.py` |
| Provider helpers | Preserve Anthropic thinking ordering, cache-control placement, multimodal expansion, and upstream content display behavior. | `models/utils/anthropic_utils.py`, `cache_control.py`, `openai_multimodal.py`, `content_string.py` |
| Local process | Start a fresh shell per action. Merge configured environment variables over process variables. Capture interleaved stderr and stdout. Respect call-level and configured cwd and timeout precedence. | `environments/local.py` |
| Process failures | Return structured execution errors and partial decoded output. Kill the entire process group on POSIX timeout. Do not treat a nonzero command exit as an agent exception. | `environments/local.py` |
| Submission | Only successful output whose first non-whitespace line is exactly `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` submits. Preserve remaining lines as submission. | `environments/local.py` |
| Default partial batch | If an action interrupts execution, default-agent observations for earlier actions in that batch are not appended. | `agents/default.py` |
| Interactive partial batch | Always append formatted observations for executed and unexecuted actions, including rejection and submission. | `agents/interactive.py` |
| Interactive modes | Default to confirm. Human mode executes user commands without querying or billing the model. Yolo executes model commands without confirmation. Whitelist matching starts at the beginning of the command. | `agents/interactive.py` |
| Confirmation | Enter confirms a batch. A comment rejects it. `/y` confirms and changes mode. `/u` rejects and changes to human mode. | `agents/interactive.py` |
| Interactive commands | Support `/h`, `/m`, `/u`, `/c`, and `/y`, including repeat-mode prompts and multiline input. | `agents/interactive.py`, `agents/utils/prompt_user.py` |
| Interactive completion | Optionally ask for a new task before accepting submission. A new task becomes a user interruption in the same history. | `agents/interactive.py` |
| Interruptions | Keyboard interruption prompts for a comment or command, handles mode changes, and records the user interruption. | `agents/interactive.py` |
| Interactive limits | Prompt for new step and cost limits only on an interactive stdin. Stop on wall time without an unproductive prompt. | `agents/interactive.py` |
| Config migration | Keep observation and format-error templates on the model. Native bash tool calling is the default. Use the new completion sentinel and structured run result. | `docs/advanced/v2_migration.md` |
| CLI composition | Support merged config files and key-value overrides, component-class selection, task, yolo, cost, output, and immediate-exit options. | `run/mini.py`, `docs/advanced/v2_migration.md` |

## Verification strategy

1. Capture the existing Lean checks before changing the runtime.
2. Run pinned upstream contract tests to establish the reference environment.
3. Verify core behavior through the implementation's public component API.
4. Drive the real Lean command against a local deterministic completion server. Compare requests, trajectories, filesystem effects, process exit status, and errors with upstream.
5. Drive confirmation, rejection, mode changes, new tasks, and interruption through a PTY.
6. Run the final project's tests, type checks, formatting, and pre-commit hooks.
7. Record unsupported or untested paths as gaps. Passing deterministic fixtures does not prove every external provider behaves correctly.

## Scope constraints

The original checkout and its uncommitted TUI work remain untouched. Preserve the user's updated AGENTS.md and their commits `769023b` and `de22c8c`; its current protected blob is `937517a3e229ebde8ad857834ddd6da7b64deae7`. Earlier `1b7f0e8` records predate the user's committed table-label correction. No production component may delegate to Python. Do not append to README.md. The implementation must remove or explicitly replace obsolete SDK-only execution paths rather than leave a second default agent loop.

## Design rubric

- Preserve actual behavior for all required components and dependency semantics.
- Keep one owner for agent history and execution.
- Expose component composition and customization without requiring callers to understand a transport protocol.
- Keep the runtime small enough for a contributor to trace at a glance.
- Make installation and terminal signal behavior reproducible.
- Supply executable evidence through the real Lean command, not only unit-level substitutes.
