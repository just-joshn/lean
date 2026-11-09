# Run a TypeScript mini-swe-agent loop

This build matches mini-swe-agent 2.4.6. `DefaultAgent` owns the history, the counters, and the loop. `LitellmModel` sends one completion and parses the reply. `LocalEnvironment` or `DockerEnvironment` runs one shell action. Nothing here starts a Python process or an SDK-owned agent loop.

## Run the executable

Set a model and its key, then start Lean. Confirmation is the default.

```bash
export MSWEA_CONFIGURED=1
export MSWEA_MODEL_NAME=openai/gpt-4o
export OPENAI_API_KEY=...
bun src/index.ts -t "Fix the failing test"
```

Press Enter to run a proposed command. Type a comment to reject it. When the agent wants to finish, press Enter to quit or type a new task.

- `-y` runs model commands without confirmation.
- `--exit-immediately` quits when the agent submits instead of asking.
- `-l 1` sets the cost limit in dollars. `0` disables it.
- `-o trajectory.json` chooses the trajectory file. The default is `last_mini_run.traj.json` under the mini-swe-agent config directory.

An explicit `-c` replaces the built-in `mini.yaml`. Repeat the default file when you also want an override:

```bash
bun src/index.ts -c mini.yaml -c model.model_kwargs.temperature=0 -t "Fix the failing test"
```

A spec with `=` is a dotted override. `model.model_kwargs.temperature=0` sets that field. A spec without `=` is a YAML file name, searched in the working directory and then in `src/config`.

Use `--model-class litellm_textbased` when the model must return one fenced `mswea_bash_command` block instead of a `bash` tool call. `--agent-class default` selects the non-interactive agent. `--environment-class docker` selects Docker, which also requires `environment.image` in the config.

## Compose the same loop in TypeScript

```typescript
import { DefaultAgent, LitellmModel, LocalEnvironment } from "./src/index.ts";

const model = new LitellmModel({
  model_name: "openai/gpt-4o",
  cost_tracking: "default",
});
const env = new LocalEnvironment({ cwd: process.cwd() });
const agent = new DefaultAgent(model, env, {
  system_template: "You are a coding agent. Use the bash tool.",
  instance_template: "{{ task }}",
  step_limit: 20,
  cost_limit: 1,
  output_path: "trajectory.json",
});

const result = await agent.run("Add a regression test");
console.log(result.exit_status, result.submission);
```

`result.exit_status` is `Submitted` when a command exits 0 and its first stripped line is exactly `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`. The rest of that output is the submission.

To keep a workspace in one container and still run each command in a new process:

```typescript
import {
  DockerEnvironment,
  InteractiveAgent,
  LitellmTextbasedModel,
} from "./src/index.ts";

const model = new LitellmTextbasedModel({
  model_name: "openai/gpt-4o",
  model_kwargs: { api_base: "http://127.0.0.1:4000/v1" },
});
const env = new DockerEnvironment({ image: "python:3.11", cwd: "/work" });
const agent = new InteractiveAgent(model, env, {
  system_template: "You are a coding agent.",
  instance_template: "{{ task }}",
  mode: "yolo",
  confirm_exit: false,
});
await agent.run("List the files");
env.cleanup();
```

A custom model or environment only has to implement the methods on `Model` or `Environment`. It does not have to extend these classes. `query`, `execute`, and `run` may return a value or a promise.

## What changed from the previous Lean

The OpenAI Agents SDK loop, the `.lean/history.json` session, and the `--login` / `--logout` commands are gone. This build does not read or convert those files.

Saved runs use the `mini-swe-agent-1.1` trajectory. `info.mini_version` is `2.4.6`.

## Cost, retries, and providers

Cost comes from the bundled LiteLLM price catalog. A missing price throws unless that model sets `cost_tracking: ignore_errors` or `MSWEA_COST_TRACKING=ignore_errors`. `MSWEA_GLOBAL_COST_LIMIT` and `MSWEA_GLOBAL_CALL_LIMIT` apply across models. A global cost limit trips only after the spend is greater than the limit. An agent cost or step limit also trips when the counter is equal to the limit.

The transport retries HTTP failures up to `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT` (default 10). The waits before attempts 2 through 10 are 4, 4, 4, 8, 16, 32, 60, 60, and 60 seconds. It does not retry authentication, permission, not-found, context-window, or unsupported-parameter errors.

Tests cover OpenAI-compatible chat completions and the Anthropic Messages API, including last-message cache markers for Claude model names. Other LiteLLM provider prefixes are not implemented. Point `model_kwargs.api_base` at an OpenAI-compatible server for a local model whose name does not start with `anthropic/` or `claude`.
