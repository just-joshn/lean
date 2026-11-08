# lean

Run a local coding agent with the OpenAI Agents SDK. Lean keeps one conversation history and asks before executing shell commands or applying patches.

## Set up

Use Bun on macOS or Linux. The tests also use Node.js as specified in `package.json`.

```bash
bun install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. Set `OPENAI_MODEL` to a model available to your account that supports the Responses API shell and apply-patch tools.

## Run a task

Start an interactive conversation:

```bash
bun start
```

Run one task:

```bash
bun start "Explain this repository"
```

Pipe a prompt into the agent:

```bash
printf 'Find the entry point and explain it\n' | bun start
```

Select a model or a separate conversation file:

```bash
bun start --model gpt-5.4 "Explain the tests"
bun start --session .lean/review.json "Review the current changes"
```

Show the available options without an API key:

```bash
bun start --help
```

Lean includes the complete workspace `AGENTS.md` text in the agent's instructions. Review proposed commands and patches in the terminal before approving them. Piped prompt text cannot approve a tool call. Without a terminal, Lean denies commands and patches, then lets the agent respond to the denial.

Assistant text goes to stdout. Approval prompts and errors go to stderr. Press Ctrl-C to cancel an active turn and exit. Cancellation does not undo actions that already completed.

## Continue a conversation

Run Lean again in the same directory to continue the history in `.lean/history.json`. Use `--session` to select a different history file. A session belongs to its original workspace.

Keep session files private. They contain prompts, responses, and tool outputs. Lean saves history only after a turn completes. A failed or cancelled turn leaves the previous saved history in place. Lean does not automatically replay unfinished commands after a restart.

Only one process can write a session at a time. If a process dies and leaves a lock file, verify that the old process has stopped before removing that lock.

## Review local access

The read and patch tools reject paths outside the workspace, including symlink targets. Patch mutations also reject final symlink paths. Use the target path explicitly. Creating a file creates missing parent directories inside the workspace. The shell starts in the workspace but can access anything your user account can access. Approval is not a sandbox. Do not approve an untrusted command.

Lean disables SDK tracing by default. Use `--trace` to export SDK trace metadata without model or tool inputs and outputs.

## Change the agent

Edit `src/agent.ts` to change the instructions, model settings, or SDK agent definition. Edit `src/tools.ts` to change local actions. Use the SDK directly in a custom run script instead of adding configuration layers. Keep specialized alternatives in `extra` if you add them.

## Check a change

```bash
bun run typecheck
bun run test
bun run format:check
pre-commit install
pre-commit run --all-files
```

The Vitest tests use temporary workspaces, the SDK's scripted model, and a local Responses API endpoint. They do not require an OpenAI API key.

Run the optional terminal checks with Python 3:

```bash
bun run test:terminal
```

These checks use a local API endpoint and synthetic credentials. They cover approval, denial, patching, cancellation, piped input, and the interactive prompt. Transcripts and request fixtures are saved under `.lean/terminal-checks/`.

Run `bun run format` to format the implementation and project files without changing `AGENTS.md`.
