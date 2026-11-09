import type { Action, ExecutionOutput, Message } from "../../protocols.ts";
import { FormatError } from "../../exceptions.ts";
import { renderStrict } from "../../utils/render.ts";
import { expandMultimodalContent } from "./multimodal.ts";

export const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a bash command",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
};

export interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolcallActions(
  toolCalls: ToolCall[],
  options: {
    format_error_template: string;
    template_kwargs?: Record<string, unknown>;
  },
): Action[] {
  const templateKwargs = options.template_kwargs ?? {};
  if (toolCalls.length === 0) {
    throw new FormatError({
      role: "user",
      content: renderStrict(options.format_error_template, {
        error:
          "No tool calls found in the response. Every response MUST include at least one tool call.",
        actions: [],
        has_tool_calls: false,
        ...templateKwargs,
      }),
      extra: { interrupt_type: "FormatError" },
    });
  }
  const actions: Action[] = [];
  for (const toolCall of toolCalls) {
    let error = "";
    let args: unknown = {};
    try {
      const raw = toolCall.function?.arguments;
      if (typeof raw !== "string")
        throw new Error("arguments must be a JSON string");
      args = JSON.parse(raw);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error = `Error parsing tool call arguments: ${message}.`;
    }
    if (toolCall.function?.name !== "bash") {
      error += `Unknown tool '${toolCall.function?.name ?? ""}'.`;
    }
    if (!isRecord(args) || !("command" in args)) {
      error += "Missing 'command' argument in bash tool call.";
    }
    if (error) {
      throw new FormatError({
        role: "user",
        content: renderStrict(options.format_error_template, {
          actions: [],
          error: error.trim(),
          has_tool_calls: true,
          ...templateKwargs,
        }),
        extra: { interrupt_type: "FormatError" },
      });
    }
    const record = args as Record<string, unknown>;
    actions.push({ command: record.command, tool_call_id: toolCall.id });
  }
  return actions;
}

export function formatToolcallObservationMessages(options: {
  actions: Action[];
  outputs: ExecutionOutput[];
  observation_template: string;
  template_vars?: Record<string, unknown>;
  multimodal_regex?: string;
}): Message[] {
  const notExecuted: ExecutionOutput = {
    output: "",
    returncode: -1,
    exception_info: "action was not executed",
  };
  const padded = options.outputs.concat(
    Array.from(
      { length: Math.max(0, options.actions.length - options.outputs.length) },
      () => ({
        ...notExecuted,
      }),
    ),
  );
  const results: Message[] = [];
  for (let index = 0; index < options.actions.length; index += 1) {
    const action = options.actions[index];
    const output = padded[index] ?? notExecuted;
    let message: Message = {
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
    if (action && "tool_call_id" in action) {
      message.tool_call_id = action.tool_call_id;
      message.role = "tool";
    } else {
      message.role = "user";
    }
    if (options.multimodal_regex) {
      message = expandMultimodalContent(message, options.multimodal_regex);
    }
    results.push(message);
  }
  return results;
}
