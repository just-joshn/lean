import { expect, test } from "vitest";
import { AgentConfig } from "../agents/default.ts";
import { LocalEnvironmentConfig } from "../environments/local.ts";
import { ValidationError } from "./fields.ts";

const agent = (data: Record<string, unknown>) =>
  new AgentConfig({ system_template: "s", instance_template: "i", ...data });

test("rejects integer strings past the safe integer range", () => {
  expect(agent({ step_limit: "9007199254740991" }).step_limit).toBe(
    9007199254740991,
  );
  expect(() => agent({ step_limit: "9007199254740992" })).toThrow(
    /int_parsing/,
  );
  expect(() => agent({ step_limit: "9007199254740993" })).toThrow(
    /int_parsing/,
  );
  expect(() => agent({ step_limit: "9007199254740993.0" })).toThrow(
    /int_parsing/,
  );
});

test("reports invalid utf-8 as a string_unicode validation error", () => {
  let failure: unknown;
  try {
    agent({ system_template: new Uint8Array([0xff]) });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ValidationError);
  expect((failure as ValidationError).details).toMatchObject([
    {
      type: "string_unicode",
      loc: ["system_template"],
      msg: "Input should be a valid string, unable to parse raw data as a unicode string",
    },
  ]);
});

test("reports every invalid string-dict entry with its key", () => {
  let failure: unknown;
  try {
    new LocalEnvironmentConfig({ env: { PORT: 8080, USER: 1 } });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ValidationError);
  const details = (failure as ValidationError).details;
  expect(details.map((detail) => detail.loc)).toEqual([
    ["env", "PORT"],
    ["env", "USER"],
  ]);
  expect(details.map((detail) => detail.input)).toEqual([8080, 1]);
});
