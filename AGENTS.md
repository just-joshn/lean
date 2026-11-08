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

# Lean Design Principles

- Native tool calling by default (instead of regex-based text parsing)
- Has a completely linear history
- Executes actions with `util.promisify(execFile)`, `util.promisify(exec)`, `child_process.execFileSync`, or other that are similar
- Simple enough to understand at a glance
- Convenient enough to use in daily workflows
- Flexible to extend
- Minimalism, hackability, and code quality: Keep the project small, easy to modify, and well written.
- Extend through alternative components: Prefer adding another version of a component over increasing the complexity of existing components.
- Keep components largely independent: Put shared helpers in a `utils` directory when useful, while keeping the arrangement simple.
- Separate specialized components: Put components for more specific uses in an `extra` directory.
- Design for users willing to edit code: The intended audience is comfortable adapting code, particularly run scripts.
- Make customization through code straightforward: Configuration files need not expose every capability; using capabilities from a custom run script should be easy.
- Keep implementation and tests concise: Remove unnecessary verbosity from model-generated code and tests while preserving readability.
- Enforce the project’s style before committing: Install and run `pre-commit`

# Vitest testing instructions

## Before writing tests

- Read the code under test, its relevant dependencies and types, nearby tests, and the Vitest configuration. Follow the project's test layout, naming, imports, fixtures, and environment.
- Check the installed Vitest version before using an API. Use the project's existing commands and package manager. Vitest APIs and defaults can differ between versions.
- Test the public contract. Cover expected results, observable side effects, errors, realistic boundaries, and relevant failure paths. Do not assert implementation details unless they are part of the contract.
- For a bug, first write and run a test that reproduces it. Confirm that the test fails for the reported reason, fix the bug, and run the test again.

## Write focused tests

- Give each test a concise name that describes one behavior. Arrange the inputs, perform the action, and assert the result. Group related tests with `describe` when useful, and keep nesting shallow.
- Use the project's `test` or `it` convention. Import Vitest APIs from `vitest` unless the project enables globals. Use Vitest's `vi` APIs, not Jest's `jest` APIs.
- Use parameterized tests for cases that share the same logic. In versions that support it, prefer `test.for` for new tests when it fits the project's conventions.
- Use `toBe` for primitives or object identity, `toEqual` for structural equality, and `toStrictEqual` when types, sparse arrays, or explicit `undefined` properties matter. Use `toBeCloseTo` for floating-point results when appropriate.
- Choose assertions that express the contract. For example, use `toMatchObject` for relevant object fields and wrap synchronous calls in a function for `toThrow`. Avoid assertions that pass for nearly any result.

## Handle async work and isolation

- Await or return asynchronous work and assertions. Await `expect(promise).resolves` and `expect(promise).rejects`. Wrap callback APIs in a promise when needed.
- Use `expect.hasAssertions()` or `expect.assertions(n)` when assertions inside callbacks, loops, or branches might not run.
- Give tests independent state. Use scoped `beforeEach` and `afterEach` hooks, fixtures, or local setup and cleanup. Use `beforeAll` and `afterAll` for shared expensive resources, and clean up resources even on failure.
- Use `setupFiles` for setup that must run before each test file, such as custom matchers or polyfills. Avoid adding global configuration when local setup is enough.
- For concurrent tests, use the test context's `expect` for assertions and snapshots. Do not share mutable state between concurrent tests.

## Mock deliberately

- Exercise the real subject under test. Prefer real dependencies when they are fast and reliable. Mock slow or nondeterministic dependencies and side effects that tests cannot safely control.
- Use `vi.fn()` for a mock function and `vi.spyOn()` for an existing method. A spy calls the original method unless its implementation is replaced. Use `mockResolvedValue` or `mockRejectedValue` for async outcomes.
- Reset mock state and restore spies between tests as needed. `mockClear` clears history, `mockReset` also resets the implementation, and `mockRestore` restores a spied-on method. Follow existing project configuration.
- Remember that `vi.mock` is hoisted. Where the installed version supports it, prefer `vi.mock(import('./module.js'), factory)` for module type inference and refactoring support.
- Mock call arguments are stored by reference. Assert before mutation or capture a copy at call time when the original value matters.

## Use snapshots with care

- Prefer targeted assertions for specific properties. Use snapshots for stable, structured output when changes across the whole output matter. Use inline snapshots for small values and file snapshots when the output format benefits from a separate file.
- Use asymmetric property matchers for volatile fields when appropriate. Await file snapshot assertions. Commit external snapshots alongside the tests.
- Review every snapshot diff against the intended behavior. Update snapshots only after confirming the new output is correct. Never accept a snapshot update merely to make a test pass.

## Run and debug tests

- Run the affected tests with the project's Vitest command in non-watch mode, such as `vitest run path/to/file.test.ts`. Then run the relevant broader checks required by the project. Run type checking separately because a normal Vitest run does not type-check TypeScript.
- Read the failing assertion, expected and received values, stack trace, and snapshot diff before changing a test. Isolate a failure by file or test name, then rerun the broader suite after fixing it.
- If a test passes alone but fails in the suite, investigate shared state, mock cleanup, and test order. For timeouts or intermittent failures, inspect awaited work and callbacks. For missing browser globals, check the configured environment or Browser Mode.
- Remove temporary `.only` modifiers and debugging code before finishing. Do not skip or weaken a failing test merely to make the suite pass. Report checks that could not be run.

## Official sources

- [Writing tests](https://vitest.dev/guide/learn/writing-tests)
- [Using matchers](https://vitest.dev/guide/learn/matchers)
- [Testing asynchronous code](https://vitest.dev/guide/learn/async)
- [Setup and teardown](https://vitest.dev/guide/learn/setup-teardown)
- [Mock functions](https://vitest.dev/guide/learn/mock-functions)
- [Snapshot testing](https://vitest.dev/guide/learn/snapshots)
- [Testing in practice](https://vitest.dev/guide/learn/testing-in-practice)
- [Debugging failing tests](https://vitest.dev/guide/learn/debugging-tests)
- [Writing tests with AI](https://vitest.dev/guide/learn/writing-tests-with-ai)

