import type {
  Action,
  ExecutionOutput,
  Message,
  Observation,
} from "../../protocols.ts";
import { FormatError } from "../../exceptions.ts";
import { renderStrict } from "../../utils/render.ts";
import { dictionaryOrAttribute as read } from "../response-access.ts";
import { responseArguments } from "./response-json.ts";

export const BASH_TOOL_RESPONSE_API = {
  type: "function",
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finishReasonFromResponsesApi(response: unknown): string | null {
  const status = read(response, "status");
  if (status !== "incomplete") {
    return typeof status === "string"
      ? status
      : status == null
        ? null
        : String(status);
  }
  const details = read(response, "incomplete_details");
  return read(details, "reason") === "max_output_tokens"
    ? "length"
    : typeof status === "string"
      ? status
      : null;
}

function formatError(text: string): Message {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    extra: { interrupt_type: "FormatError" },
  };
}

export function parseToolcallActionsResponse(
  output: Iterable<unknown>,
  options: {
    format_error_template: string;
    template_kwargs?: Record<string, unknown>;
  },
): Action[] {
  const templateKwargs = options.template_kwargs ?? {};
  const toolCalls = Array.from(output).filter(
    (item) => read(item, "type") === "function_call",
  );
  if (toolCalls.length === 0) {
    throw new FormatError(
      formatError(
        renderStrict(options.format_error_template, {
          error:
            "No tool calls found in the response. Every response MUST include at least one tool call.",
          actions: [],
          has_tool_calls: false,
          ...templateKwargs,
        }),
      ),
    );
  }
  const actions: Action[] = [];
  for (const toolCall of toolCalls) {
    let error = "";
    let args: unknown = {};
    try {
      const raw = read(toolCall, "arguments");
      args = responseArguments(raw === undefined ? "{}" : raw);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error = `Error parsing tool call arguments: ${message}.`;
    }
    const name = read(toolCall, "name");
    if (name !== "bash") error += `Unknown tool '${String(name ?? "")}'.`;
    if (!isRecord(args) || !("command" in args)) {
      error += "Missing 'command' argument in bash tool call.";
    }
    if (error) {
      throw new FormatError(
        formatError(
          renderStrict(options.format_error_template, {
            actions: [],
            error: error.trim(),
            has_tool_calls: true,
            ...templateKwargs,
          }),
        ),
      );
    }
    const record = args as Record<string, unknown>;
    const callId = read(toolCall, "call_id") ?? read(toolCall, "id");
    actions.push({
      command: record.command,
      tool_call_id: typeof callId === "string" ? callId : undefined,
    });
  }
  return actions;
}

export function formatToolcallObservationMessagesResponse(options: {
  actions: Action[];
  outputs: Observation[];
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
      () => ({ ...notExecuted }),
    ),
  );
  const results: Message[] = [];
  for (let index = 0; index < options.actions.length; index += 1) {
    const action = options.actions[index];
    const output = padded[index] ?? notExecuted;
    const content = renderStrict(options.observation_template, {
      output,
      ...(options.template_vars ?? {}),
    });
    const message: Message = {
      extra: {
        raw_output: output.output ?? "",
        returncode: output.returncode,
        timestamp: Date.now() / 1000,
        exception_info: output.exception_info,
        ...(output.extra ?? {}),
      },
    };
    if (action && "tool_call_id" in action) {
      message.type = "function_call_output";
      message.call_id = action.tool_call_id;
      message.output = content;
    } else {
      message.type = "message";
      message.role = "user";
      message.content = [{ type: "input_text", text: content }];
    }
    results.push(message);
  }
  return results;
}
