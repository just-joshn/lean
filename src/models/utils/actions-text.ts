import type { Action, Message, Observation } from "../../protocols.ts";
import { FormatError } from "../../exceptions.ts";
import { renderStrict } from "../../utils/render.ts";
import { expandMultimodalContent } from "./multimodal.ts";

export function parseRegexActions(
  content: string,
  options: {
    action_regex: string;
    format_error_template: string;
    template_kwargs?: Record<string, unknown>;
  },
): Action[] {
  const found = [
    ...content.matchAll(new RegExp(options.action_regex, "gs")),
  ].map((match) => (match[1] ?? match[0]).trim());
  if (found.length !== 1) {
    throw new FormatError({
      role: "user",
      content: renderStrict(options.format_error_template, {
        actions: found,
        error: `Expected exactly 1 action, found ${found.length}.`,
        ...(options.template_kwargs ?? {}),
      }),
      extra: {
        interrupt_type: "FormatError",
        n_actions: found.length,
        model_response: content,
      },
    });
  }
  return [{ command: found[0] }];
}

export function formatTextObservationMessages(
  outputs: Observation[],
  options: {
    observation_template: string;
    template_vars?: Record<string, unknown>;
    multimodal_regex?: string;
  },
): Message[] {
  return outputs.map((output) => {
    let message: Message = {
      role: "user",
      content: renderStrict(options.observation_template, {
        output,
        ...(options.template_vars ?? {}),
      }),
      extra: {
        raw_output: output.output ?? "",
        returncode: output.returncode,
        timestamp: Date.now() / 1000,
        exception_info: output.exception_info,
        ...(output.extra ?? {}),
      },
    };
    if (options.multimodal_regex) {
      message = expandMultimodalContent(message, options.multimodal_regex);
    }
    return message;
  });
}
