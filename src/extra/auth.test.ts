import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { protocol, type Model, type ModelRequest } from "@openai/agents";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSubscriptions,
  openCredentialStore,
  redactText,
  type ProviderId,
} from "./auth.ts";

const installationGate = vi.hoisted(() => {
  let release = () => {};
  return {
    armed: false,
    reads: 0,
    hold: Promise.resolve() as Promise<void>,
    arm() {
      this.armed = true;
      this.reads = 0;
      this.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    disarm() {
      this.armed = false;
      release();
    },
    async holdPublish(path: unknown) {
      if (
        !this.armed ||
        typeof path !== "string" ||
        !path.endsWith("/installation.json")
      ) {
        return;
      }
      this.reads += 1;
      if (this.reads === 2) release();
      await this.hold;
    },
  };
});

const recordedDevices = vi.hoisted(() => {
  const state = {
    capture: false,
    values: [] as string[],
    login(access: string) {
      return async (
        _interaction: unknown,
        options?: { getDeviceId?: () => string },
      ) => {
        const id = options?.getDeviceId?.();
        if (typeof id === "string") state.values.push(id);
        return {
          type: "oauth" as const,
          access,
          refresh: `${access}-refresh`,
          expires: 1_800_000_000_000,
        };
      };
    },
  };
  return state;
});

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  const link: typeof actual.link = async (existingPath, newPath) => {
    await installationGate.holdPublish(newPath);
    return actual.link(existingPath, newPath);
  };
  const rename: typeof actual.rename = async (oldPath, newPath) => {
    await installationGate.holdPublish(newPath);
    return actual.rename(oldPath, newPath);
  };
  return { ...actual, link, rename };
});

vi.mock(
  import("@earendil-works/pi-ai/providers/openai"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      openaiProvider() {
        const provider = actual.openaiProvider();
        const oauth = provider.auth.oauth;
        if (oauth && recordedDevices.capture) {
          oauth.login = recordedDevices.login("synthetic-openai-access");
        }
        return provider;
      },
    };
  },
);

vi.mock(
  import("@earendil-works/pi-ai/providers/anthropic"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      anthropicProvider() {
        const provider = actual.anthropicProvider();
        const oauth = provider.auth.oauth;
        if (oauth && recordedDevices.capture) {
          oauth.login = recordedDevices.login("synthetic-anthropic-access");
        }
        return provider;
      },
    };
  },
);

const homes: string[] = [];

afterEach(async () => {
  recordedDevices.capture = false;
  recordedDevices.values.length = 0;
  installationGate.disarm();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lean-auth-"));
  homes.push(directory);
  return directory;
}

function credential(
  access: string,
  refresh = `${access}-refresh`,
  expires = 1_800_000_000_000,
) {
  return {
    type: "oauth" as const,
    access,
    refresh,
    expires,
    clientId: "synthetic-client",
    accountId: "acct_synthetic",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  };
}

function request(
  input: ModelRequest["input"],
  signal?: AbortSignal,
): ModelRequest {
  return {
    input,
    modelSettings: {
      temperature: 0.2,
      maxTokens: 16,
      store: true,
      promptCacheRetention: "24h",
    },
    tools: [
      { type: "shell", name: "shell" },
      { type: "apply_patch", name: "apply_patch" },
    ],
    outputType: "text",
    handoffs: [],
    tracing: false,
    signal,
  };
}

function responsesStream(text: string): string {
  const events = [
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function modelFor(
  directory: string,
  provider: ProviderId,
  modelId: string,
): Promise<{
  model: Model;
  close: () => Promise<void>;
  redact: (error: unknown) => string;
}> {
  const subscriptions = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "", LEAN_HOME: directory },
  });
  const model = await subscriptions.resolveModel({ provider, model: modelId });
  if (typeof model === "string")
    throw new Error("Expected a subscription model.");
  return {
    model,
    close: () => subscriptions.close(),
    redact: subscriptions.redact,
  };
}

test("credentials keep metadata and private permissions", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  await store.modify("openai", async () =>
    credential("synthetic-openai-access"),
  );
  const file = join(directory, "openai.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  expect(saved.access).toBe("synthetic-openai-access");
  expect(saved.accountId).toBe("acct_synthetic");
  expect(saved.clientId).toBe("synthetic-client");
  expect(saved.scopes).toEqual(["openid", "chatgpt.tokens.use.direct"]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  await store.close();
});

test("a corrupt credential file is left unchanged", async () => {
  const directory = await home();
  const file = join(directory, "anthropic.json");
  await writeFile(file, "{", { mode: 0o600 });
  const store = openCredentialStore(directory);
  await expect(store.read("anthropic")).rejects.toThrow(/unchanged/);
  expect(await readFile(file, "utf8")).toBe("{");
  await store.close();
});

test("a held lock is not taken over", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  await writeFile(join(directory, "openai.json.lock"), "", { mode: 0o600 });
  await expect(
    store.modify("openai", async () => credential("synthetic-openai-access")),
  ).rejects.toThrow(/lock/i);
  await expect(readFile(join(directory, "openai.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await store.close();
});

test("cancelling a queued credential write does not replace the saved token", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = store.modify("openai", async () => {
    await gate;
    return credential("synthetic-access-first");
  });
  const controller = new AbortController();
  const second = store.modify(
    "openai",
    async () => credential("synthetic-access-second"),
    {
      signal: controller.signal,
    },
  );
  controller.abort();
  try {
    await expect(second).rejects.toThrow(/abort/i);
    release();
    await first;
    const saved = JSON.parse(
      await readFile(join(directory, "openai.json"), "utf8"),
    ) as {
      access: string;
    };
    expect(saved.access).toBe("synthetic-access-first");
  } finally {
    release();
    await first.catch(() => undefined);
    await store.close();
  }
});

test.for([false, true])(
  "close drains queued credential writes with failure=%s",
  async (fails) => {
    const directory = await home();
    const store = openCredentialStore(directory);
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let markStarted = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = store.modify("openai", async () => {
      await firstGate;
      return credential("synthetic-access-first");
    });
    const second = store.modify("openai", async () => {
      markStarted();
      await secondGate;
      if (fails) throw new Error("synthetic write failed");
      return credential("synthetic-access-second");
    });
    const outcome = fails
      ? expect(second).rejects.toThrow("synthetic write failed")
      : second;
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    try {
      releaseFirst();
      await started;
      await setImmediate();
      expect(closed).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await closing;
      await Promise.all([first, outcome]);
    }
    expect(closed).toBe(true);
    const saved = JSON.parse(
      await readFile(join(directory, "openai.json"), "utf8"),
    ) as { access: string };
    expect(saved.access).toBe(
      fails ? "synthetic-access-first" : "synthetic-access-second",
    );
  },
);

test("concurrent first logins share one installation id", async () => {
  const directory = await home();
  recordedDevices.capture = true;
  recordedDevices.values.length = 0;
  installationGate.arm();
  const left = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "" },
  });
  const right = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "" },
  });
  const controller = new AbortController();
  const previousTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    await Promise.all([
      left.login("openai", controller.signal),
      right.login("anthropic", controller.signal),
    ]);
    expect(recordedDevices.values).toHaveLength(2);
    expect(recordedDevices.values[0]).toBe(recordedDevices.values[1]);
    const saved = JSON.parse(
      await readFile(join(directory, "installation.json"), "utf8"),
    ) as { id: string };
    expect(saved.id).toBe(recordedDevices.values[0]);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: previousTty,
    });
    controller.abort();
    installationGate.disarm();
    recordedDevices.capture = false;
    await Promise.allSettled([left.close(), right.close()]);
  }
});

test("redaction removes access tokens, refresh tokens, and raw provider bodies", () => {
  const access = "synthetic-openai-access-token";
  const refresh = "synthetic-openai-refresh-token";
  const text = redactText(
    `Authorization: Bearer ${access}\nrefresh ${refresh}\nbody={"access_token":"${access}","refresh_token":"${refresh}"}`,
    [access, refresh],
  );
  expect(text).not.toContain(access);
  expect(text).not.toContain(refresh);
  expect(text).toContain("[redacted]");
});

test.for([
  {
    label: "json body with a semicolon before unknown tokens",
    text: '401 body={"error":"bad;token","access_token":"SECRET-ACCESS-TOKEN-VALUE","refresh_token":"SECRET-REFRESH-TOKEN-VALUE"}; details=401',
  },
  {
    label: "form body with a semicolon",
    text: "401 body=error=invalid_grant; access_token=SECRET-ACCESS-TOKEN-VALUE; refresh_token=SECRET-REFRESH-TOKEN-VALUE; details=401",
  },
  {
    label: "multiline body",
    text: '401 body={"error":"bad\ntoken","access_token":"SECRET-ACCESS-TOKEN-VALUE","refresh_token":"SECRET-REFRESH-TOKEN-VALUE"}',
  },
])("redacts an unknown $label", ({ text }) => {
  expect(redactText(text, [])).toBe("401 body=[redacted]");
});

test("an API key is selected without reading a saved subscription", async () => {
  const directory = await home();
  await writeFile(join(directory, "openai.json"), "{", { mode: 0o600 });
  const subscriptions = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "synthetic-api-key", OPENAI_MODEL: "gpt-5.4" },
  });
  await expect(subscriptions.resolveModel({})).resolves.toBe("gpt-5.4");
  await subscriptions.close();
});

test("one saved subscription is selected and two require a provider", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  await store.modify("anthropic", async () =>
    credential("sk-ant-oat-synthetic-access"),
  );
  await store.close();
  const only = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "" },
  });
  const model = await only.resolveModel({});
  expect(model).toEqual(
    expect.objectContaining({
      getResponse: expect.any(Function),
      getStreamedResponse: expect.any(Function),
    }),
  );
  await only.close();
  const bothStore = openCredentialStore(directory);
  await bothStore.modify("openai", async () =>
    credential("synthetic-openai-access"),
  );
  await bothStore.close();
  const both = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "" },
  });
  await expect(both.resolveModel({})).rejects.toThrow(/--provider/);
  await both.close();
});

test("an explicit provider does not fall back when refresh fails", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  await store.modify("openai", async () =>
    credential("synthetic-openai-access", "old-refresh", 0),
  );
  await store.close();
  vi.stubGlobal(
    "fetch",
    async () => new Response("secret-body", { status: 401 }),
  );
  const selected = await modelFor(directory, "openai", "gpt-5.4");
  const pending = selected.model.getResponse(request("Say hello"));
  const caught = await pending.catch((error: unknown) => error);
  const message = caught instanceof Error ? caught.message : undefined;
  expect(caught).toBeInstanceOf(Error);
  expect(message).toMatch(/redacted|401/);
  expect(selected.redact(caught)).not.toContain("secret-body");
  expect(selected.redact(caught)).not.toContain("synthetic-openai-access");
  const saved = JSON.parse(
    await readFile(join(directory, "openai.json"), "utf8"),
  ) as {
    access: string;
  };
  expect(saved.access).toBe("synthetic-openai-access");
  await selected.close();
});

test("ChatGPT requests use the subscription token and omit unsupported settings", async () => {
  const directory = await home();
  const access = "synthetic-openai-access-token";
  const store = openCredentialStore(directory);
  await store.modify("openai", async () => credential(access));
  await store.close();
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${access}`,
    );
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(responsesStream("Done."), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const selected = await modelFor(directory, "openai", "gpt-5.4");
  const response = await selected.model.getResponse(request("Say hello"));
  const body = bodies[0] as Record<string, unknown>;
  expect(body.store).toBe(false);
  expect(body.temperature).toBeUndefined();
  expect(body.max_output_tokens).toBeUndefined();
  expect(body.prompt_cache_retention).toBeUndefined();
  expect(body.tools).toEqual([
    expect.objectContaining({
      type: "function",
      name: "shell",
      description: "Run shell commands in the workspace.",
      strict: false,
      parameters: expect.objectContaining({
        type: "object",
        required: ["action"],
        additionalProperties: false,
        properties: {
          action: expect.objectContaining({
            type: "object",
            required: ["commands"],
            additionalProperties: false,
          }),
        },
      }),
    }),
    expect.objectContaining({
      type: "function",
      name: "apply_patch",
      description: "Create, update, or delete a workspace file.",
      strict: false,
      parameters: expect.objectContaining({
        type: "object",
        required: ["operation"],
        additionalProperties: false,
        properties: {
          operation: expect.objectContaining({ oneOf: expect.any(Array) }),
        },
      }),
    }),
  ]);
  expect(JSON.stringify(body.tools)).not.toContain("$schema");
  expect(JSON.stringify(body.tools)).not.toContain('"type":"shell"');
  expect(JSON.stringify(body.tools)).not.toContain('"type":"apply_patch"');
  expect(response.output).toEqual([
    expect.objectContaining({
      role: "assistant",
      content: [expect.objectContaining({ text: "Done." })],
    }),
  ]);
  await selected.close();
});

test("an aborted refresh still stores the rotated token", async () => {
  const directory = await home();
  const previous = credential(
    "synthetic-openai-access-old",
    "synthetic-openai-refresh-old",
    0,
  );
  const nextAccess = "synthetic-openai-access-next";
  const nextRefresh = "synthetic-openai-refresh-next";
  const store = openCredentialStore(directory);
  await store.modify("openai", async () => previous);
  await store.close();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal("fetch", async (url: string) => {
    expect(String(url)).toContain("/oauth/token");
    started();
    await gate;
    return Response.json({
      access_token: nextAccess,
      refresh_token: nextRefresh,
      expires_in: 3600,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    });
  });
  const selected = await modelFor(directory, "openai", "gpt-5.4");
  const controller = new AbortController();
  const pending = selected.model.getResponse(
    request("Say hello", controller.signal),
  );
  await startedPromise;
  controller.abort();
  release();
  await expect(pending).rejects.toThrow();
  await selected.close();
  const saved = JSON.parse(
    await readFile(join(directory, "openai.json"), "utf8"),
  ) as {
    access: string;
    refresh: string;
  };
  expect(saved.access).toBe(nextAccess);
  expect(saved.refresh).toBe(nextRefresh);
  await expect(pending).rejects.not.toThrow(/synthetic-openai/);
});

test("native shell history is forwarded to the Responses API", async () => {
  const directory = await home();
  const store = openCredentialStore(directory);
  await store.modify("openai", async () =>
    credential("synthetic-openai-access"),
  );
  await store.close();
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(responsesStream("Done."), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const shell = protocol.ShellCallItem.parse({
    type: "shell_call",
    callId: "call_shell",
    status: "completed",
    name: "shell",
    action: { commands: ["printf x"], timeoutMs: 1000 },
  });
  const shellResult = protocol.ShellCallResultItem.parse({
    type: "shell_call_output",
    callId: "call_shell",
    status: "completed",
    output: [
      { stdout: "x", stderr: "", outcome: { type: "exit", exitCode: 0 } },
    ],
  });
  const selected = await modelFor(directory, "openai", "gpt-5.4");
  await selected.model.getResponse(
    request([shell, shellResult, { role: "user", content: "Next" }]),
  );
  expect(JSON.stringify(bodies[0])).toContain("call_shell");
  await selected.close();
});
