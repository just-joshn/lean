import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dictionaryOrAttribute } from "../response-access.ts";
import { ProviderParityGateError } from "../route.ts";
import { anthropicUsage } from "./usage.ts";

type ModelInfo = Record<string, unknown>;

let builtin: Record<string, ModelInfo> | null = null;
const registered: Record<string, ModelInfo> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  if (value == null) return 0;
  const parsed =
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
    throw new ProviderParityGateError("billing", "invalid token count");
  }
  return parsed;
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
  inputText: number;
  cached: number;
  created: number;
  createdFiveMinutes: number | undefined;
  createdOneHour: number;
  reasoning: number;
  outputText: number;
}

function usageParts(response: unknown): UsageParts {
  const raw = dictionaryOrAttribute(response, "usage");
  const usage = isRecord(raw) ? raw : {};
  if (
    usage.prompt_tokens == null &&
    usage.input_tokens != null &&
    ("cache_read_input_tokens" in usage ||
      "cache_creation_input_tokens" in usage)
  ) {
    return usageParts({ usage: anthropicUsage(usage) });
  }
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
  let cached = number(details.cached_tokens);
  let created =
    number(details.cache_write_tokens) || number(details.cache_creation_tokens);
  if (!cached && usage.cache_read_input_tokens != null)
    cached = number(usage.cache_read_input_tokens);
  if (!created && usage.cache_creation_input_tokens != null) {
    created = number(usage.cache_creation_input_tokens);
  }
  const outputDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isRecord(usage.output_tokens_details)
      ? usage.output_tokens_details
      : {};
  for (const detail of [details, outputDetails]) {
    if (
      ["audio_tokens", "image_tokens", "video_tokens"].some(
        (key) => number(detail[key]) > 0,
      )
    ) {
      throw new ProviderParityGateError(
        "billing",
        "audio, image, and video token schedules",
      );
    }
  }
  if (
    usage.cost != null ||
    usage.server_tool_use != null ||
    usage.inference_geo != null ||
    usage.speed != null
  ) {
    throw new ProviderParityGateError(
      "billing",
      "provider-stated cost, tool charges, geo, and speed schedules",
    );
  }
  if (outputDetails.reasoning_tokens === null) {
    throw new ProviderParityGateError(
      "billing",
      "unreported thinking token count",
    );
  }
  const completion = number(usage.completion_tokens ?? usage.output_tokens);
  const reasoning = number(outputDetails.reasoning_tokens);
  let text = number(outputDetails.text_tokens);
  text -= Math.min(reasoning, text, Math.max(text + reasoning - completion, 0));
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
  const cachedDetails = isRecord(details.cached_tokens_details)
    ? details.cached_tokens_details
    : {};
  if (
    number(cachedDetails.audio_tokens) > 0 ||
    number(cachedDetails.image_tokens) > 0
  ) {
    throw new ProviderParityGateError(
      "billing",
      "cached audio and image schedules",
    );
  }
  let inputText = Math.max(
    number(details.text_tokens) -
      Math.min(number(cachedDetails.text_tokens), cached),
    0,
  );
  if (
    !inputText ||
    ((cached > 0 || created > 0) && inputText + cached + created > prompt)
  ) {
    inputText = Math.max(prompt - cached - created, 0);
  }
  const creation = isRecord(details.cache_creation_token_details)
    ? details.cache_creation_token_details
    : undefined;
  return {
    prompt,
    inputText,
    cached,
    created,
    createdFiveMinutes: creation
      ? number(creation.ephemeral_5m_input_tokens)
      : undefined,
    createdOneHour: creation ? number(creation.ephemeral_1h_input_tokens) : 0,
    reasoning,
    outputText: text || Math.max(completion - reasoning, 0),
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
  if (info[key] == null) {
    const suffix = NON_STANDARD_SUFFIXES.find((suffix) => key.includes(suffix));
    if (suffix) return price(info[key.replace(suffix, "")]) ?? fallback;
  }
  return fallback;
}

function thresholdOf(key: string): number {
  const raw = key.split("_above_").at(-1)?.split("_tokens")[0] ?? "";
  const kilo = raw.includes("k");
  return Number(raw.replace("k", "")) * (kilo ? 1000 : 1);
}

function thresholdKeys(info: ModelInfo, suffix: string): string[] {
  return Object.keys(info)
    .filter((key) => {
      if (!key.includes("_tokens")) return false;
      if (!RATE_PREFIXES.some((prefix) => key.startsWith(`${prefix}_above_`))) {
        return false;
      }
      return (
        !NON_STANDARD_SUFFIXES.some((ending) => key.endsWith(ending)) ||
        (suffix !== "" && key.endsWith(suffix))
      );
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
  const ranged = table.filter((tier): tier is ModelInfo => {
    return isRecord(tier) && tierBounds(tier) != null;
  });
  ranged.sort((left, right) => {
    const leftStart = tierBounds(left)?.[0] ?? 0;
    const rightStart = tierBounds(right)?.[0] ?? 0;
    return leftStart - rightStart;
  });
  const matched =
    ranged.find((tier) => {
      const bounds = tierBounds(tier);
      if (!bounds) return false;
      return bounds[0] < promptTokens && promptTokens <= bounds[1];
    }) ?? ranged[ranged.length - 1];
  if (!matched || matched.input_cost_per_token == null) return undefined;
  return matched;
}

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreateOneHour: number;
  reasoning: number;
}

function rates(
  info: ModelInfo,
  promptTokens: number,
  serviceTier: unknown,
): Rates | undefined {
  const tierName =
    typeof serviceTier === "string" ? serviceTier.toLowerCase() : "";
  const tierSuffixes: Record<string, string> = {
    flex: "flex",
    balanced: "balanced",
    priority: "priority",
    fast: "priority",
    ultrafast: "ultrafast",
  };
  const suffix = Object.hasOwn(tierSuffixes, tierName)
    ? `_${tierSuffixes[tierName]}`
    : "";
  const rate = (key: string, fallback?: number) =>
    unit(info, `${key}${suffix}`, fallback);
  const tier = selectTier(info, promptTokens);
  if (tier) {
    const input = tierRate(tier, "input_cost_per_token");
    const output =
      "output_cost_per_token" in tier
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
      cacheCreateOneHour:
        tier.cache_creation_input_token_cost_above_1hr != null
          ? tierRate(tier, "cache_creation_input_token_cost_above_1hr")
          : tierRate(
              tier,
              "cache_creation_input_token_cost",
              "input_cost_per_token",
            ),
      reasoning:
        "output_cost_per_reasoning_token" in tier
          ? tierRate(tier, "output_cost_per_reasoning_token")
          : (unit(info, "output_cost_per_reasoning_token", output) ?? output),
    };
  }
  if (
    info.input_cost_per_token == null &&
    info.output_cost_per_token == null &&
    info.tiered_pricing == null
  ) {
    return undefined;
  }
  let input = rate("input_cost_per_token") ?? 0;
  let output = rate("output_cost_per_token") ?? 0;
  let cacheCreate = rate("cache_creation_input_token_cost");
  let cacheCreateOneHour = unit(
    info,
    "cache_creation_input_token_cost_above_1hr",
  );
  let cacheRead = rate("cache_read_input_token_cost");
  const reasoning = rate("output_cost_per_reasoning_token");
  const inclusive = info.litellm_provider === "xai";
  for (const key of thresholdKeys(info, suffix)) {
    const threshold = thresholdOf(key);
    const crossed = inclusive
      ? promptTokens >= threshold
      : promptTokens > threshold;
    if (!crossed) continue;
    const label = key.split("_above_").at(-1)?.split("_tokens")[0];
    if (!label) continue;
    input = rate(`input_cost_per_token_above_${label}_tokens`, input) ?? input;
    output =
      rate(`output_cost_per_token_above_${label}_tokens`, output) ?? output;
    cacheCreate = rate(
      `cache_creation_input_token_cost_above_${label}_tokens`,
      cacheCreate,
    );
    cacheCreateOneHour = rate(
      `cache_creation_input_token_cost_above_1hr_above_${label}_tokens`,
      cacheCreateOneHour,
    );
    cacheRead = rate(
      `cache_read_input_token_cost_above_${label}_tokens`,
      cacheRead,
    );
  }
  return {
    input,
    output,
    cacheCreate: cacheCreate ?? input,
    cacheRead: cacheRead ?? input,
    cacheCreateOneHour: cacheCreateOneHour ?? cacheCreate ?? input,
    reasoning: reasoning ?? output,
  };
}

export function completionCost(response: unknown, model: string): number {
  const responseModel = dictionaryOrAttribute(response, "model");
  const info =
    (typeof responseModel === "string"
      ? lookupModelInfo(responseModel)
      : undefined) ?? lookupModelInfo(model);
  if (!info) throw new Error(`Model ${model} is not in the cost map.`);
  const usage = dictionaryOrAttribute(response, "usage");
  if (usage == null) return 0;
  if (!isRecord(usage))
    throw new ProviderParityGateError("billing", "unknown usage shape");
  const provider = info.litellm_provider;
  if (
    typeof provider === "string" &&
    ![
      "openai",
      "anthropic",
      "bedrock",
      "bedrock_converse",
      "xai",
      "dashscope",
    ].includes(provider)
  ) {
    throw new ProviderParityGateError(
      provider,
      "provider-specific billing schedule",
    );
  }
  const parts = usageParts(response);
  if (info.off_peak_pricing != null)
    throw new ProviderParityGateError("billing", "off-peak price windows");
  const servedTier = dictionaryOrAttribute(response, "service_tier");
  const tier =
    typeof servedTier === "string"
      ? servedTier
      : dictionaryOrAttribute(usage, "service_tier");
  const priced = rates(info, parts.prompt, tier);
  if (!priced) throw new Error(`Model ${model} is not in the cost map.`);
  const regular =
    info.litellm_provider === "dashscope"
      ? Math.max(parts.prompt - parts.cached - parts.created, 0)
      : parts.inputText;
  const creation =
    parts.createdFiveMinutes === undefined
      ? parts.created * priced.cacheCreate
      : parts.createdFiveMinutes * priced.cacheCreate +
        parts.createdOneHour * priced.cacheCreateOneHour;
  const promptCost =
    regular * priced.input + parts.cached * priced.cacheRead + creation;
  const usageRecord = isRecord(usage) ? usage : {};
  const completion = number(
    usageRecord.completion_tokens ?? usageRecord.output_tokens,
  );
  const total = number(usageRecord.total_tokens);
  const outputCost =
    info.litellm_provider === "dashscope"
      ? Math.max(completion - parts.reasoning, 0) * priced.output +
        parts.reasoning * priced.reasoning
      : info.litellm_provider === "xai"
        ? (total !== parts.prompt + completion
            ? completion + parts.reasoning
            : completion) * priced.output
        : parts.outputText * priced.output + parts.reasoning * priced.reasoning;
  return promptCost + outputCost;
}
