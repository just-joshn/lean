import { readFileSync, statSync } from "node:fs";
import {
  ConfigModel,
  constructConfig,
  type ConfigFactory,
  type Field,
  stringField,
  dictField,
  pathField,
  literalField,
  type PosixPath,
} from "../config/fields.ts";
import { componentIdentity } from "../utils/load.ts";
import type { Action, Message, Observation } from "../protocols.ts";
import { FormatError, KeyboardInterrupt, RuntimeError } from "../exceptions.ts";
import { expandMultimodalContent } from "./utils/multimodal.ts";
import {
  BASH_TOOL,
  parseToolcallActions,
  formatToolcallObservationMessages,
} from "./utils/actions-toolcall.ts";
import { reorderAnthropicThinkingBlocks } from "./utils/anthropic.ts";
import { setCacheControl } from "./utils/cache-control.ts";
import { completionCost, registerModel } from "./utils/cost.ts";
import { retry } from "./utils/retry.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
  PermissionDeniedError,
  UnsupportedParamsError,
} from "./errors.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import { completeChat, type ChatResponse } from "./transport.ts";

export class LitellmModelConfig extends ConfigModel {
  static override fields: Record<string, Field> = {
    model_name: stringField(),
    model_kwargs: dictField(),
    litellm_model_registry: pathField(
      true,
      process.env.LITELLM_MODEL_REGISTRY_PATH ?? null,
    ),
    set_cache_control: literalField(["default_end"], null, true),
    cost_tracking: literalField(
      ["default", "ignore_errors"],
      process.env.MSWEA_COST_TRACKING ?? "default",
    ),
    format_error_template: stringField("{{ error }}"),
    observation_template: stringField(
      "{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>",
    ),
    multimodal_regex: stringField(""),
  };
  declare model_name: string;
  declare model_kwargs: Record<string, unknown>;
  declare litellm_model_registry: PosixPath | string | null;
  declare set_cache_control: "default_end" | null;
  declare cost_tracking: string;
  declare format_error_template: string;
  declare observation_template: string;
  declare multimodal_regex: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LitellmModel {
  readonly config: LitellmModelConfig;
  static typeName = "minisweagent.models.litellm_model.LitellmModel";
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  constructor(
    data: Record<string, unknown> = {},
    configClass?: ConfigFactory<LitellmModelConfig>,
  ) {
    this.config = constructConfig(
      data,
      configClass,
      LitellmModelConfig,
      "minisweagent.models.litellm_model.LitellmModel",
    );
    const registry = this.config.litellm_model_registry;
    if (
      registry &&
      statSync(String(registry), { throwIfNoEntry: false })?.isFile()
    ) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(String(registry), "utf8"),
        );
        if (isRecord(parsed))
          registerModel(parsed as Record<string, Record<string, unknown>>);
      } catch (error) {
        if (isRecord(error) && error.code !== "ENOENT") throw error;
      }
    }
  }

  protected tools(): unknown[] | undefined {
    return [BASH_TOOL];
  }

  protected parseActions(response: ChatResponse): Action[] {
    const message = response.choices[0]?.message;
    const toolCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : [];
    return parseToolcallActions(toolCalls, {
      format_error_template: this.config.format_error_template,
      template_kwargs: { finish_reason: response.choices[0]?.finish_reason },
    });
  }

  protected prepare(messages: Message[]): Message[] {
    const prepared = messages.map((message) => {
      const copy = { ...message };
      delete copy.extra;
      return copy;
    });
    return setCacheControl(
      reorderAnthropicThinkingBlocks(prepared),
      this.config.set_cache_control,
    );
  }

  private async request(
    messages: Message[],
    kwargs: Record<string, unknown>,
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      return await completeChat({
        model: this.config.model_name,
        messages,
        tools: this.tools(),
        modelKwargs: { ...this.config.model_kwargs, ...kwargs },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new KeyboardInterrupt();
      if (error instanceof AuthenticationError) {
        error.message +=
          " You can permanently set your API key with `mini-extra config set KEY VALUE`.";
      }
      throw error;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  private costOf(response: ChatResponse): number {
    try {
      const cost = completionCost(response, this.config.model_name);
      if (cost <= 0) throw new Error(`Cost must be > 0.0, got ${cost}`);
      return cost;
    } catch (error) {
      if (this.config.cost_tracking === "ignore_errors") return 0;
      const message = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(
        `Error calculating cost for model ${this.config.model_name}: ${message}, perhaps it's not registered? You can ignore this issue from your config file with cost_tracking: 'ignore_errors' or globally with export MSWEA_COST_TRACKING='ignore_errors'. Alternatively check the 'Cost tracking' section in the documentation at https://klieret.short.gy/mini-local-models. Still stuck? Please open a github issue at https://github.com/SWE-agent/mini-swe-agent/issues/new/choose!`,
      );
    }
  }

  async query(
    messages: Message[],
    kwargs: Record<string, unknown> = {},
  ): Promise<Message> {
    const prepared = this.prepare(messages);
    const response = await retry({
      abort: [
        UnsupportedParamsError,
        NotFoundError,
        PermissionDeniedError,
        ContextWindowExceededError,
        AuthenticationError,
        KeyboardInterrupt,
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
      if (error instanceof FormatError) {
        const extra = error.messages[0]?.extra ?? {};
        extra.cost = cost;
        try {
          extra.response = response.model_dump();
        } catch {
          extra.response = String(response);
        }
        if (error.messages[0]) error.messages[0].extra = extra;
      }
      throw error;
    }
    let dumped: Record<string, unknown> = {};
    try {
      dumped = response.model_dump();
    } catch {
      dumped = { response: String(response) };
    }
    const choice = response.choices[0]?.message ?? {};
    const message: Message = { ...choice };
    delete message.model_dump;
    message.extra = {
      actions,
      response: dumped,
      cost,
      timestamp: Date.now() / 1000,
    };
    return message;
  }

  format_message(fields: Message): Message {
    return expandMultimodalContent(fields, this.config.multimodal_regex);
  }

  format_observation_messages(
    message: Message,
    outputs: Observation[],
    template_vars: Record<string, unknown> = {},
  ): Message[] {
    const actions = Array.isArray(message.extra?.actions)
      ? (message.extra.actions as Action[])
      : [];
    return formatToolcallObservationMessages({
      actions,
      outputs,
      observation_template: this.config.observation_template,
      template_vars,
      multimodal_regex: this.config.multimodal_regex,
    });
  }

  get_template_vars(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { ...this.config.model_dump(), ...extra };
  }

  serialize(): Record<string, unknown> {
    return {
      info: {
        config: {
          model: this.config.model_dump("json"),
          model_type: componentIdentity(this),
        },
      },
    };
  }
}
