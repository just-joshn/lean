import { UnsupportedParamsError } from "./errors.ts";
import { ProviderParityGateError } from "./route.ts";
import { lookupModelInfo } from "./utils/cost.ts";

type Dictionary = Record<string, unknown>;
const combinators = ["allOf", "anyOf", "oneOf"] as const;
const callPrefixes: Record<string, string> = {
  function_call: "fc",
  custom_tool_call: "ctc",
  tool_search_call: "tsc",
};
const readingParts = new Set(["input_text", "input_image", "input_file"]);

function record(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestParams(
  model: string,
  original: Dictionary,
  drop: boolean,
): Dictionary {
  const params = { ...original };
  delete params.tools;
  const tokens = params.max_output_tokens;
  if (
    tokens === true ||
    (typeof tokens === "number" &&
      Number.isInteger(tokens) &&
      tokens > 0 &&
      tokens < 16)
  ) {
    params.max_output_tokens = 16;
  }
  const info = lookupModelInfo(model);
  const reasoning = params.reasoning;
  if (
    record(reasoning) &&
    reasoning.effort != null &&
    info &&
    info.supports_reasoning !== true
  ) {
    if (drop) delete params.reasoning;
    else
      throw new UnsupportedParamsError(
        `${model} doesn't support \`reasoning.effort\` (its model cost map entry lacks \`supports_reasoning\`). To drop unsupported params set \`litellm.drop_params = True\``,
      );
  }
  if (!/gpt-[56]/u.test(model) || model.includes("gpt-5-chat")) return params;
  if (record(params.reasoning) && typeof params.reasoning.effort === "string") {
    const effort = params.reasoning.effort;
    if (info?.[`supports_${effort}_reasoning_effort`] === false) {
      if (!drop)
        throw new UnsupportedParamsError(
          `reasoning.effort=${effort} is not supported for ${model}. To drop unsupported params set \`litellm.drop_params = True\``,
        );
      const remaining = { ...params.reasoning };
      delete remaining.effort;
      if (Object.keys(remaining).length) params.reasoning = remaining;
      else delete params.reasoning;
    }
  }
  const effort = record(params.reasoning) ? params.reasoning.effort : undefined;
  const none =
    info?.supports_none_reasoning_effort === true &&
    (effort ?? info.default_reasoning_effort) === "none";
  const temperature = params.temperature;
  if (
    temperature != null &&
    temperature !== 1 &&
    temperature !== true &&
    !none
  ) {
    if (drop) delete params.temperature;
    else {
      const shown =
        params.temperature === true
          ? "True"
          : params.temperature === false
            ? "False"
            : params.temperature;
      throw new UnsupportedParamsError(
        `${model} doesn't support temperature=${shown} while reasoning is active. Only temperature=1 is supported unless reasoning.effort resolves to 'none', either set explicitly on the request or declared as the model's default_reasoning_effort. To drop unsupported params set \`litellm.drop_params = True\``,
      );
    }
  }
  if (Object.hasOwn(params, "top_p") && !none) {
    if (drop) delete params.top_p;
    else
      throw new UnsupportedParamsError(
        `${model} only supports top_p when reasoning.effort resolves to 'none', either set explicitly on the request or declared as the model's default_reasoning_effort. To drop unsupported params set \`litellm.drop_params = True\``,
      );
  }
  return params;
}

function stripCache(value: unknown, depth = 0): unknown {
  if (!record(value) || depth > 100) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [
        key,
        Array.isArray(entry)
          ? entry.map((item) => stripCache(item, depth + 1))
          : stripCache(entry, depth + 1),
      ]),
  );
}

function breakpoint(part: Dictionary): Dictionary {
  return part.prompt_cache_breakpoint != null
    ? part
    : { ...part, prompt_cache_breakpoint: { mode: "explicit" } };
}

function cacheInput(item: unknown): unknown {
  if (!record(item)) return item;
  const key =
    item.type === "function_call_output"
      ? "output"
      : (item.type ?? "message") === "message" &&
          ["system", "developer", "user"].includes(String(item.role))
        ? "content"
        : undefined;
  if (!key) return item;
  const value = item[key];
  if (typeof value === "string") {
    return item.cache_control == null
      ? item
      : {
          ...item,
          [key]: [breakpoint({ type: "input_text", text: value })],
        };
  }
  if (!Array.isArray(value) || !value.every(record)) return item;
  const parts = value.map((part) =>
    readingParts.has(String(part.type)) && part.cache_control != null
      ? breakpoint(part)
      : part,
  );
  if (item.cache_control != null) {
    const last = parts.findLastIndex((part) =>
      readingParts.has(String(part.type)),
    );
    const part = parts[last];
    if (part) parts[last] = breakpoint(part);
  }
  return { ...item, [key]: parts };
}

function readsBreakpoints(
  model: string,
  apiBase: string | undefined,
  params: Dictionary,
): boolean {
  const flag = lookupModelInfo(model)?.supports_prompt_cache_breakpoint;
  const version = /^gpt-(\d+)(?:\.(\d+))?/iu.exec(model);
  const supported =
    flag != null
      ? flag === true
      : version != null &&
        (Number(version[1]) > 5 ||
          (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6));
  if (!supported) return false;
  if (params.prompt_cache_options != null || !apiBase) return true;
  const host = openaiHostname(apiBase);
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}

function openaiHostname(apiBase: string): string {
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(apiBase) && !apiBase.startsWith("//"))
    return "";
  try {
    return new URL(apiBase.startsWith("//") ? `https:${apiBase}` : apiBase)
      .hostname;
  } catch {
    return "";
  }
}

function toolCallId(item: unknown): unknown {
  if (
    !record(item) ||
    typeof item.type !== "string" ||
    typeof item.id !== "string"
  )
    return item;
  const prefix = Object.hasOwn(callPrefixes, item.type)
    ? callPrefixes[item.type]
    : undefined;
  if (!prefix || item.id.startsWith(prefix)) return item;
  const result = { ...item };
  delete result.id;
  return result;
}

function properties(schema: Dictionary): Dictionary {
  return record(schema.properties) ? schema.properties : {};
}
function requiredNames(schema: Dictionary): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}
function objectSchema(schema: Dictionary): boolean {
  return (
    schema.type === "object" ||
    (!Object.hasOwn(schema, "type") && Object.hasOwn(schema, "properties"))
  );
}
function flattenSchema(schema: Dictionary): Dictionary {
  const groups = combinators.flatMap((key) => {
    const value = schema[key];
    return Array.isArray(value) ? [{ key, branches: value }] : [];
  });
  if (!groups.length) return schema;
  const branches: Dictionary[] = [];
  const required = new Set(requiredNames(schema));
  for (const group of groups) {
    if (!group.branches.every(record)) return schema;
    if (
      group.branches.some(
        (branch) =>
          Object.hasOwn(branch, "$ref") ||
          combinators.some((key) => Object.hasOwn(branch, key)),
      )
    ) {
      throw new ProviderParityGateError(
        "openai",
        "Responses recursive and reference schema combinators",
      );
    }
    branches.push(...group.branches);
    const names = group.branches.map(requiredNames);
    const merged =
      group.key === "allOf"
        ? names.flat()
        : (names[0] ?? []).filter((name) =>
            names.every((list) => list.includes(name)),
          );
    for (const name of merged) required.add(name);
  }
  if (
    !objectSchema(schema) &&
    !(
      schema.type === undefined &&
      branches.length &&
      branches.every(objectSchema)
    )
  )
    return schema;
  const result = { ...schema };
  for (const { key } of groups) delete result[key];
  return {
    ...result,
    type: "object",
    properties: Object.assign(
      {},
      ...branches.toReversed().map(properties),
      properties(schema),
    ),
    ...(required.size ? { required: [...required].sort() } : {}),
  };
}

function schemaTools(tools: unknown[], flatten: boolean): unknown[] {
  return tools.map((tool) => {
    if (!record(tool)) return tool;
    return {
      ...tool,
      ...(flatten && record(tool.parameters)
        ? { parameters: flattenSchema(tool.parameters) }
        : {}),
      ...(Array.isArray(tool.tools)
        ? { tools: schemaTools(tool.tools, flatten) }
        : {}),
    };
  });
}

export function responsesRequest(options: {
  model: string;
  input: unknown[];
  tools?: unknown[];
  params: Dictionary;
  dropParams: boolean;
  apiBase?: string;
}): Dictionary {
  const { model, input, tools } = options;
  const params = requestParams(model, options.params, options.dropParams);
  const marked = readsBreakpoints(model, options.apiBase, params)
    ? input.map(cacheInput)
    : input;
  const flatten = /^(?:gpt-4|gpt-3\.5|chatgpt-4o|o1|o3|o4)/u.test(model);
  return {
    model,
    input: marked.map((item) => toolCallId(stripCache(item))),
    ...(tools
      ? {
          tools: schemaTools(
            tools.map((tool) => stripCache(tool)),
            flatten,
          ),
        }
      : {}),
    ...params,
  };
}
