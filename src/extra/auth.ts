import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { link, rename } from "node:fs/promises";
import {
  OpenAIProvider,
  Usage,
  getDefaultModel,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelSettings,
  type StreamEvent,
} from "@openai/agents";
import {
  createModels,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  type Models,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { z } from "zod";
import { createAnthropicModel } from "./anthropic-model.ts";

export type ProviderId = "openai" | "anthropic";

export const providerIds: readonly ProviderId[] = ["openai", "anthropic"];

const anthropicDefaultModel = "claude-sonnet-5-5";
const chatGptBaseUrl = "https://api.openai.com/v1";

const providerTable: Record<
  ProviderId,
  {
    label: string;
    models: () => readonly { id: string }[];
    defaultModel?: string;
  }
> = {
  openai: { label: "OpenAI", models: () => openaiProvider().getModels() },
  anthropic: {
    label: "Anthropic",
    models: () => anthropicProvider().getModels(),
    defaultModel: anthropicDefaultModel,
  },
};

const oauthCredentialSchema = z.looseObject({
  type: z.literal("oauth"),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite(),
});

const installationSchema = z.object({
  id: z.string().uuid(),
});

export function isProviderId(value: string): value is ProviderId {
  return providerIds.some((id) => id === value);
}

export function providerLabel(provider: ProviderId): string {
  return providerTable[provider].label;
}

export function subscriptionHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LEAN_HOME?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".lean");
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was cancelled.");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function writeTemp(file: string, body: string): Promise<string> {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  return temporary;
}

async function writePrivate(file: string, body: string): Promise<void> {
  const temporary = await writeTemp(file, body);
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(file, 0o600);
}

async function createPrivate(file: string, body: string): Promise<boolean> {
  const temporary = await writeTemp(file, body);
  try {
    await link(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  await rm(temporary, { force: true });
  await chmod(file, 0o600);
  return true;
}

export type SubscriptionStore = CredentialStore & {
  close(): Promise<void>;
  knownSecrets(): readonly string[];
};

export function openCredentialStore(home: string): SubscriptionStore {
  const secrets = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  const file = (providerId: string) => join(home, `${providerId}.json`);

  const remember = (credential: Credential | undefined) => {
    if (credential?.type !== "oauth") return;
    secrets.add(credential.access);
    secrets.add(credential.refresh);
  };

  const readFileCredential = async (
    providerId: string,
  ): Promise<Credential | undefined> => {
    let text: string;
    try {
      text = await readFile(file(providerId), "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new Error(
        `Credential file ${file(providerId)} is corrupt and was left unchanged.`,
      );
    }
    const parsed = oauthCredentialSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `Credential file ${file(providerId)} is corrupt and was left unchanged.`,
      );
    }
    remember(parsed.data);
    return parsed.data;
  };

  const withLock = async (providerId: string, run: () => Promise<void>) => {
    const lockPath = `${file(providerId)}.lock`;
    await ensureDir(dirname(lockPath));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      throw new Error(
        `Credential lock ${lockPath} is already held. Another process may be signing in or refreshing this provider. Verify that process is gone before removing the lock file.`,
      );
    }
    try {
      await run();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  };

  // pi-ai aborts only the wait for this lock. A refresh that has started must finish so a rotated token is stored.
  const enqueue = <T>(
    providerId: string,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> => {
    if (signal.aborted) return Promise.reject(abortError(signal));
    const previous = tails.get(providerId) ?? Promise.resolve();
    const run = new Promise<T>((resolve, reject) => {
      let started = false;
      const rejectWaiting = () => {
        if (started) return;
        started = true;
        signal.removeEventListener("abort", onAbort);
        reject(abortError(signal));
      };
      const onAbort = () => rejectWaiting();
      const start = () => {
        if (started || signal.aborted) {
          rejectWaiting();
          return;
        }
        started = true;
        signal.removeEventListener("abort", onAbort);
        task().then(resolve, reject);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(start, start);
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(providerId, tail);
    void tail.then(() => {
      if (tails.get(providerId) === tail) tails.delete(providerId);
    });
    return run;
  };

  return {
    knownSecrets() {
      return [...secrets];
    },
    async close() {
      while (tails.size > 0) {
        const pending = [...tails.values()];
        await Promise.all(pending);
      }
    },
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return readFileCredential(providerId);
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      const entries = await Promise.all(
        providerIds.map(async (providerId) => {
          const credential = await readFileCredential(providerId);
          return credential === undefined
            ? undefined
            : { providerId, type: credential.type };
        }),
      );
      return entries.filter((entry) => entry !== undefined);
    },
    modify(providerId, fn, options) {
      const signal = options?.signal ?? new AbortController().signal;
      return enqueue(providerId, signal, async () => {
        let next: Credential | undefined;
        await withLock(providerId, async () => {
          const current = await readFileCredential(providerId);
          const result = await fn(current);
          if (result === undefined) {
            next = current;
            return;
          }
          await writePrivate(file(providerId), `${JSON.stringify(result)}\n`);
          remember(result);
          next = result;
        });
        return next;
      });
    },
    delete(providerId, options) {
      const signal = options?.signal ?? new AbortController().signal;
      return enqueue(providerId, signal, async () => {
        await withLock(providerId, async () => {
          await rm(file(providerId), { force: true });
        });
      });
    },
  };
}

function closedAuthContext() {
  return {
    async env(): Promise<string | undefined> {
      return undefined;
    },
    async fileExists(): Promise<boolean> {
      return false;
    },
  };
}

function applySecrets(text: string, secrets: readonly string[]): string {
  let next = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    next = next.split(secret).join("[redacted]");
  }
  return next;
}

export function redactText(text: string, secrets: readonly string[]): string {
  const hidden = applySecrets(text, secrets)
    .replace(/body=[^;\n]*/g, "body=[redacted]")
    .replace(/(token request failed \(\d+\): )[\s\S]*/g, "$1[redacted]");
  return hidden.replace(
    /\{[^{}]*"(?:access_token|refresh_token)"[\s\S]*$/g,
    "[redacted]",
  );
}

function redactError(error: unknown, secrets: readonly string[]): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  if (error instanceof Error && error.cause instanceof Error) {
    parts.push(error.cause.message);
  }
  return redactText(parts.join("\n"), secrets);
}

async function readInstallation(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Installation file ${file} is corrupt and was left unchanged.`,
    );
  }
  const installation = installationSchema.safeParse(parsed);
  if (!installation.success) {
    throw new Error(
      `Installation file ${file} is corrupt and was left unchanged.`,
    );
  }
  return installation.data.id;
}

async function installationId(home: string): Promise<string> {
  const file = join(home, "installation.json");
  await ensureDir(home);
  const existing = await readInstallation(file);
  if (existing !== undefined) return existing;
  const id = randomUUID();
  if (await createPrivate(file, `${JSON.stringify({ id })}\n`)) return id;
  const winner = await readInstallation(file);
  if (winner === undefined) {
    throw new Error(
      `Installation file ${file} is corrupt and was left unchanged.`,
    );
  }
  return winner;
}

function chatGptSettings(
  settings: ModelSettings,
  apiKey: string,
): ModelSettings {
  if (apiKey.startsWith("sk-")) return settings;
  const {
    temperature: _temperature,
    maxTokens: _maxTokens,
    promptCacheRetention: _promptCacheRetention,
    promptCacheOptions: _promptCacheOptions,
    ...rest
  } = settings;
  return { ...rest, store: false };
}

function createOpenAISubscriptionModel(options: {
  models: Models;
  modelId: string;
  redact: (error: unknown) => string;
}): Model {
  const model: Model = {
    async getResponse(request) {
      let response: ModelResponse | undefined;
      for await (const event of model.getStreamedResponse(request)) {
        if (event.type === "response_done") {
          response = {
            usage: new Usage(event.response.usage),
            output: event.response.output,
            responseId: event.response.id,
            ...(event.response.providerData === undefined
              ? {}
              : { providerData: event.response.providerData }),
          };
        }
      }
      if (response === undefined) {
        throw new Error("The model stream ended without a response.");
      }
      return response;
    },
    async *getStreamedResponse(request): AsyncIterable<StreamEvent> {
      const providerRef: { current?: OpenAIProvider } = {};
      try {
        const resolved = await options.models.getAuth("openai", {
          signal: request.signal,
        });
        const apiKey = resolved?.auth.apiKey;
        if (!apiKey) {
          throw new Error(
            "No openai subscription is saved. Run lean --login openai.",
          );
        }
        request.signal?.throwIfAborted();
        const prepared: ModelRequest = {
          ...request,
          modelSettings: chatGptSettings(request.modelSettings, apiKey),
        };
        const provider = new OpenAIProvider({
          apiKey,
          baseURL: chatGptBaseUrl,
          useResponses: true,
          useResponsesWebSocket: false,
        });
        providerRef.current = provider;
        const inner = await provider.getModel(options.modelId);
        yield* inner.getStreamedResponse(prepared);
      } catch (error) {
        throw error instanceof Error && error.message === options.redact(error)
          ? error
          : new Error(options.redact(error));
      } finally {
        await providerRef.current?.close();
      }
    },
  };
  return model;
}

function openAIModelId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (explicit) return explicit;
  if (env.OPENAI_MODEL) return env.OPENAI_MODEL;
  if (env.OPENAI_DEFAULT_MODEL?.trim())
    return env.OPENAI_DEFAULT_MODEL.toLowerCase();
  return getDefaultModel();
}

function catalogModelId(
  provider: ProviderId,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const spec = providerTable[provider];
  const modelId =
    provider === "openai"
      ? openAIModelId(explicit, env)
      : (explicit ?? spec.defaultModel ?? anthropicDefaultModel);
  if (!spec.models().some((model) => model.id === modelId)) {
    throw new Error(`Unknown ${provider} model "${modelId}".`);
  }
  return modelId;
}

function readLine(signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const rl = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolveLine, reject) => {
    let settled = false;
    const finish = (error?: Error, line?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rl.off("line", onLine);
      rl.off("close", onClose);
      rl.close();
      if (error) reject(error);
      else resolveLine(line ?? "");
    };
    const onAbort = () => finish(abortError(signal));
    const onLine = (line: string) => finish(undefined, line);
    const onClose = () => finish(new Error("Sign-in input closed."));
    signal.addEventListener("abort", onAbort, { once: true });
    rl.once("line", onLine);
    rl.once("close", onClose);
  });
}

function choice(
  prompt: Extract<AuthPrompt, { type: "select" }>,
  line: string,
): string {
  const answer = line.trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) {
    const option = prompt.options[index - 1];
    if (option) return option.id;
  }
  const match = prompt.options.find((option) => option.id === answer);
  if (match) return match.id;
  throw new Error(`Unknown login choice "${answer}".`);
}

function notify(event: AuthEvent): void {
  if (event.type === "auth_url") {
    process.stderr.write(`${event.url}\n`);
    if (event.instructions) process.stderr.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "device_code") {
    process.stderr.write(`${event.verificationUri}\n${event.userCode}\n`);
    return;
  }
  process.stderr.write(`${event.message}\n`);
}

function createLoginInteraction(signal: AbortSignal): AuthInteraction {
  return {
    signal,
    notify,
    async prompt(prompt) {
      const promptSignal = prompt.signal
        ? AbortSignal.any([signal, prompt.signal])
        : signal;
      promptSignal.throwIfAborted();
      if (prompt.type === "select") {
        process.stderr.write(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          process.stderr.write(`${index + 1}. ${option.label}\n`);
        });
      } else {
        process.stderr.write(`${prompt.message}\n`);
      }
      const line = await readLine(promptSignal);
      return prompt.type === "select" ? choice(prompt, line) : line.trim();
    },
  };
}

export type Subscriptions = {
  login(provider: ProviderId, signal: AbortSignal): Promise<void>;
  logout(provider: ProviderId): Promise<void>;
  resolveModel(input: {
    provider?: string;
    model?: string;
  }): Promise<string | Model>;
  redact(error: unknown): string;
  close(): Promise<void>;
};

export function createSubscriptions(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Subscriptions {
  const env = options?.env ?? process.env;
  const home = options?.home ?? subscriptionHome(env);
  const store = openCredentialStore(home);
  const models = createModels({
    credentials: store,
    authContext: closedAuthContext(),
  });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  const secrets = () => {
    const key = env.OPENAI_API_KEY?.trim();
    return key ? [key, ...store.knownSecrets()] : store.knownSecrets();
  };
  const redact = (error: unknown) => redactError(error, secrets());
  const subscriptionModel = async (
    provider: ProviderId,
    explicit: string | undefined,
  ): Promise<Model> => {
    const modelId = catalogModelId(provider, explicit, env);
    const saved = await store.read(provider);
    if (saved?.type !== "oauth") {
      throw new Error(
        `No ${provider} subscription is saved. Run lean --login ${provider}.`,
      );
    }
    return provider === "openai"
      ? createOpenAISubscriptionModel({ models, modelId, redact })
      : createAnthropicModel({ models, modelId, redact });
  };
  return {
    redact,
    close: () => store.close(),
    async login(provider, signal) {
      if (!process.stdin.isTTY) {
        throw new Error("Sign-in needs a terminal.");
      }
      signal.throwIfAborted();
      const device = await installationId(home);
      await models.login(provider, "oauth", createLoginInteraction(signal), {
        agentName: "lean",
        getDeviceId: () => device,
      });
    },
    async logout(provider) {
      await models.logout(provider);
    },
    async resolveModel(input) {
      if (input.provider !== undefined) {
        if (!isProviderId(input.provider)) {
          throw new Error(
            `Unknown provider "${input.provider}". Expected openai or anthropic.`,
          );
        }
        return subscriptionModel(input.provider, input.model);
      }
      if (env.OPENAI_API_KEY?.trim()) return openAIModelId(input.model, env);
      const saved = await store.list();
      if (saved.length > 1) {
        throw new Error(
          "Both openai and anthropic are signed in. Pass --provider openai or --provider anthropic.",
        );
      }
      const only = saved[0];
      if (only && isProviderId(only.providerId)) {
        return subscriptionModel(only.providerId, input.model);
      }
      throw new Error("Set OPENAI_API_KEY to run the agent.");
    },
  };
}
