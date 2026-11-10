import { describe, expect, test } from "vitest";
import { AgentConfig } from "../agents/default.ts";
import { InteractiveAgentConfig } from "../agents/interactive.ts";
import { DockerEnvironmentConfig } from "../environments/docker.ts";
import { LitellmModel, LitellmModelConfig } from "../models/litellm-model.ts";
import { LitellmTextbasedModel } from "../models/litellm-textbased-model.ts";
import controls from "./boundary-source-controls.json" with { type: "json" };
import { PosixPath } from "./fields.ts";

const agent = (data = {}) =>
  new AgentConfig({ system_template: "s", instance_template: "i", ...data });
const model = (data = {}) =>
  new LitellmModelConfig({ model_name: "m", ...data });
const calls: Record<
  string,
  () => { model_dump(mode?: string): Record<string, unknown> }
> = {
  "registry supplied string": () =>
    model({ litellm_model_registry: "reg.json" }),
  "registry supplied path": () =>
    model({ litellm_model_registry: new PosixPath("reg.json") }),
  "empty output path": () => agent({ output_path: "" }),
  "bare AgentConfig exact error": () => new AgentConfig(),
  "bare model exact error": () => new LitellmModelConfig(),
  "invalid literal exact error": () => model({ cost_tracking: "bogus" }),
  "json-mode nonfinite cost": () => agent({ cost_limit: "nan" }),
  "forward_env string": () =>
    new DockerEnvironmentConfig({ image: "", forward_env: "PATH" }),
  "forward_env tuple": () =>
    new DockerEnvironmentConfig({ image: "", forward_env: ["PATH", "HOME"] }),
  "run_args wrong element": () =>
    new DockerEnvironmentConfig({ image: "", run_args: [2] }),
  "config class callable factory": () =>
    new LitellmModel(
      { model_name: "m" },
      (data) => new LitellmModelConfig(data),
    ).config,
  "config class string error": () =>
    new LitellmModel({ model_name: "m", config_class: "bad" }).config,
  "text config class collision": () =>
    new LitellmTextbasedModel({
      model_name: "m",
      config_class: LitellmModelConfig,
    }).config,
  "decimal integer string": () => agent({ step_limit: "3.0" }),
  "exponent integer string": () => agent({ step_limit: "3e0" }),
  "fractional integer number": () => agent({ step_limit: 1.1 }),
  "duplicate underscore integer": () => agent({ step_limit: "1__0" }),
  "boolean t": () =>
    new InteractiveAgentConfig({
      system_template: "s",
      instance_template: "i",
      confirm_exit: "t",
    }),
  "whitespace boolean": () =>
    new InteractiveAgentConfig({
      system_template: "s",
      instance_template: "i",
      confirm_exit: " true ",
    }),
  "duplicate underscore float": () => agent({ cost_limit: "1__0" }),
  "UTF8 bytes string input": () =>
    new AgentConfig({
      system_template: Buffer.from("abc"),
      instance_template: "i",
    }),
};

function encode(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return { float: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    if (value instanceof PosixPath)
      return { type: "PosixPath", text: value.text, parts: value.parts };
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encode(entry)]),
    );
  }
  return value;
}

describe("pinned public construction controls", () => {
  test("maps every construction control without silently dropping a case", () => {
    expect(Object.keys(calls)).toHaveLength(21);
    expect(
      controls.cases.filter((row) => !calls[row.case]).map((row) => row.case),
    ).toEqual([
      "direct subclass serialization",
      "supplied dictionary copy identity",
    ]);
  });

  for (const source of controls.cases) {
    const call = calls[source.case];
    if (!call) continue;
    test(source.case, () => {
      if (source.accepted) {
        expect(
          encode(
            call().model_dump(
              source.case === "json-mode nonfinite cost" ? "json" : "python",
            ),
          ),
        ).toEqual(source.value);
      } else {
        let failure: unknown;
        try {
          call();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).constructor.name).toBe(source.error_type);
        expect((failure as Error).message).toBe(source.message);
        if (source.details !== null)
          expect(
            encode((failure as Error & { details: unknown }).details),
          ).toEqual(source.details);
      }
    });
  }
});
