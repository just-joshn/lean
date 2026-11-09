# lean

Run a local coding agent with the OpenAI Agents SDK. Lean keeps one conversation history and asks before executing shell commands or applying patches.

## Set up

Use Bun on macOS or Linux. The tests also use Node.js as specified in `package.json`.

```bash
bun install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env` for the API-key path. Set `OPENAI_MODEL` to a model available to your account that supports the Responses API shell and apply-patch tools. To use a Claude Pro or Max plan, or ChatGPT, sign in instead and leave the key empty.

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

Assistant text goes to stdout. Approval prompts and errors go to stderr. Press Ctrl-C to cancel the active turn. Lean finishes an in-flight subscription token write before it exits. Press Ctrl-C again to exit immediately. Cancellation does not undo actions that already completed.

## Open the chat screen

`bun run tui` opens the same agent in a terminal chat. Sign in or set a key the same way you do for `bun start`.

```bash
bun run tui
bun run tui --demo
bun run tui --model gpt-5.4 --session .lean/review.json
```

`--demo` uses no credentials, opens no session file, and runs no commands. Its sample rows are marked `synthetic`.

The chat accepts `--model`, `--provider`, `--session`, and `--trace`. It does not take a message argument. `/help` lists the commands it accepts. `/model <name>` resolves the model for the next turn with the same rules as the line interface. `/clear` clears the screen and does not delete the saved session.

Enter sends the draft. After typing a trailing `\`, press Enter to append a newline. This shortcut works only on a single-line draft and uses the caret position from the last edit. It cannot detect later arrow-only caret movement. Multiline paste is supported.

With an empty draft, `y` approves a proposed shell command or patch, and Enter or `n` rejects it. Escape rejects it regardless of the draft. The Allow and Deny buttons also record your decision. Page Up and Page Down scroll a long proposal. Nothing runs before you approve it.

The transcript shows Markdown source as plain text, and Page Up and Page Down scroll its wrapped rows.

Ctrl-C cancels the active turn and does not quit. Lean saves a turn only after it finishes. A cancelled or failed turn restores the in-memory session from a snapshot cloned before the session is cleared. If that restore fails, later turns are refused. A command or patch that already finished stays on disk.

After a turn is saved, and when a saved session is reopened, completed tool calls are paired with their results by call id. The row shows that result's status, or `no result` when the call has no saved result. Ctrl-O opens the selected result. While the draft is empty, Tab switches Output and Raw result, and Left and Right select another saved result. Escape closes the panel. Unified diff lines are colored. Other output is not. The panel is not filled in while a turn is still running.

Ctrl-C on an empty draft asks for a second Ctrl-C to exit. `q` does not exit while the prompt is focused.

This is not Claude Code. Live tool status, model-call counts, and Claude's command list are not shown. The screen stays in a fixed viewport. The installed Rezi release cannot append each message to the shell scrollback.

## Sign in with a subscription

Sign in before starting a conversation:

```bash
bun start --login openai
bun start --login anthropic
```

Lean prints an authorization URL on stderr. Open that URL and finish sign-in in your browser. Lean does not open a browser. Sign-in needs a terminal, and a piped value is not treated as an authorization code.

Credentials are stored under `~/.lean`, or `$LEAN_HOME` when that variable is set. Each provider has its own file, readable only by your user. Lean does not read Pi, Codex, or Claude credential files.

With one saved subscription and no API key, run Lean as usual:

```bash
bun start "Explain this repository"
```

When both providers are signed in, pass `--provider`.

```bash
bun start --provider anthropic --model claude-sonnet-5-5 "Explain this repository"
```

`--provider` uses that subscription. If refresh fails, Lean does not fall back to `OPENAI_API_KEY`. With no `--provider`, a non-empty `OPENAI_API_KEY` keeps the API-key path and does not read subscription files.

Anthropic defaults to `claude-sonnet-5-5`. OpenAI still uses `--model`, then `OPENAI_MODEL`, then the SDK default. Lean checks the id against its built-in catalog. A catalog entry does not mean your account can use that model.

OpenAI subscriptions send tools as functions. Lean translates shell and patch calls to native SDK items, so the usual approvals and saved history still apply.

Sign out of one provider without starting a conversation or removing the other:

```bash
bun start --logout openai
```

Sign-in and refresh operations use per-provider lock files. Before removing a leftover lock file, confirm that the process that used it has stopped. Lean does not take over stale locks.

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
bun run test:subscriptions
bun run test:login-cancel
```

These checks use local API endpoints and synthetic credentials. They cover tool approval, cancellation, interactive prompts, subscription callbacks, token refresh, and saved-history continuation. They do not use your accounts. Transcripts and results are saved under `.lean/terminal-checks/`, `.lean/subscription-checks/`, and `.lean/login-cancel-checks/`.

Run `bun run format` to format the implementation and project files without changing `AGENTS.md`.
