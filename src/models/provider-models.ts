import type { Action, Message } from "../protocols.ts";
import { FormatError, KeyboardInterrupt, RuntimeError } from "../exceptions.ts";
import { LitellmModel, LitellmModelConfig } from "./litellm-model.ts";
import { ProviderParityGateError } from "./route.ts";
import { attemptResponse } from "./attempt.ts";
import { BASH_TOOL, parseToolcallActions } from "./utils/actions-toolcall.ts";
import { messageFromDump } from "./response-access.ts";
import { retry } from "./utils/retry.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";

class OpenRouterConfig extends LitellmModelConfig {
  override model_dump(): Record<string, unknown> {
    const config = super.model_dump();
    delete config.litellm_model_registry;
    return config;
  }
}

class RequestyConfig extends OpenRouterConfig {
  override model_dump(): Record<string, unknown> {
    const config = super.model_dump();
    delete config.cost_tracking;
    return config;
  }
}

const DEDICATED = {
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: "OPENROUTER_API_KEY",
  },
  requesty: {
    name: "Requesty",
    url: "https://router.requesty.ai/v1/chat/completions",
    key: "REQUESTY_API_KEY",
  },
} as const;

type DictionaryProvider = keyof typeof DEDICATED;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderParityGateError(
      "dedicated model",
      "non-dictionary response shape",
    );
  }
  return value as Record<string, unknown>;
}

class DedicatedAuthenticationError extends Error {}

function providerError(
  provider: DictionaryProvider,
  kind: string,
  message: string,
): Error {
  const error =
    kind === "AuthenticationError"
      ? new DedicatedAuthenticationError(message)
      : new Error(message);
  error.name = `${DEDICATED[provider].name}${kind}`;
  return error;
}

abstract class DictionaryProviderModel extends LitellmModel {
  readonly #provider: DictionaryProvider;
  readonly #apiKey: string;

  constructor(data: Record<string, unknown>, provider: DictionaryProvider) {
    super(
      { ...data, config_class: undefined, litellm_model_registry: null },
      provider === "openrouter" ? OpenRouterConfig : RequestyConfig,
    );
    this.#provider = provider;
    this.#apiKey = process.env[DEDICATED[provider].key] ?? "";
  }

  protected override async request(
    messages: Message[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = this.#provider;
    const config = DEDICATED[provider];
    const body = {
      model: this.config.model_name,
      messages,
      tools: [BASH_TOOL],
      ...(provider === "openrouter" ? { usage: { include: true } } : {}),
      ...this.config.model_kwargs,
      ...kwargs,
    };
    if (Reflect.get(body, "stream"))
      throw new ProviderParityGateError(provider, "streaming");
    let response;
    try {
      response = await attemptResponse(
        config.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            ...(provider === "requesty"
              ? {
                  "HTTP-Referer": "https://github.com/SWE-agent/mini-swe-agent",
                  "X-Title": "mini-swe-agent",
                }
              : {}),
          },
          body: JSON.stringify(body),
        },
        { sdkRetries: 0, wrapperAttempts: 0, timeoutSeconds: 60 },
      );
    } catch (error) {
      throw providerError(
        provider,
        "APIError",
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      if (response.status === 401)
        throw providerError(
          provider,
          "AuthenticationError",
          `Authentication failed. You can permanently set your API key with \`mini-extra config set ${config.key} YOUR_KEY\`.`,
        );
      if (response.status === 429)
        throw providerError(provider, "RateLimitError", "Rate limit exceeded");
      throw providerError(
        provider,
        "APIError",
        `HTTP ${response.status}: ${response.text}`,
      );
    }
    return JSON.parse(response.text);
  }

  protected override costOf(response: unknown): number {
    const provider = this.#provider;
    const responseBody = record(response);
    const usage =
      responseBody.usage === undefined ? {} : record(responseBody.usage);
    const cost = Object.hasOwn(usage, "cost") ? usage.cost : 0;
    if (typeof cost !== "number")
      throw new ProviderParityGateError(provider, "non-numeric API cost");
    if (provider === "requesty" && cost === 0) {
      throw providerError(
        provider,
        "APIError",
        `No cost information available from Requesty API for model ${this.config.model_name}. Cost tracking is required but not provided by the API response.`,
      );
    }
    if (
      provider === "openrouter" &&
      cost <= 0 &&
      this.config.cost_tracking !== "ignore_errors"
    ) {
      if (Object.values(usage).some((value) => typeof value !== "number")) {
        throw new ProviderParityGateError(
          provider,
          "cost-error representation of non-numeric usage fields",
        );
      }
      const usageText = `{${Object.entries(usage)
        .map(([key, value]) => `'${key}': ${String(value)}`)
        .join(", ")}}`;
      throw new RuntimeError(
        `No valid cost information available from OpenRouter API for model ${this.config.model_name}: Usage ${usageText}, cost ${Object.hasOwn(usage, "cost") ? cost : "0.0"}. Cost must be > 0.0. Set cost_tracking: 'ignore_errors' in your config file or export MSWEA_COST_TRACKING='ignore_errors' to ignore cost tracking errors (for example for free/local models), more information at https://klieret.short.gy/mini-local-models for more details. Still stuck? Please open a github issue at https://github.com/SWE-agent/mini-swe-agent/issues/new/choose!`,
      );
    }
    return cost;
  }

  protected override parseActions(response: unknown): Action[] {
    const choices = record(response).choices;
    const choice = record(Array.isArray(choices) ? choices[0] : undefined);
    const calls = record(choice.message).tool_calls;
    if (!Array.isArray(calls))
      throw new ProviderParityGateError(
        this.#provider,
        "non-array tool_calls response shape",
      );
    return parseToolcallActions(calls, {
      format_error_template: this.config.format_error_template,
      template_kwargs: { finish_reason: choice.finish_reason },
    });
  }

  override async query(
    messages: Message[],
    kwargs: Record<string, unknown> = {},
  ): Promise<Message> {
    const prepared = this.prepare(messages);
    const response = await retry({
      abort: [
        DedicatedAuthenticationError,
        KeyboardInterrupt,
        ProviderParityGateError,
      ],
      sleep: this.sleep,
      fn: () => this.request(prepared, kwargs),
    });
    const cost = this.costOf(response);
    GLOBAL_MODEL_STATS.add(cost);
    let actions: Action[];
    try {
      actions = this.parseActions(response);
    } catch (error) {
      if (error instanceof FormatError && error.messages[0]) {
        error.messages[0].extra = {
          ...error.messages[0].extra,
          cost,
          response: { ...record(response) },
        };
      }
      throw error;
    }
    const choices = record(response).choices;
    const choice = record(Array.isArray(choices) ? choices[0] : undefined);
    const message = messageFromDump({ ...record(choice.message) });
    message.extra = { actions, response, cost, timestamp: Date.now() / 1000 };
    return message;
  }
}

export class OpenRouterModel extends DictionaryProviderModel {
  override readonly type_name =
    "minisweagent.models.openrouter_model.OpenRouterModel";
  constructor(data: Record<string, unknown> = {}) {
    super(data, "openrouter");
  }
}

export class RequestyModel extends DictionaryProviderModel {
  override readonly type_name =
    "minisweagent.models.requesty_model.RequestyModel";
  constructor(data: Record<string, unknown> = {}) {
    super(data, "requesty");
  }
}

export class PortkeyModel extends LitellmModel {
  override readonly type_name =
    "minisweagent.models.portkey_model.PortkeyModel";

  constructor(data: Record<string, unknown> = {}) {
    super(data);
    if (!process.env.PORTKEY_API_KEY) {
      const error = new Error(
        "Portkey API key is required. Set it via the PORTKEY_API_KEY environment variable. You can permanently set it with `mini-extra config set PORTKEY_API_KEY YOUR_KEY`.",
      );
      error.name = "ValueError";
      throw error;
    }
  }

  protected override async request(): Promise<never> {
    throw new ProviderParityGateError(
      "portkey",
      "SDK request, response serialization, and cost conversion have not been implemented",
    );
  }
}
