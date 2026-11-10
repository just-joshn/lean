import { describe, expect, test } from "vitest";
import { AgentConfig, DefaultAgent } from "../agents/default.ts";
import { InteractiveAgentConfig } from "../agents/interactive.ts";
import { DockerEnvironmentConfig } from "../environments/docker.ts";
import { LocalEnvironment } from "../environments/local.ts";
import { getModel } from "../models/index.ts";
import { LitellmModel, LitellmModelConfig } from "../models/litellm-model.ts";
import { PosixPath, stringField, type Field } from "./fields.ts";
import controls from "./required-source-controls.json" with { type: "json" };

class ReviewConfig extends LitellmModelConfig {
  static override fields: Record<string, Field> = {
    reviewer: stringField("ada"),
  };
  declare reviewer: string;
}
class TrimConfig extends ReviewConfig {
  constructor(data: Record<string, unknown> = {}) {
    super(data);
    this.reviewer = this.reviewer.trim();
  }
}

const agent = (data = {}) =>
  new AgentConfig({
    system_template: "sys",
    instance_template: "task",
    ...data,
  });
const calls: Record<string, () => { model_dump(): Record<string, unknown> }> = {
  "bare AgentConfig": () => new AgentConfig(),
  "bare DockerEnvironmentConfig": () => new DockerEnvironmentConfig(),
  "bare LitellmModelConfig": () => new LitellmModelConfig(),
  "integer string": () => agent({ step_limit: "3" }),
  "fractional integer string": () => agent({ step_limit: "1.1" }),
  "zero float string": () => agent({ cost_limit: "0" }),
  "fractional cost string": () => agent({ cost_limit: "3.5" }),
  "nan cost string": () => agent({ cost_limit: "nan" }),
  "invalid cost tracking literal": () =>
    new LitellmModelConfig({ model_name: "m", cost_tracking: "bogus" }),
  "invalid cache literal": () =>
    new LitellmModelConfig({ model_name: "m", set_cache_control: "nope" }),
  "path from string": () => agent({ output_path: "runs/out.json" }),
  "null required string": () => agent({ system_template: null }),
  "numeric required string": () => agent({ system_template: 2 }),
  "false from string": () =>
    new InteractiveAgentConfig({
      system_template: "sys",
      instance_template: "task",
      confirm_exit: "false",
    }),
  "explicit empty required strings": () =>
    agent({ system_template: "", instance_template: "" }),
  "empty required image": () => new DockerEnvironmentConfig({ image: "" }),
  "declared subclass override": () =>
    new ReviewConfig({ model_name: "m", reviewer: "bob" }),
  "subclass string rejects number": () =>
    new ReviewConfig({ model_name: "m", reviewer: 7 }),
  "constructor normalization": () =>
    new TrimConfig({ model_name: "m", reviewer: "  bob  " }),
  "model constructor config class": () =>
    new LitellmModel({ model_name: "m", reviewer: "bob" }, ReviewConfig).config,
  "model factory config class dictionary": () => {
    const result = getModel("m", {
      config_class: ReviewConfig,
      reviewer: "bob",
    });
    if (!(result instanceof LitellmModel))
      throw new Error("Expected LitellmModel");
    return result.config;
  },
};

function encode(value: unknown): unknown {
  if (value instanceof PosixPath)
    return { type: "PosixPath", text: value.text, parts: value.parts };
  if (typeof value === "number" && Number.isNaN(value)) return { float: "nan" };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]),
    );
  return value;
}

describe("pinned required values and native declarations", () => {
  for (const source of controls.cases) {
    test(source.case, () => {
      const call = calls[source.case]!;
      if (source.accepted)
        expect(encode(call().model_dump())).toEqual(source.dump);
      else {
        let failure: unknown;
        try {
          call();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).constructor.name).toBe(source.error_type);
        expect((failure as Error).message).toBe(source.message);
        expect((failure as Error & { details: unknown }).details).toEqual(
          source.details,
        );
      }
    });
  }

  test("copies supplied dictionaries shallowly and defaults independently", () => {
    const nested = { retained: true };
    const input = { nested };
    const first = new LitellmModelConfig({
      model_name: "m",
      model_kwargs: input,
    });
    expect(first.model_kwargs).not.toBe(input);
    expect(first.model_kwargs.nested).toBe(nested);
    const second = new LitellmModelConfig({ model_name: "m" });
    const third = new LitellmModelConfig({ model_name: "m" });
    expect(second.model_kwargs).not.toBe(third.model_kwargs);
  });

  test("keeps validation and serialization on the same inherited fields", () => {
    const model = new LitellmModel({
      model_name: "m",
      reviewer: " bob ",
      extra: 1,
      config_class: TrimConfig,
    });
    expect(model.config.model_dump()).toMatchObject({
      model_name: "m",
      reviewer: "bob",
    });
    expect(model.config.model_dump()).not.toHaveProperty("extra");
    expect(
      () =>
        new LitellmModel({
          model_name: "m",
          reviewer: 2,
          config_class: TrimConfig,
        }),
    ).toThrow("valid string");
    expect(new ReviewConfig({ model_name: "m" }).reviewer).toBe("ada");
  });

  test("retains direct native subclass identity instead of inheriting a builtin identity", async () => {
    class DirectModel extends LitellmModel {}
    class DirectEnvironment extends LocalEnvironment {}
    class DirectAgent extends DefaultAgent {}
    const model = new DirectModel({ model_name: "m" });
    const env = new DirectEnvironment();
    const agent = new DirectAgent(model, env, {
      system_template: "s",
      instance_template: "i",
      output_path: "out.json",
    });
    expect(model.serialize()).toHaveProperty(
      "info.config.model_type",
      "DirectModel",
    );
    expect(env.serialize()).toHaveProperty(
      "info.config.environment_type",
      "DirectEnvironment",
    );
    expect(await agent.serialize()).toHaveProperty(
      "info.config.agent_type",
      "DirectAgent",
    );
    expect(await agent.serialize()).toHaveProperty(
      "info.config.agent.output_path",
      "out.json",
    );
    class NamedModel extends DirectModel {
      static override typeName = "owned.NamedModel";
    }
    expect(new NamedModel({ model_name: "m" }).serialize()).toHaveProperty(
      "info.config.model_type",
      "owned.NamedModel",
    );
  });
});
