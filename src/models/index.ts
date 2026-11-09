import { LitellmModel } from "./litellm-model.ts";
import { LitellmTextbasedModel } from "./litellm-textbased-model.ts";
import type { Model } from "../protocols.ts";

const MODELS: Record<string, new (data: Record<string, unknown>) => Model> = {
  litellm: LitellmModel,
  litellm_textbased: LitellmTextbasedModel,
};

export function getModelName(
  input: string | null | undefined,
  config: Record<string, unknown> = {},
): string {
  if (input) return input;
  if (typeof config.model_name === "string" && config.model_name)
    return config.model_name;
  if (process.env.MSWEA_MODEL_NAME) return process.env.MSWEA_MODEL_NAME;
  throw new Error(
    "No default model set. Please run `mini-extra config setup` to set one.",
  );
}

export function getModelClass(
  _modelName: string,
  modelClass = "",
): new (data: Record<string, unknown>) => Model {
  if (modelClass) {
    const mapped = MODELS[modelClass];
    if (!mapped) {
      throw new Error(
        `Unknown model class: ${modelClass} (available: ${Object.keys(MODELS).join(", ")})`,
      );
    }
    return mapped;
  }
  return LitellmModel;
}

export function getModel(
  inputModelName?: string | null,
  config: Record<string, unknown> = {},
): Model {
  const resolved = getModelName(inputModelName, config);
  const copy: Record<string, unknown> = { ...config, model_name: resolved };
  const modelClass =
    typeof copy.model_class === "string" ? copy.model_class : "";
  delete copy.model_class;
  const name = resolved.toLowerCase();
  if (
    ["anthropic", "sonnet", "opus", "claude"].some((part) =>
      name.includes(part),
    ) &&
    !("set_cache_control" in config)
  ) {
    copy.set_cache_control = "default_end";
  }
  const ModelClass = getModelClass(resolved, modelClass);
  return new ModelClass(copy);
}
