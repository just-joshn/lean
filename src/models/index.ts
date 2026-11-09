import { LitellmModel } from "./litellm-model.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import { LitellmTextbasedModel } from "./litellm-textbased-model.ts";
import type { Model } from "../protocols.ts";
import { copyConfig, loadClass } from "../utils/load.ts";
import { ValueError } from "../config/errors.ts";

const MODELS: Record<string, new (data: Record<string, unknown>) => Model> = {
  litellm: LitellmModel,
  litellm_textbased: LitellmTextbasedModel,
  litellm_response: LitellmResponseModel,
};

export function getModelName(
  input: string | null | undefined,
  config: Record<string, unknown> | null = {},
): string {
  config ??= {};
  if (input) return input;
  if (typeof config.model_name === "string" && config.model_name)
    return config.model_name;
  if (process.env.MSWEA_MODEL_NAME) return process.env.MSWEA_MODEL_NAME;
  throw new ValueError(
    "No default model set. Please run `mini-extra config setup` to set one.",
  );
}

export function getModelClass(
  _modelName: string,
  modelClass = "",
): new (data: Record<string, unknown>) => Model {
  if (modelClass) return loadClass(modelClass, MODELS, "model class");
  return LitellmModel;
}

export function getModel(
  inputModelName?: string | null,
  config: Record<string, unknown> | null = {},
): Model {
  config ??= {};
  const resolved = getModelName(inputModelName, config);
  const copy: Record<string, unknown> = {
    ...copyConfig(config),
    model_name: resolved,
  };
  const modelClass =
    typeof copy.model_class === "string" ? copy.model_class : "";
  delete copy.model_class;
  const ModelClass = getModelClass(resolved, modelClass);
  const name = resolved.toLowerCase();
  if (
    ["anthropic", "sonnet", "opus", "claude"].some((part) =>
      name.includes(part),
    ) &&
    !("set_cache_control" in copy)
  ) {
    copy.set_cache_control = "default_end";
  }
  return new ModelClass(copy);
}
