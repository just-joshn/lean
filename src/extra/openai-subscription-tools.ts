import {
  protocol,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type StreamEvent,
} from "@openai/agents";
import { z } from "zod";

type FunctionTool = Extract<
  ModelRequest["tools"][number],
  { type: "function" }
>;
type NativeNames = { shell?: string; patch?: string };
type Completed = Extract<StreamEvent, { type: "response_done" }>;
type ModelOutput = Completed["response"]["output"][number];

const shellArguments = z.strictObject({ action: protocol.ShellAction });
const patchArguments = z.strictObject({
  operation: protocol.ApplyPatchOperation,
});

function shellParameters(): FunctionTool["parameters"] {
  const { $schema: _schema, ...action } = protocol.ShellAction.toJSONSchema();
  return {
    type: "object",
    properties: { action },
    required: ["action"],
    additionalProperties: false,
  };
}

function patchParameters(): FunctionTool["parameters"] {
  const { $schema: _schema, ...operation } =
    protocol.ApplyPatchOperation.toJSONSchema();
  return {
    type: "object",
    properties: { operation },
    required: ["operation"],
    additionalProperties: false,
  };
}

function nativeNames(tools: ModelRequest["tools"]): NativeNames {
  const names: NativeNames = {};
  for (const tool of tools) {
    if (tool.type !== "shell" && tool.type !== "apply_patch") continue;
    const kind = tool.type === "shell" ? "shell" : "patch";
    if (names[kind] !== undefined) {
      throw new Error(`Only one ${tool.type} tool can be sent to ChatGPT.`);
    }
    names[kind] = tool.name;
  }
  return names;
}

function projectTool(
  tool: ModelRequest["tools"][number],
): ModelRequest["tools"][number] {
  if (tool.type === "shell") {
    return {
      type: "function",
      name: tool.name,
      description: "Run shell commands in the workspace.",
      strict: false,
      parameters: shellParameters(),
      ...(tool.allowedCallers === undefined
        ? {}
        : { allowedCallers: tool.allowedCallers }),
    };
  }
  if (tool.type === "apply_patch") {
    return {
      type: "function",
      name: tool.name,
      description: "Create, update, or delete a workspace file.",
      strict: false,
      parameters: patchParameters(),
      ...(tool.allowedCallers === undefined
        ? {}
        : { allowedCallers: tool.allowedCallers }),
    };
  }
  return tool;
}

function toolName(names: NativeNames, kind: "shell" | "patch"): string {
  const name = kind === "shell" ? names.shell : names.patch;
  if (name === undefined) {
    throw new Error(
      `Cannot send a ${kind === "shell" ? "shell_call" : "apply_patch_call"} without a declared tool.`,
    );
  }
  return name;
}

function carried(item: {
  caller?: protocol.FunctionCallItem["caller"];
  providerData?: protocol.FunctionCallItem["providerData"];
}): {
  caller?: protocol.FunctionCallItem["caller"];
  providerData?: protocol.FunctionCallItem["providerData"];
} {
  return {
    ...(item.caller === undefined ? {} : { caller: item.caller }),
    ...(item.providerData === undefined
      ? {}
      : { providerData: item.providerData }),
  };
}

function projectInput(
  item: AgentInputItem,
  names: NativeNames,
): AgentInputItem {
  switch (item.type) {
    case "shell_call":
      return protocol.FunctionCallItem.parse({
        type: "function_call",
        name: toolName(names, "shell"),
        callId: item.callId,
        arguments: JSON.stringify({ action: item.action }),
        ...(item.status === undefined ? {} : { status: item.status }),
        ...carried(item),
      });
    case "shell_call_output":
      return protocol.FunctionCallResultItem.parse({
        type: "function_call_result",
        name: toolName(names, "shell"),
        callId: item.callId,
        status: item.status ?? "completed",
        output: JSON.stringify({
          output: item.output,
          ...(item.status === undefined ? {} : { status: item.status }),
          ...(item.maxOutputLength === undefined
            ? {}
            : { maxOutputLength: item.maxOutputLength }),
        }),
        ...carried(item),
      });
    case "apply_patch_call":
      return protocol.FunctionCallItem.parse({
        type: "function_call",
        name: toolName(names, "patch"),
        callId: item.callId,
        arguments: JSON.stringify({ operation: item.operation }),
        status: item.status,
        ...carried(item),
      });
    case "apply_patch_call_output":
      return protocol.FunctionCallResultItem.parse({
        type: "function_call_result",
        name: toolName(names, "patch"),
        callId: item.callId,
        status: "completed",
        output: JSON.stringify({
          status: item.status,
          ...(item.output === undefined ? {} : { output: item.output }),
        }),
        ...carried(item),
      });
    default:
      return item;
  }
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function validateCallStatus(
  status: "in_progress" | "completed" | "incomplete" | undefined,
  tool: "shell" | "apply_patch",
): void {
  if (
    status === "incomplete" ||
    status === "in_progress" ||
    (tool === "apply_patch" && status === undefined)
  ) {
    throw new Error(
      `The ${tool} call is ${status ?? "missing a status"} and cannot be approved.`,
    );
  }
}

function restoreOutput(item: ModelOutput, names: NativeNames): ModelOutput {
  if (item.type !== "function_call") return item;
  if (names.shell !== undefined && item.name === names.shell) {
    validateCallStatus(item.status, "shell");
    const parsed = shellArguments.safeParse(readJson(item.arguments));
    if (!parsed.success) {
      throw new Error("Shell arguments do not match the shell tool.");
    }
    return protocol.ShellCallItem.parse({
      type: "shell_call",
      callId: item.callId,
      action: parsed.data.action,
      ...(item.id === undefined ? {} : { id: item.id }),
      ...(item.status === undefined ? {} : { status: item.status }),
      ...carried(item),
    });
  }
  if (names.patch !== undefined && item.name === names.patch) {
    validateCallStatus(item.status, "apply_patch");
    const parsed = patchArguments.safeParse(readJson(item.arguments));
    if (!parsed.success) {
      throw new Error("Patch arguments do not match the apply_patch tool.");
    }
    return protocol.ApplyPatchCallItem.parse({
      type: "apply_patch_call",
      callId: item.callId,
      operation: parsed.data.operation,
      status: item.status,
      ...(item.id === undefined ? {} : { id: item.id }),
      ...carried(item),
    });
  }
  return item;
}

export async function* streamSubscriptionTools(
  inner: Model,
  request: ModelRequest,
): AsyncIterable<StreamEvent> {
  const names = nativeNames(request.tools);
  const projected: ModelRequest = {
    ...request,
    tools: request.tools.map(projectTool),
    input:
      typeof request.input === "string"
        ? request.input
        : request.input.map((item) => projectInput(item, names)),
  };
  for await (const event of inner.getStreamedResponse(projected)) {
    if (event.type !== "response_done") {
      yield event;
      continue;
    }
    yield {
      ...event,
      response: {
        ...event.response,
        output: event.response.output.map((item) => restoreOutput(item, names)),
      },
    };
  }
}
