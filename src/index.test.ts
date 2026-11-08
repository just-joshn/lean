import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-cli-test-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function cli(
  args: string[],
  input = "",
  options: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string } = {},
) {
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
