import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ModelInfo = Record<string, unknown>;

let builtin: Record<string, ModelInfo> | null = null;
const registered: Record<string, ModelInfo> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function loadBuiltin(): Record<string, ModelInfo> {
  if (builtin) return builtin;
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../data/litellm-model-prices.json",
  );
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  builtin = isRecord(parsed) ? (parsed as Record<string, ModelInfo>) : {};
  return builtin;
}

export function registerModel(models: Record<string, ModelInfo>): void {
  Object.assign(registered, models);
}

export function lookupModelInfo(model: string): ModelInfo | undefined {
  const catalog = loadBuiltin();
  if (registered[model]) return registered[model];
  if (catalog[model]) return catalog[model];
  const slash = model.indexOf("/");
  if (slash >= 0) {
    const rest = model.slice(slash + 1);
    if (registered[rest]) return registered[rest];
    if (catalog[rest]) return catalog[rest];
  }
  return undefined;
}

interface UsageParts {
  prompt: number;
  completion: number;
  cached: number;
  created: number;
}

function usageParts(response: unknown): UsageParts {
  if (!isRecord(response) || !isRecord(response.usage)) {
    return { prompt: 0, completion: 0, cached: 0, created: 0 };
  }
  const usage = response.usage;
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  let cached = number(details.cached_tokens);
  let created =
    number(details.cache_creation_tokens) || number(details.cache_write_tokens);
  if (!cached && usage.cache_read_input_tokens != null)
    cached = number(usage.cache_read_input_tokens);
  if (!created && usage.cache_creation_input_tokens != null) {
    created = number(usage.cache_creation_input_tokens);
  }
  if (usage.prompt_tokens == null && usage.input_tokens != null) {
    const read = number(usage.cache_read_input_tokens);
    const write = number(usage.cache_creation_input_tokens);
    return {
      prompt: number(usage.input_tokens) + read + write,
      completion: number(usage.output_tokens ?? usage.completion_tokens),
      cached: read,
      created: write,
    };
  }
  return {
    prompt: number(usage.prompt_tokens),
    completion: number(usage.completion_tokens),
    cached,
    created,
  };
}

export function completionCost(response: unknown, model: string): number {
  const info = lookupModelInfo(model);
  if (
    !info ||
    (info.input_cost_per_token == null && info.output_cost_per_token == null)
  ) {
    throw new Error(`Model ${model} is not in the cost map.`);
  }
  const parts = usageParts(response);
  if (!isRecord(response) || !isRecord(response.usage)) return 0;
  const input = number(info.input_cost_per_token);
  const output = number(info.output_cost_per_token);
  const cacheRead =
    info.cache_read_input_token_cost == null
      ? input
      : number(info.cache_read_input_token_cost);
  const cacheCreate =
    info.cache_creation_input_token_cost == null
      ? input
      : number(info.cache_creation_input_token_cost);
  const regular = Math.max(parts.prompt - parts.cached - parts.created, 0);
  return (
    regular * input +
    parts.cached * cacheRead +
    parts.created * cacheCreate +
    parts.completion * output
  );
}
