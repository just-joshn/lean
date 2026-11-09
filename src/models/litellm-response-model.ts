import type { Action, Message, Observation } from "../protocols.ts";
import type { ConfigFactory } from "../config/fields.ts";
import { FormatError, KeyboardInterrupt } from "../exceptions.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import { completeResponses } from "./responses.ts";
import {
  responsesDump,
  responseOutput,
  messageFromDump,
} from "./response-access.ts";
import { LitellmModel, LitellmModelConfig } from "./litellm-model.ts";
import {
  BASH_TOOL_RESPONSE_API,
  finishReasonFromResponsesApi,
  formatToolcallObservationMessagesResponse,
  parseToolcallActionsResponse,
} from "./utils/actions-toolcall-response.ts";
import { retry } from "./utils/retry.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
  PermissionDeniedError,
  UnsupportedParamsError,
} from "./errors.ts";

export class LitellmResponseModelConfig extends LitellmModelConfig {}

function withoutExtra(message: Message): Message {
  const copy = { ...message };
  delete copy.extra;
  return copy;
}

export class LitellmResponseModel extends LitellmModel {
  static override typeName =
    "minisweagent.models.litellm_response_model.LitellmResponseModel";

  constructor(
    data: Record<string, unknown> = {},
    configClass: ConfigFactory<LitellmModelConfig> = LitellmResponseModelConfig,
  ) {
    super(data, configClass);
  }

  protected override prepare(messages: Message[]): Message[] {
    const flattened: Message[] = [];
    for (const message of messages) {
      if (message.object === "response" && Array.isArray(message.output)) {
        for (const item of message.output) {
          if (typeof item === "object" && item !== null) {
            flattened.push(withoutExtra(item as Message));
          }
        }
        continue;
      }
      flattened.push(withoutExtra(message));
    }
    return flattened;
  }

  protected override async request(
    messages: Message[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      return await completeResponses({
        model: this.config.model_name,
        input: messages,
        tools: [BASH_TOOL_RESPONSE_API],
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

  protected override parseActions(response: unknown): Action[] {
    const output = responseOutput(response);
    return parseToolcallActionsResponse(output, {
      format_error_template: this.config.format_error_template,
      template_kwargs: {
        finish_reason: finishReasonFromResponsesApi(response),
      },
    });
  }

  override async query(
    messages: Message[],
    kwargs: Record<string, unknown> = {},
  ): Promise<Message> {
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
      fn: () => this.request(this.prepare(messages), kwargs),
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
          extra.response = responsesDump(response, { mode: "json" });
        } catch {
          extra.response = String(response);
        }
        if (error.messages[0]) error.messages[0].extra = extra;
      }
      throw error;
    }
    const message = messageFromDump(responsesDump(response));
    message.extra = {
      actions,
      cost,
      timestamp: Date.now() / 1000,
    };
    return message;
  }

  override format_observation_messages(
    message: Message,
    outputs: Observation[],
    template_vars: Record<string, unknown> = {},
  ): Message[] {
    const actions = Array.isArray(message.extra?.actions)
      ? (message.extra.actions as Action[])
      : [];
    return formatToolcallObservationMessagesResponse({
      actions,
      outputs,
      observation_template: this.config.observation_template,
      template_vars,
      multimodal_regex: this.config.multimodal_regex,
    });
  }
}
