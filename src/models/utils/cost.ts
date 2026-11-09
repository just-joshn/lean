import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dictionaryOrAttribute } from "../response-access.ts";

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

function pythonNumericString(value: string): string | number {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (/[eE.]/.test(trimmed)) {
    if (!pythonFloat(trimmed)) return value;
    return Number(trimmed.replaceAll("_", ""));
  }
  if (!/^[+-]?\d(?:_?\d)*$/.test(trimmed)) return value;
  return Number(trimmed.replaceAll("_", ""));
}

function pythonFloat(trimmed: string): boolean {
  return /^(?:[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?|\.(?:\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?))$/.test(
    trimmed,
  );
}

function updateDictionary(existing: ModelInfo, incoming: ModelInfo): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    if (typeof value === "string") {
      existing[key] = pythonNumericString(value);
      continue;
    }
    if (isRecord(value)) {
      const current = existing[key];
      existing[key] = isRecord(current)
        ? { ...current, ...value }
        : { ...value };
      continue;
    }
    existing[key] = value;
  }
}

function registrationKey(
  key: string,
  catalog: Record<string, ModelInfo>,
): string {
  if (catalog[key]) return key;
  const slash = key.indexOf("/");
  if (slash < 0) return key;
  const rest = key.slice(slash + 1);
  return catalog[rest] ? rest : key;
}

export function registerModel(models: Record<string, ModelInfo>): void {
  const catalog = loadBuiltin();
  for (const [key, value] of Object.entries(models)) {
    const target = registrationKey(key, catalog);
    const next: ModelInfo = {
      ...(registered[target] ?? catalog[target] ?? {}),
    };
    updateDictionary(next, value);
    registered[target] = next;
  }
}

export function lookupModelInfo(model: string): ModelInfo | undefined {
  const catalog = loadBuiltin();
  if (model in registered) return registered[model];
  if (model in catalog) return catalog[model];
  const slash = model.indexOf("/");
  if (slash < 0) return undefined;
  const stripped = model.slice(slash + 1);
  if (stripped in registered) return registered[stripped];
  return catalog[stripped];
}

interface UsageParts {
  prompt: number;
  completion: number;
  cached: number;
  created: number;
}

function usageParts(response: unknown): UsageParts {
  const usage = dictionaryOrAttribute(response, "usage");
  if (!isRecord(usage)) {
    return { prompt: 0, completion: 0, cached: 0, created: 0 };
  }
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
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
    const read =
      number(usage.cache_read_input_tokens) || number(details.cached_tokens);
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

const RATE_PREFIXES = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
];
const NON_STANDARD_SUFFIXES = [
  "_flex",
  "_priority",
  "_balanced",
  "_ultrafast",
  "_batches",
];

function price(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return undefined;
}

function unit(
  info: ModelInfo,
  key: string,
  fallback?: number,
): number | undefined {
  const value = price(info[key]);
  if (value !== undefined) return value;
  return fallback;
}

function thresholdOf(key: string): number {
  const raw = key.split("_above_")[1]?.split("_tokens")[0] ?? "";
  const kilo = raw.includes("k");
  return Number(raw.replace("k", "")) * (kilo ? 1000 : 1);
}

function thresholdKeys(info: ModelInfo): string[] {
  return Object.keys(info)
    .filter((key) => {
      if (!key.includes("_tokens")) return false;
      if (!RATE_PREFIXES.some((prefix) => key.startsWith(`${prefix}_above_`))) {
        return false;
      }
      return !NON_STANDARD_SUFFIXES.some((suffix) => key.endsWith(suffix));
    })
    .sort((left, right) => thresholdOf(left) - thresholdOf(right));
}

function tierRate(tier: ModelInfo, key: string, fallbackKey?: string): number {
  const primary = price(tier[key]);
  if (primary !== undefined && tier[key] != null) return primary;
  if (fallbackKey) {
    const fallback = price(tier[fallbackKey]);
    if (fallback !== undefined && tier[fallbackKey] != null) return fallback;
  }
  return 0;
}

function tierBounds(tier: ModelInfo): [number, number] | undefined {
  const range = tier.range;
  if (!Array.isArray(range) || range.length !== 2) return undefined;
  return [Number(range[0]), Number(range[1])];
}

function selectTier(
  info: ModelInfo,
  promptTokens: number,
): ModelInfo | undefined {
  const table = info.tiered_pricing;
  if (!Array.isArray(table) || promptTokens <= 0) return undefined;
  const valid = table.filter((tier): tier is ModelInfo => {
    if (!isRecord(tier) || !tierBounds(tier)) return false;
    return tier.input_cost_per_token != null;
  });
  valid.sort((left, right) => {
    const leftStart = tierBounds(left)?.[0] ?? 0;
    const rightStart = tierBounds(right)?.[0] ?? 0;
    return leftStart - rightStart;
  });
  if (valid.length === 0) return undefined;
  return (
    valid.find((tier) => {
      const bounds = tierBounds(tier);
      if (!bounds) return false;
      return bounds[0] < promptTokens && promptTokens <= bounds[1];
    }) ?? valid[valid.length - 1]
  );
}

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function rates(info: ModelInfo, promptTokens: number): Rates | undefined {
  const tier = selectTier(info, promptTokens);
  if (tier) {
    const input = tierRate(tier, "input_cost_per_token");
    const output =
      "output_cost_per_token" in tier && tier.output_cost_per_token != null
        ? tierRate(tier, "output_cost_per_token")
        : (unit(info, "output_cost_per_token") ?? 0);
    return {
      input,
      output,
      cacheCreate: tierRate(
        tier,
        "cache_creation_input_token_cost",
        "input_cost_per_token",
      ),
      cacheRead: tierRate(
        tier,
        "cache_read_input_token_cost",
        "input_cost_per_token",
      ),
    };
  }
  if (
    info.input_cost_per_token == null &&
    info.output_cost_per_token == null &&
    info.tiered_pricing == null
  ) {
    return undefined;
  }
  let input = unit(info, "input_cost_per_token") ?? 0;
  let output = unit(info, "output_cost_per_token") ?? 0;
  let cacheCreate = unit(info, "cache_creation_input_token_cost");
  let cacheRead = unit(info, "cache_read_input_token_cost");
  const inclusive = info.litellm_provider === "xai";
  for (const key of thresholdKeys(info)) {
    const threshold = thresholdOf(key);
    const crossed = inclusive
      ? promptTokens >= threshold
      : promptTokens > threshold;
    if (!crossed) continue;
    const label = key.split("_above_")[1]?.split("_tokens")[0];
    if (!label) continue;
    input =
      unit(info, `input_cost_per_token_above_${label}_tokens`, input) ?? input;
    output =
      unit(info, `output_cost_per_token_above_${label}_tokens`, output) ??
      output;
    cacheCreate = unit(
      info,
      `cache_creation_input_token_cost_above_${label}_tokens`,
      cacheCreate,
    );
    cacheRead = unit(
      info,
      `cache_read_input_token_cost_above_${label}_tokens`,
      cacheRead,
    );
  }
  return {
    input,
    output,
    cacheCreate: cacheCreate ?? input,
    cacheRead: cacheRead ?? input,
  };
}

export function completionCost(response: unknown, model: string): number {
  const info = lookupModelInfo(model);
  if (!isRecord(dictionaryOrAttribute(response, "usage"))) return 0;
  const parts = usageParts(response);
  const priced = info ? rates(info, parts.prompt) : undefined;
  if (!priced) throw new Error(`Model ${model} is not in the cost map.`);
  const regular = Math.max(parts.prompt - parts.cached - parts.created, 0);
  return (
    regular * priced.input +
    parts.cached * priced.cacheRead +
    parts.created * priced.cacheCreate +
    parts.completion * priced.output
  );
}
