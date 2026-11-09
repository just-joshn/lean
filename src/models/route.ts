import { UnsupportedParamsError } from "./errors.ts";

export class ProviderParityGateError extends UnsupportedParamsError {
  constructor(provider: string, gate: string) {
    super(
      `Open provider parity gate for ${provider}: ${gate}. This is not a supported-provider boundary.`,
    );
    this.name = "ProviderParityGateError";
  }
}

const COMPATIBLE = new Set([
  "anyscale",
  "groq",
  "nvidia_nim",
  "cerebras",
  "baseten",
  "sambanova",
  "ai21_chat",
  "ai21",
  "volcengine",
  "codestral",
  "deepseek",
  "tencent",
  "deepinfra",
  "perplexity",
  "xinference",
  "xai",
  "zai",
  "together_ai",
  "fireworks_ai",
  "empower",
  "friendliai",
  "azure_ai",
  "github",
  "litellm_proxy",
  "hosted_vllm",
  "llamafile",
  "lm_studio",
  "galadriel",
  "github_copilot",
  "chatgpt",
  "novita",
  "meta_llama",
  "publicai",
  "synthetic",
  "tensormesh",
  "apertis",
  "nano-gpt",
  "poe",
  "chutes",
  "parasail",
  "libertai",
  "featherless_ai",
  "nscale",
  "nebius",
  "dashscope",
  "qwencloud",
  "qwen_ai_platform",
  "modelscope",
  "moonshot",
  "v0",
  "helicone",
  "morph",
  "lambda_ai",
  "inception",
  "hyperbolic",
  "vercel_ai_gateway",
  "aiml",
  "edenai",
  "wandb",
  "cometapi",
  "clarifai",
  "docker_model_runner",
  "ragflow",
  "pinstripes",
  "darkbloom",
  "meta",
  "cognition",
  "coralbricks",
  "cortecs",
  "scx-ai",
  "prism",
  "sail",
  "reka",
]);
const TEXT_COMPATIBLE = new Set([
  "together_ai",
  "fireworks_ai",
  "hosted_vllm",
  "meta_llama",
  "llamafile",
  "featherless_ai",
  "nebius",
  "dashscope",
  "qwencloud",
  "qwen_ai_platform",
  "modelscope",
  "moonshot",
  "publicai",
  "synthetic",
  "tensormesh",
  "apertis",
  "nano-gpt",
  "poe",
  "chutes",
  "v0",
  "lambda_ai",
  "hyperbolic",
  "wandb",
]);
const BEFORE_TEXT = new Set(["azure", "azure_text", "deepseek", "azure_ai"]);
const BEFORE_COMPATIBLE = new Set([
  "fireworks_ai",
  "together_ai",
  "heroku",
  "ragflow",
  "scaledown",
  "xai",
  "groq",
  "bedrock_mantle",
  "a2a",
  "gigachat",
  "sap",
  "aiohttp_openai",
  "cometapi",
  "minimax",
  "hosted_vllm",
  "edenai",
  "fal_ai",
]);
const LATER = new Set([
  "mistral",
  "replicate",
  "anthropic_text",
  "anthropic",
  "nlp_cloud",
  "aleph_alpha",
  "cohere_chat",
  "cohere",
  "maritalk",
  "amazon_nova",
  "huggingface",
  "oci",
  "compactifai",
  "oobabooga",
  "databricks",
  "datarobot",
  "openrouter",
  "nadir",
  "vercel_ai_gateway",
  "palm",
  "vertex_ai_beta",
  "gemini",
  "vertex_ai",
  "predibase",
  "text-completion-codestral",
  "text-completion-inception",
  "sagemaker_chat",
  "sagemaker_nova",
  "sagemaker",
  "bedrock",
  "watsonx",
  "watsonx_text",
  "vllm",
  "ollama",
  "ollama_chat",
  "triton",
  "cloudflare",
  "petals",
  "snowflake",
  "gradient_ai",
  "gdc",
  "bytez",
  "lemonade",
  "ovhcloud",
  "custom",
  "langgraph",
  "microsoft_365_copilot",
  "langflow",
  "databricks_agent",
]);

export function isProviderPrefix(provider: string): boolean {
  return (
    provider === "openai" ||
    provider === "custom_openai" ||
    provider === "text-completion-openai" ||
    BEFORE_TEXT.has(provider) ||
    BEFORE_COMPATIBLE.has(provider) ||
    COMPATIBLE.has(provider) ||
    LATER.has(provider)
  );
}

export function chatHandler<T extends () => unknown>(
  provider: string,
  model: string,
  textCompletion: boolean,
  handlers: {
    openai: T;
    anthropic: T;
    bedrock: T;
    compatible: T;
    unproven: (provider: string) => T;
  },
): T {
  if (BEFORE_TEXT.has(provider)) return handlers.unproven(provider);
  if (
    provider === "text-completion-openai" ||
    model.includes("ft:babbage-002") ||
    model.includes("ft:davinci-002") ||
    (TEXT_COMPATIBLE.has(provider) && textCompletion)
  )
    return handlers.unproven("openai-text");
  if (BEFORE_COMPATIBLE.has(provider)) return handlers.unproven(provider);
  if (
    provider === "openai" ||
    provider === "custom_openai" ||
    COMPATIBLE.has(provider) ||
    model.includes("ft:gpt-3.5-turbo")
  )
    return provider === "openai" ? handlers.openai : handlers.compatible;
  if (provider === "mistral") return handlers.unproven(provider);
  if (provider === "replicate" || model.includes("replicate"))
    return handlers.unproven("replicate");
  if (provider === "anthropic") return handlers.anthropic;
  if (provider === "bedrock") return handlers.bedrock;
  if (provider === "palm")
    throw new ProviderParityGateError(
      provider,
      "Palm was decommissioned in the source",
    );
  return handlers.unproven(provider);
}
