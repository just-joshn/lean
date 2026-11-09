import type { Action, Message, Observation } from "../protocols.ts";
import {
  formatTextObservationMessages,
  parseRegexActions,
} from "./utils/actions-text.ts";
import { LitellmModel, LitellmModelConfig } from "./litellm-model.ts";
import {
  chatChoice,
  chatMessage,
  dictionaryOrAttribute,
} from "./response-access.ts";

import { stringField, type Field } from "../config/fields.ts";

export class LitellmTextbasedModelConfig extends LitellmModelConfig {
  static override fields: Record<string, Field> = {
    action_regex: stringField("```mswea_bash_command\\s*\\n(.*?)\\n```"),
    format_error_template: stringField(
      "Please always provide EXACTLY ONE action in triple backticks, found {{actions|length}} actions.",
    ),
  };
  declare action_regex: string;
}

export class LitellmTextbasedModel extends LitellmModel {
  static override typeName =
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

  protected override parseActions(response: unknown): Action[] {
    const content = dictionaryOrAttribute(chatMessage(response), "content");
    return parseRegexActions(typeof content === "string" ? content : "", {
      action_regex: this.textConfig().action_regex,
      format_error_template: this.config.format_error_template,
      template_kwargs: {
        finish_reason: dictionaryOrAttribute(
          chatChoice(response),
          "finish_reason",
        ),
      },
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
