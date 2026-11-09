import type { Action, Message, Observation } from "../protocols.ts";
import {
  formatTextObservationMessages,
  parseRegexActions,
} from "./utils/actions-text.ts";
import { LitellmModel, LitellmModelConfig } from "./litellm-model.ts";
import type { ChatResponse } from "./transport.ts";

export class LitellmTextbasedModelConfig extends LitellmModelConfig {
  action_regex = "```mswea_bash_command\\s*\\n(.*?)\\n```";
  format_error_template =
    "Please always provide EXACTLY ONE action in triple backticks, found {{actions|length}} actions.";

  constructor(data: Record<string, unknown> = {}) {
    super(data);
    if (typeof data.action_regex === "string")
      this.action_regex = data.action_regex;
    if (typeof data.format_error_template === "string")
      this.format_error_template = data.format_error_template;
  }

  override model_dump(): Record<string, unknown> {
    return { ...super.model_dump(), action_regex: this.action_regex };
  }
}

export class LitellmTextbasedModel extends LitellmModel {
  override readonly type_name =
    "minisweagent.models.litellm_textbased_model.LitellmTextbasedModel";

  constructor(data: Record<string, unknown> = {}) {
    super(data, LitellmTextbasedModelConfig);
  }

  private textConfig(): LitellmTextbasedModelConfig {
    return this.config as LitellmTextbasedModelConfig;
  }

  protected override tools(): undefined {
    return undefined;
  }

  protected override parseActions(response: ChatResponse): Action[] {
    const content = response.choices[0]?.message.content;
    return parseRegexActions(typeof content === "string" ? content : "", {
      action_regex: this.textConfig().action_regex,
      format_error_template: this.config.format_error_template,
      template_kwargs: { finish_reason: response.choices[0]?.finish_reason },
    });
  }

  override format_observation_messages(
    _message: Message,
    outputs: Observation[],
    template_vars: Record<string, unknown> = {},
  ): Message[] {
    return formatTextObservationMessages(outputs, {
      observation_template: this.config.observation_template,
      template_vars,
      multimodal_regex: this.config.multimodal_regex,
    });
  }
}
