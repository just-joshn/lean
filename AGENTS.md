# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.


# Lean Non-negotiable Design Principles

| Principle | What strict adherence means for Lean |
|---|---|
| **Radical minimalism** | The smallest comprehensible implementation is preferred over a sophisticated framework, even when the framework offers more functionality. |
| **Model-centered intelligence** | The model reasons about engineering work; the scaffold does not encode an elaborate decision-making system. |
| **Bash-only computer interface** | The agent can execute shell commands. It does not receive a catalog of specialized coding, review, planning, browser, or delegation tools. |
| **Simple control flow** | The core process is model query, execute action, return observation, repeat. |
| **Linear message history** | Each model response and resulting observation is appended to one chronological record. |
| **Independent command execution** | Each action launches a new command process rather than entering text into a persistent interactive shell. |
| **Minimal internal state** | The agent retains the state necessary for execution and accounting, not a second hidden workflow state machine. |
| **Small, separable components** | Model selection, action execution, and agent control flow remain separate. |
| **Simple extensibility** | Different models or execution environments can be substituted without rewriting the central loop. |
| **Inspectability** | The message trajectory is sufficient to reconstruct the agent's conversational execution history. |
| **Model portability** | No fundamental behavior depends on one provider's proprietary orchestration capabilities. |
| **Useful simplicity** | Complexity is permitted when it demonstrably improves the tool. It is not permitted merely to anticipate possible future needs. |

**Single action interface, not necessarily one command per response.** The Lean model interface exposes a single tool named `bash`. Its native-tool parser can accept multiple calls to that tool. The alternative text parser requires exactly one action. These are two supported formats for the same fundamental execution capability.

**No persistent shell, but persistent workspace.** Commands are independently executed. A directory change or exported variable does not automatically persist into the next command. Filesystem changes do. Docker environments may preserve a container and its filesystem while starting a new command execution for each action.

**Model statelessness is not total agent statelessness.** The model adapter receives messages and produces a response. The agent still tracks cost, call count, elapsed time, and history. The environment may retain workspace state. Minimality means making the state explicit, not pretending state does not exist.

**Models own action parsing and observation formatting.** In Lean, these responsibilities live with model adapters. The agent remains largely indifferent to whether the provider uses native tool calls or text-based commands.

**Errors are part of the observable execution history.** Malformed model output, submitted results, exhausted limits, and interruptions have explicit handling. Failures must not silently become successful completions.

**Safety is configurable, not synonymous with autonomy.** Lean's interactive CLI defaults to confirming actions. Unattended execution is an explicit alternative.

**The code should remain easy to replace.** Lean uses structural protocols and interchangeable classes rather than demanding one elaborate inheritance hierarchy.

# Vitest gate

Run this gate before you create, read, update, or delete a Vitest test in Lean. Fetched official Vitest docs for the installed major are the Vitest rules. Training memory is not a source. Do not paste a fetched page into this section later.

A Vitest API call with no supporting sentence in the fetched docs fails the gate. A Lean binding may close a choice the docs leave open, such as file layout. A Lean binding does not override a fetched correctness rule.

## Run the gate

Finish the steps in order. Do not change a test file or a Vitest config file before step 6. Do not start step 6 until step 4 has fetched text.

1. Name the verb and the file.
   Pick one verb. The choices are create, read, update, or delete. Name the `*.test.ts` file the task touches. If the task touches no Vitest test file, skip this gate.

2. Match `package.json` to the binding table.
   Read the `vitest` version and the `test` script. If the major is not 5, stop and report the version you read. If the `test` script is not `vitest run`, stop and report the script. Do not guess APIs for another major.

3. Resolve a Context7 id for that major.
   Write the library query as Vitest, major 5, and the topic of this change. Mocking, matchers, hooks, async work, and projects are typical topics.
   Run `npx ctx7@latest library vitest "Vitest 5 <topic>"` only after you replace `<topic>`. Do not send a placeholder.
   Pick an id under `/vitest-dev/vitest` whose version matches the installed major. Prefer a closer 5.x id when the command returns one. Reject a 4.x id.

4. Fetch the topic and open the official pages.
   Run `npx ctx7@latest docs <id> "<topic>"` only after you replace `<id>` and `<topic>`. Run one command per topic. Run at most three Context7 commands. Keep the returned text.
   Open [Writing tests with AI](https://vitest.dev/guide/learn/writing-tests-with-ai) for every verb. Open every other page the source index lists for this change.
   If Context7 returns a quota error, tell the user to run `npx ctx7@latest login` or to set `CONTEXT7_API_KEY`. Official vitest.dev pages are still a source. If Context7 fails and those pages do not load, stop. Do not write the change from memory.
   Reuse fetched text in this session only when the version and the topic are the same. A new topic needs a new fetch.

5. Read the files the Writing tests with AI page names.
   Read the source under test, its public types, and the nearest existing `*.test.ts` for that source. Lean has no `vitest.config.*`. Read `package.json` and this section in its place.
   Copy temp directories, `vi.hoisted` state, and `afterEach` cleanup from that nearest test. Take each new or changed Vitest API from the fetched docs. Do not invent Browser Mode, `setupFiles`, globals, or a Vitest snapshot workflow that this suite does not use.

6. Apply the fetched docs to the verb.
   For a bug fix, write and run the failing reproduction test before you change product code. Confirm it fails for the reported reason.
   For create or update, change only the lines the task needs. Every Vitest API you add or change must appear in the fetched text. If you cannot point at that sentence, remove the call.
   For read, explain an API from the fetched text and from the file. Do not edit the file.
   For delete, remove a test only when the task says to remove it, or when the behavior it guards is gone. Do not remove, skip, or weaken a test to make a run pass.

7. Run the file you changed.
   If the verb is read and you changed no file, skip this step.
   Otherwise run `bun run test` and pass the test path. Do not run `bun test`. Do not run `bun run test:tui` as a Vitest substitute. Do not pass a watch flag. The `test` script already runs `vitest run`.
   Read the assertion, the expected value, the received value, and the stack before you edit a failure.
   Run `bun run typecheck` when the change affects TypeScript types. A Vitest run does not type-check.

8. Report the gate before you finish.
   The verb is create, read, update, or delete.
   The installed Vitest version is the version you read in `package.json`.
   The fetched sources are the Context7 id and the page URLs.
   The nearest test is the path you copied cleanup from, or none.
   The run result is pass, fail, or not run.
   An empty field means the gate is not finished.

## Decision owners

| Decision | Owner |
| --- | --- |
| Which Vitest API a new or changed call may use | The fetched docs for the installed major |
| The test command, file pattern, import source, and whether a config file exists | The binding table |
| Temp directories, `vi.hoisted` state, `afterEach` cleanup, and which modules a test mocks | The nearest existing `*.test.ts` for that source |
| An existing line that differs from the current docs | The current file owns that line until the task edits it. The fetched docs own the edited call. |

## Binding table

These are Lean facts. A mismatch with the repo stops the gate.

| Id | Binding | Lean value |
| --- | --- | --- |
| B-VER | Vitest | `5.1.0` in `devDependencies`. Major 5. If `package.json` differs, follow `package.json` and fetch that major. |
| B-RUN | Command | `bun run test`, with an optional test path. Never `bun test`. Never a watch flag. |
| B-TYPE | Typecheck | `bun run typecheck` (`bun check`). Separate from Vitest. |
| B-LAYOUT | Files | Co-located `*.test.ts` under `src/`. Do not add `*.spec.ts`. Do not add a `tests/` tree. |
| B-IMPORT | Imports | Named imports from `"vitest"`. Use `test`, not `it`. Globals are off. Use `vi`, never `jest`. |
| B-CONFIG | Config | No `vitest.config.*`. Do not add one as part of a test change. Defaults apply (`environment: node`, `isolate: true`, `pool: forks`, `clearMocks: true`, `restoreMocks: false`). |
| B-CLEAN | Cleanup | Restore spies and unstub env or globals in the file that uses them. `clearMocks` alone does not restore implementations or stubs. |
| B-MOCKNEW | New mocks | Prefer `vi.mock(import("../path.ts"), factory)` with the same `.ts` specifier style as production imports. Leave an untouched string-form `vi.mock` alone. |
| B-PARAM | Parameterize | Use `test.for` for new parameterized tests. Do not rewrite untouched `test.each` calls. |
| B-ORACLE | Oracles | This suite uses JSON oracles and contract assertions. Do not introduce Vitest snapshot files unless the task explicitly requires them and the fetched Snapshot page governs the edit. |
| B-SUBJECT | Seams | Prefer real subjects. Mock network, interactive prompt, subprocess, or other slow or unsafe seams. Neighboring tests use `vi.hoisted`, `importOriginal`, protocol fakes, `mkdtemp`, and spawned `bun` for CLI. |
| B-TUI | Outside Vitest | `bun run test:tui` runs `python3 scripts/verify-tui.py`. It is not a Vitest run. |

## Required shapes

New module mock (import form):

```ts
vi.mock(import("../models/index.ts"), () => ({
  getModel,
}))
```

Spy or env stub cleanup in the same file:

```ts
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
```

New parameterized test:

```ts
test.for(rows)("accepts $label", (row) => {
  expect(parse(row.input)).toEqual(row.output)
})
```

Concurrent test assertions use context `expect`:

```ts
test.concurrent("counts one action", async ({ expect }) => {
  expect(actions).toEqual([one])
})
```

## Gate failures

The change is not done when any sentence below is true.

- A test file or a Vitest config file changed before step 4 produced fetched text.
- A new or changed Vitest call has no sentence in that text.
- The diff violates the binding table.
- The diff rewrites untouched `test.each` calls or untouched string `vi.mock` calls.
- The diff deletes, skips, or weakens a test so the suite can pass.
- The diff leaves `.only` in a test file.
- Context7 failed and the official pages did not load, and a file still changed.
- The step 8 report omits a field.

## Source index

The titles are addresses. Open the page and follow the page. Do not treat this index as the text of the docs.

Open [Writing tests with AI](https://vitest.dev/guide/learn/writing-tests-with-ai) for every verb.

Also open the rows that match the change.

| The change uses | Open |
| --- | --- |
| Create, update, or delete | [Writing tests](https://vitest.dev/guide/learn/writing-tests) and [Testing in practice](https://vitest.dev/guide/learn/testing-in-practice) |
| Matchers or assertions | [Using matchers](https://vitest.dev/guide/learn/matchers) |
| Async work | [Testing asynchronous code](https://vitest.dev/guide/learn/async) |
| Hooks or fixtures | [Setup and teardown](https://vitest.dev/guide/learn/setup-teardown) |
| Mocks, spies, or stubs | [Mock functions](https://vitest.dev/guide/learn/mock-functions) and [Mocking](https://vitest.dev/guide/mocking) |
| Snapshots | [Snapshot testing](https://vitest.dev/guide/learn/snapshots) |
| A failing run | [Debugging failing tests](https://vitest.dev/guide/learn/debugging-tests) |
| Config, the pool, or projects | [Getting started](https://vitest.dev/guide/) and [Features](https://vitest.dev/guide/features) |
| A slow run or pool settings | [Improving performance](https://vitest.dev/guide/improving-performance) |
| A request to turn isolation off | [Disable isolation](https://vitest.dev/guide/recipes/disable-isolation) |

If a URL does not load, open [Getting started](https://vitest.dev/guide/) and follow the nav to the page with the same title. Record the URL you actually opened. Do not replace the page with memory.
