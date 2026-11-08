import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "./index.ts";

const credentialDrain = vi.hoisted(() => {
  let releaseWrite = () => {};
  return {
    directory: "",
    wait: new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }),
    release: () => {
      releaseWrite();
    },
  };
});

vi.mock(import("./session.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.ts")>();
  const { MemorySession } = await import("@openai/agents");
  return {
    ...actual,
    openSession: async () => ({
      session: new MemorySession(),
      save: async () => {},
      close: async () => {
        throw new Error("session cleanup failed");
      },
    }),
  };
});

vi.mock(import("./agent.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent.ts")>();
  const runTurn: typeof actual.runTurn = () => {
    throw new Error("cleanup coverage does not call the model");
  };
  return { ...actual, runTurn };
});

vi.mock(import("./extra/auth.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extra/auth.ts")>();
  return {
    ...actual,
    createSubscriptions() {
      const store = actual.openCredentialStore(credentialDrain.directory);
      void store.modify("openai", async () => {
        await credentialDrain.wait;
        return {
          type: "oauth" as const,
          access: "synthetic-drained",
          refresh: "synthetic-refresh",
          expires: 1_800_000_000_000,
        };
      });
      return {
        redact(error: unknown) {
          return error instanceof Error ? error.message : String(error);
        },
        async login() {},
        async logout() {},
        async resolveModel() {
          return "gpt-5.4";
        },
        close: () => store.close(),
      };
    },
  };
});

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-cli-test-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function cli(
  args: string[],
  input = "",
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    script?: string;
    home?: string;
  } = {},
) {
  const leanHome = options.home ?? (await workspace());
  return new Promise<{
    code: number | string | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const command =
      options.script === undefined
        ? ["run", entry, ...args]
        : ["-e", options.script];
    const child = spawn("bun", command, {
      detached: true,
      cwd: options.cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
        OPENAI_AGENTS_DISABLE_TRACING: "1",
        LEAN_HOME: leanHome,
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code: code ?? signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function message(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

async function endpoint(
  respond: (
    request: Record<string, unknown>,
    index: number,
  ) => Record<string, unknown>[],
  status = 200,
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (status !== 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "The test service rejected this request.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      );
      return;
    }
    const output = respond(body, requests.length - 1);
    const completed = {
      id: `resp_${requests.length}`,
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event: Record<string, unknown>) =>
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    send({
      type: "response.created",
      response: { ...completed, status: "in_progress", output: [] },
    });
    output.forEach((item, output_index) => {
      send({ type: "response.output_item.added", output_index, item });
      if (item.type === "message") {
        const content = item.content as { text: string }[];
        send({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index,
          content_index: 0,
          delta: content[0]!.text,
        });
      }
      send({ type: "response.output_item.done", output_index, item });
    });
    send({ type: "response.completed", response: completed });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test endpoint");
  return {
    requests,
    env: {
      OPENAI_API_KEY: "local-test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_MODEL: "gpt-5.4",
    },
  };
}

test("help describes how to run the CLI without an API key", async () => {
  const result = await cli(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("--help");
  expect(result.stderr).toBe("");
});

test("help exposes subscription sign-in without requiring an API key", async () => {
  const result = await cli(["--help"]);
  expect(result.code).toBe(0);
  for (const flag of ["--login", "--logout", "--provider"]) {
    expect(result.stdout).toContain(flag);
  }
  expect(result.stderr).toBe("");
});

test("OAuth sign-in rejects piped input instead of treating it as a code", async () => {
  const cwd = await workspace();
  const result = await cli(
    ["--login", "openai"],
    "not-an-authorization-code\n",
    { cwd },
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/terminal/i);
  expect(result.stderr).not.toContain("not-an-authorization-code");
  await expect(readFile(join(cwd, ".lean/history.json"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

test("an unknown OAuth provider fails with supported choices", async () => {
  const result = await cli(["--provider", "not-a-provider", "Say hello"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("not-a-provider");
  expect(result.stderr).toContain("openai");
  expect(result.stderr).toContain("anthropic");
});

test("unknown options fail before starting an agent", async () => {
  const result = await cli(["--not-a-real-option"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/unknown|unexpected/i);
});

test("a missing API key produces an actionable error", async () => {
  const result = await cli(["Say hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("OPENAI_API_KEY");
});

test("empty piped input fails without calling the model", async () => {
  const result = await cli([]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/input|prompt/i);
});

test("the executable streams an SDK response with verbatim workspace instructions", async () => {
  const cwd = await workspace();
  const instructions = "# Workspace instructions\nUse λ exactly.  \n\n";
  await writeFile(join(cwd, "AGENTS.md"), instructions);
  const api = await endpoint(() => [message("Streamed answer.")]);
  const result = await cli(["Say hello"], "", { cwd, env: api.env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("Streamed answer.\n");
  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]!.instructions).toEqual(
    expect.stringContaining(instructions),
  );
  expect(api.requests[0]!.model).toBe("gpt-5.4");
});

test("opted-in traces flush before main returns", async () => {
  const cwd = await workspace();
  const flag = join(cwd, "flushed.txt");
  const api = await endpoint(() => [message("Trace done.")]);
  const script = `
    import { setTraceProcessors } from '@openai/agents';
    import { main } from ${JSON.stringify(entry)};
    setTraceProcessors([{
      onTraceStart() {}, onTraceEnd() {}, onSpanStart() {}, onSpanEnd() {},
      async shutdown() {},
      async forceFlush() { await Bun.write(${JSON.stringify(flag)}, 'flushed'); }
    }]);
    process.chdir(${JSON.stringify(cwd)});
    const code = await main(['--trace', 'Say hello']);
    if (!await Bun.file(${JSON.stringify(flag)}).exists()) throw new Error('Trace export was not flushed before main returned.');
    process.exit(code);
  `;
  const result = await cli([], "", {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: api.env,
    script,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("Trace done.\n");
  expect(await readFile(flag, "utf8")).toBe("flushed");
});

test("an API failure exits without saving a partial conversation", async () => {
  const cwd = await workspace();
  const session = join(cwd, "failed.json");
  const api = await endpoint(() => [], 401);
  const result = await cli(["--session", session, "Say hello"], "", {
    cwd,
    env: api.env,
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("The test service rejected this request.");
  expect(result.stderr).not.toContain("local-test-key");
  await expect(readFile(session)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the SDK reads a local file and returns its contents to the model", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "note.txt"), "A real file contains apricot.\n");
  const api = await endpoint((_request, index) =>
    index === 0
      ? [
          {
            id: "read_test",
            type: "function_call",
            call_id: "call_read_test",
            name: "read",
            arguments: JSON.stringify({ path: "note.txt" }),
            status: "completed",
          },
        ]
      : [message("Read the note.")],
  );
  const result = await cli(["Read note.txt"], "", { cwd, env: api.env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("Read the note.\n");
  expect(api.requests).toHaveLength(2);
  expect(JSON.stringify(api.requests[1]!.input)).toContain(
    "A real file contains apricot.",
  );
});

test("noninteractive input cannot approve a native shell call", async () => {
  const cwd = await workspace();
  const api = await endpoint((_request, index) =>
    index === 0
      ? [
          {
            id: "shell_test",
            type: "shell_call",
            call_id: "call_shell_test",
            status: "completed",
            action: {
              commands: ["printf executed > forbidden.txt"],
              timeout_ms: 1000,
              max_output_length: 1000,
            },
          },
        ]
      : [message("The command was denied.")],
  );
  const result = await cli([], "Run the command.\ny\n", { cwd, env: api.env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("The command was denied.\n");
  expect(api.requests).toHaveLength(2);
  expect(JSON.stringify(api.requests[1]!.input)).toContain("shell_call_output");
  await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("an unknown provider fails before an API key is required", async () => {
  const result = await cli(["--provider", "not-a-provider", "Say hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("not-a-provider");
  expect(result.stderr).not.toContain("OPENAI_API_KEY");
  expect(result.stderr).not.toContain("local-test-key");
});

test("login does not read a piped value as an authorization code", async () => {
  const cwd = await workspace();
  const home = await workspace();
  const result = await cli(
    ["--login", "openai"],
    "https://example.test/callback?code=synthetic-secret",
    {
      cwd,
      home,
    },
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.toLowerCase()).toContain("terminal");
  expect(result.stderr).not.toContain("synthetic-secret");
  await expect(readFile(join(cwd, ".lean/history.json"))).rejects.toMatchObject(
    {
      code: "ENOENT",
    },
  );
});

test("an API key does not read subscription files", async () => {
  const cwd = await workspace();
  const home = await workspace();
  await writeFile(join(home, "openai.json"), "{");
  const api = await endpoint(() => [message("Key path.")]);
  const result = await cli(["Say hello"], "", { cwd, home, env: api.env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("Key path.\n");
  expect(api.requests).toHaveLength(1);
});

test("an explicit provider does not fall back to an API key", async () => {
  const cwd = await workspace();
  const home = await workspace();
  const api = await endpoint(() => [message("Should not run.")]);
  const result = await cli(["--provider", "openai", "Say hello"], "", {
    cwd,
    home,
    env: api.env,
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("openai");
  expect(result.stderr).not.toContain("local-test-key");
  expect(api.requests).toHaveLength(0);
});

test("logout removes nothing else and does not start a session", async () => {
  const cwd = await workspace();
  const home = await workspace();
  const openai = {
    type: "oauth",
    access: "synthetic-openai-access",
    refresh: "synthetic-openai-refresh",
    expires: 1_800_000_000_000,
  };
  const anthropic = {
    type: "oauth",
    access: "sk-ant-oat-synthetic-access",
    refresh: "synthetic-anthropic-refresh",
    expires: 1_800_000_000_000,
  };
  await writeFile(join(home, "openai.json"), `${JSON.stringify(openai)}\n`, {
    mode: 0o600,
  });
  const sibling = `${JSON.stringify(anthropic)}\n`;
  await writeFile(join(home, "anthropic.json"), sibling, { mode: 0o600 });
  const api = await endpoint(() => []);
  const result = await cli(["--logout", "openai"], "leftover prompt", {
    cwd,
    home,
    env: api.env,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Signed out of OpenAI.\n");
  await expect(readFile(join(home, "openai.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(home, "anthropic.json"), "utf8")).toBe(sibling);
  await expect(readFile(join(cwd, ".lean/history.json"))).rejects.toMatchObject(
    {
      code: "ENOENT",
    },
  );
  expect(api.requests).toHaveLength(0);
});

test("piped input is saved and included once in the next invocation", async () => {
  const cwd = await workspace();
  const session = join(cwd, "conversation.json");
  const api = await endpoint(() => [message("Remembered.")]);
  const first = await cli(
    ["--session", session],
    "Remember the word apricot.",
    { cwd, env: api.env },
  );
  expect(first.code, first.stderr).toBe(0);
  const second = await cli(["--session", session, "What word?"], "", {
    cwd,
    env: api.env,
  });
  expect(second.code, second.stderr).toBe(0);
  expect(api.requests).toHaveLength(2);
  const input = JSON.stringify(api.requests[1]!.input);
  expect(input.match(/Remember the word apricot\./g)).toHaveLength(1);
  expect(input).toContain("What word?");
  expect(input).toContain("Remembered.");
  expect(await readFile(session, "utf8")).toContain("apricot");
});

test("a session cleanup failure still drains credential writes", async () => {
  const directory = await workspace();
  credentialDrain.directory = directory;
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  let settled = false;
  const pending = main(["Say hello"]);
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  try {
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    credentialDrain.release();
    stderr.mockRestore();
    await pending.catch(() => undefined);
  }
  await expect(pending).rejects.toThrow("session cleanup failed");
  const saved = JSON.parse(
    await readFile(join(directory, "openai.json"), "utf8"),
  ) as {
    access: string;
  };
  expect(saved.access).toBe("synthetic-drained");
});
