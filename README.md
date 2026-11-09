# lean

![A hand-drawn cup of purple syrup](assets/lean.svg)

> A small coding agent, mixed for daily work.

Lean takes its inspiration from [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) and lightweight agents like pi. The goal is a coding agent small enough to read and change, yet useful enough to reach for every day, like Claude Code or Codex CLI.

Today, Lean keeps one linear conversation, asks before shell commands and patches, and saves history in your workspace. It has three tools and a line-oriented terminal. It does not try to match every feature of those larger products.

The name is a nod to lean, also known as syrup or purple drank. The project is about keeping the code small, not the drink.

Lean uses the OpenAI Agents SDK. Its tools and agent loop live in TypeScript under `src`, so you can change them directly. A workspace `AGENTS.md` supplies the agent's instructions.

## Set up this checkout

Use Bun. Lean runs each shell command with `/bin/sh`. Use macOS or another Unix.

`package.json` declares Node.js `>=26.13.0 <27`. `mise.toml` pins Node.js `v26.13.0`. The commands in this file use Bun. The optional checks below use Python 3.

Install dependencies, then create a local env file.

```bash
bun install
cp .env.example .env
```

Bun loads `.env` from the current directory. In this checkout, `bun start` loads this `.env`.

`.env.example` leaves `OPENAI_API_KEY` empty and sets `OPENAI_MODEL` to `gpt-6-astra`. For the API-key path, set `OPENAI_API_KEY`. Set `OPENAI_MODEL` to a model your account can call. That path sends the SDK shell and apply_patch tools. Lean does not check the model id before the request.

Leave `OPENAI_API_KEY` empty when you sign in instead. A blank or whitespace-only key counts as unset.

## Run a task

In this checkout, start an interactive session.

```bash
bun start
```

Lean prints a `> ` prompt on stderr. Type a task and press Enter. An empty line is ignored. Press Ctrl-D at the prompt to close input. Lean exits 0.

Run one task and exit.

```bash
bun start "Explain this repository"
```

Lean joins the message words with spaces and sends them as one message. In a terminal, a message still runs once. Lean does not open the `> ` prompt when a message is present.

Pipe a task.

```bash
printf 'Find the entry point and explain it\n' | bun start
```

If you pass a message and a pipe, Lean uses the message and does not read stdin. If the pipe is empty and there is no message, Lean exits 1 and prints `No prompt was provided. Pass a message or run lean in a terminal.`

`bun start` is the package script in this checkout. In another directory, that script is not Lean. Run the entry file with Bun so the current directory is the workspace.

```bash
bun /path/to/lean/src/index.ts "Explain this repository"
```

`src/index.ts` is executable. Its shebang is `bun`, so the path alone runs the same program. When `AGENTS.md` exists in the current directory, Lean reads it. The session file for that workspace is `.lean/history.json`. Bun still loads `.env` from the current directory, not from the Lean checkout. If the key is not already in the environment, export `OPENAI_API_KEY`, or put it in that directory's `.env`.

Show usage without a key.

```bash
bun start --help
```

The command prints usage to stdout and exits 0. `--help` returns before sign-in or a task.

Assistant text goes to stdout. If that text is not empty and does not already end in a newline, Lean adds one. Prompts and errors go to stderr. Lean replaces `OPENAI_API_KEY` and saved subscription tokens in error text with `[redacted]`.

Run the same command again in the same workspace to continue `.lean/history.json`. Pick another file with `--session`.

```bash
bun start --model gpt-5.4 "Explain the tests"
bun start --session .lean/review.json "Review the current changes"
```

## Approve a command or a patch

The shell is not a sandbox. An approved command runs as your user, in the workspace, with your environment. If `OPENAI_API_KEY` is set, the command can see it. The command can reach anything your user can reach. Do not approve a command you do not trust. Cancellation does not undo a command or a patch that already finished.

The command's stdin is not connected, so it cannot prompt you.

When the model wants a shell command or a patch, Lean prints a JSON object on stderr. The object names the tool and the command or the patch. Lean then prints `Approve? [y/N] `.

Answer `y` or `yes`, in any case, to approve that call. Any other answer denies it. Pressing Enter denies it.

The task text is not an approval, including text from a pipe. If stdin is not a terminal and stdout is, Lean reads the answer from `/dev/tty`. If neither stdin nor stdout is a terminal, Lean prints `Denied. No terminal is available for approval.` and denies the call. After a denial, the agent can continue the turn.

Press Ctrl-C to cancel the active turn. Lean exits 130. It still finishes a subscription token write that has already started, and it closes the session. Press Ctrl-C again to exit 130 immediately. The second press skips cleanup, so a session lock or a credential lock can remain. A failed or cancelled turn does not replace the saved session.

## Tools and limits

The agent has three tools. `read` does not ask for approval. `shell` and `apply_patch` do.

`read` returns UTF-8 text from a file inside the workspace. The default window is the first 200 lines. The model can request another window. Lean stops at 500 lines or 32000 characters. Truncated text ends with `[truncated]`. If a scanned line contains a NUL byte, Lean returns `Binary file.` A patch update returns the same text when the existing file contains a NUL byte.

One shell call can list several commands. Those commands share a deadline of at most 30 seconds. Lean keeps at most 32768 bytes of stdout and 32768 bytes of stderr. Lean honors a positive request for fewer bytes. It does not honor a larger request. Each command runs as `/bin/sh -c` with the workspace as its current directory.

A patch can create, update, delete, or move a file inside the workspace. Creating a file creates missing parent directories inside the workspace. Read follows a symlink when every target stays inside the workspace. A path that resolves outside the workspace is rejected, including a symlink that points outside. A patch does not change a symlink that is the last part of the path. Pass the target path instead. A symlink earlier in the path is followed when its target stays inside the workspace. If a move writes the new file and then cannot remove the old one, Lean reports the failure and leaves the new file in place.

Read and patch resolve paths from the workspace. The shell starts there and is not limited to it.

Lean disables parallel tool calls and limits each agent run to 25 turns.

Tracing is off unless you pass `--trace`. With `--trace`, the SDK runner is created with `traceIncludeSensitiveData` set to false.

## Sign in

Sign in before starting a conversation. `openai` uses the ChatGPT subscription flow in `@earendil-works/pi-ai` 1.5.0. `anthropic` uses the Anthropic subscription flow in that version.

```bash
bun start --login openai
bun start --login anthropic
```

Lean prints an authorization URL on stderr. It does not open a browser. Open the URL yourself. If the flow sends extra instructions, Lean prints those too.

When the flow asks you to choose, Lean prints numbered options. Answer with the number or the option id. When it asks for a line of text, type that line and press Enter.

Sign-in needs a terminal. If stdin is not a terminal, Lean exits 1 and prints `Sign-in needs a terminal.` It does not treat piped text as a code.

On success, stderr says `Signed in to OpenAI.` or `Signed in to Anthropic.` Lean exits 0 and does not start a conversation, even if you also passed a message. Passing `--login` and `--logout` together is an error. The error is `Pass either --login or --logout.`

Credentials are stored under `~/.lean`. If `LEAN_HOME` is set and not blank, Lean uses that directory instead. Lean resolves it to an absolute path. The provider files are `openai.json` and `anthropic.json`, mode 0600. `installation.json` in the same directory is an id Lean creates for sign-in. It is not an access token. Lean sets the directory to mode 0700. Lean does not read Pi, Codex, or Claude credential files.

Remove one provider without removing the other, and without starting a conversation.

```bash
bun start --logout openai
```

Lean prints `Signed out of OpenAI.` and exits 0.

Sign-in and token refresh take a lock beside the credential file. Lean does not remove a lock it did not take. If a process died and left the lock, confirm that the process is gone, then delete the lock file.

## Credentials and models

Lean chooses credentials in this order.

- If you pass `--provider`, Lean uses that saved subscription. `openai` and `anthropic` are the only provider ids. A missing subscription stops the run. A failed refresh stops the run. Lean does not fall back to `OPENAI_API_KEY`.
- If you omit `--provider` and `OPENAI_API_KEY` is not blank, Lean uses the API key. Whitespace alone counts as unset. Lean does not read subscription files for that choice.
- If you omit `--provider` and the key is unset, one saved subscription is used.
- If you omit `--provider`, the key is unset, and both subscriptions are saved, Lean stops and tells you to pass `--provider`.
- If no key is set and no subscription is saved, Lean stops and tells you to set `OPENAI_API_KEY`.

For OpenAI, on the API-key path and on an OpenAI subscription, the model is the first of these values that is set.

1. `--model`
2. `OPENAI_MODEL`
3. `OPENAI_DEFAULT_MODEL`, when it is not blank. Lean lowercases that value. A value that is only whitespace is ignored. Lean does not trim the value it sends.
4. The Agents SDK default

An OpenAI subscription id has to appear in the built-in OpenAI catalog. The API-key path does not check the catalog.

For Anthropic, `--model` wins when you pass it. Otherwise the model is `claude-sonnet-5-5`. `OPENAI_MODEL` is not used. The id has to appear in the built-in Anthropic catalog.

A catalog id is not proof that your account can call that model.

On an OpenAI subscription, Lean sends shell and patch as functions. It turns the model's calls back into SDK shell and patch items, so the approval prompt and the saved session stay the same. Anthropic uses the same three tools and the same approval rules.

## Session files

The default session file is `.lean/history.json`. `--session` selects another path. Lean resolves a relative path from the workspace.

Lean writes the file only after a turn completes. The file is mode 0600. It contains prompts, replies, and tool output. Keep session files private.

The file stores the canonical workspace path. Lean rejects the file when you open it from a different workspace. The error names both paths. A symlink to the same directory still matches, because Lean compares `realpath` results. Lean leaves a corrupt session file unchanged.

Opening a session creates a lock named `<session file>.lock`, mode 0600. Lean removes that lock when the process finishes normally. A second Ctrl-C can leave the file in place. A second process gets an error that names the lock. Lean does not clear a lock it did not take. Confirm that the old process is gone before you delete a leftover lock. Lean does not replay a command that was still running at exit.

When Lean creates the directory for the session file, it sets that directory to mode 0700. Lean does not change the mode of a directory that already exists.

## Change the agent

Edit `src/agent.ts` to change the SDK agent, the model settings, or how instructions are chosen. If `AGENTS.md` exists in the workspace, that file is the entire instruction text, verbatim, including trailing whitespace. If it is missing, the instruction is `You are a coding agent working in this workspace.`

Edit `src/tools.ts` to change read, shell, or patch.

Put a specialized alternative in `src/extra`. Subscription sign-in already lives there. For a different loop, call the SDK from your own script instead of adding a configuration layer.

## Check this project

These commands check Lean itself.

```bash
bun run typecheck
bun run test
bun run format:check
```

`bun run test` runs Vitest. The tests use temporary workspaces, a scripted model, and a local Responses API. They do not need an OpenAI API key.

Install the hooks once, then run every hook.

```bash
pre-commit install
pre-commit run --all-files
```

`.pre-commit-config.yaml` runs `bun run format:check`, `bun run typecheck`, and `bun run test`.

Optional checks use Python 3, local endpoints, and synthetic credentials. They do not use your accounts.

```bash
bun run test:terminal
bun run test:subscriptions
bun run test:login-cancel
```

`test:terminal` covers approval, denial, cancellation, the interactive prompt, and a piped task whose approval comes from the terminal. `test:subscriptions` runs a shell probe and an apply_patch probe. `test:login-cancel` cancels sign-in before credentials are saved. Transcripts and results are written under `.lean/terminal-checks/`, `.lean/subscription-checks/`, and `.lean/login-cancel-checks/`.

Format the files this project formats. The command does not format `AGENTS.md`.

```bash
bun run format
```

## Options and exit codes

The flags below are the whole set. An unknown flag fails before a model call and exits 1.

- `--help` prints usage to stdout and exits 0.
- `--model <name>` selects the model, as described in Credentials and models.
- `--session <path>` selects the session file. The default is `.lean/history.json`.
- `--trace` enables SDK tracing with sensitive inputs and outputs excluded.
- `--login <provider>` signs in to `openai` or `anthropic`, then exits.
- `--logout <provider>` removes that saved subscription, then exits.
- `--provider <provider>` uses that saved subscription for the task.

Exit 0 means help, sign-in, sign-out, or the task finished. An interactive session also exits 0 when Ctrl-D closes the prompt. Exit 1 means a usage error, a missing prompt, a missing credential, or a failed turn. Exit 130 means Ctrl-C cancelled the process.

## Terminal chat is not in this branch

This branch has no `tui` script. `bun run tui` does not start a chat here. The behavior below is from an unfinished terminal chat in another worktree. Do not expect these commands to work on this branch.

That chat needs a terminal. If stdin or stdout is not a terminal, it exits 1 and prints `The TUI needs a terminal.` Otherwise it signs in, or uses an API key, the same way `bun start` does. It accepts `--model`, `--provider`, `--session`, and `--trace`. It does not take a message argument. `--demo` uses no credentials, opens no session file, and runs no commands. Its sample rows are marked `synthetic`. Combining `--demo` with `--provider`, `--session`, or `--trace` is an error.

`/help` lists `/help`, `/theme`, `/model`, `/status`, `/clear`, and `/exit`. Outside `--demo`, `/model <name>` resolves the model for the next turn with the same rules as the line interface. In `--demo`, `/model` accepts only ASCII letters, digits, `_`, `.`, `:`, and `-`. It does not call a provider. `/clear` clears the screen and does not delete the saved session. `/exit` leaves the chat.

Enter sends the draft. A trailing `\` then Enter inserts a newline only when the draft is one line and the cursor is still at the end.

During approval, with an empty draft, `y` or Allow approves a proposed shell command or patch. Enter, Escape, `n`, or Deny rejects it. Page Up and Page Down scroll a long proposal. Nothing runs before you approve it.

Ctrl-C during a turn cancels that turn and does not quit. The chat saves a turn only after it finishes. A cancelled or failed turn restores the in-memory session from a snapshot taken before the session is cleared. If that restore fails, later turns are refused. A command or patch that already finished stays on disk.

After a turn is saved, and when a saved session is reopened, completed tool calls are paired with their results by call id. The row shows that result's status, or `no result` when the call has no saved result. Ctrl-O opens the selected result when the chat is idle. While the draft is empty, Tab switches Output and Raw result, and Left and Right select another saved result. Escape closes the panel. Unified diff lines on the Output tab are colored. Other output is not. The panel stays closed while a turn is running.

Ctrl-C on an empty draft asks for a second Ctrl-C to exit. The notice is `Press Ctrl+C again to exit.` If the draft is not empty, the first Ctrl-C clears it and shows that notice. `q` does not exit while the prompt is focused.

The screen is created with inline mode and 1024 rows. It does not show a model-call count or the Claude Code command list. During a proposal it shows `Proposed call. Nothing has run.`
