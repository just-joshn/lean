import { describe, expect, test } from "vitest";
import { DefaultAgent } from "./agents/default.ts";
import { Submitted } from "./exceptions.ts";
import { LitellmModel } from "./models/litellm-model.ts";
import { LitellmTextbasedModel } from "./models/litellm-textbased-model.ts";
import type {
  Action,
  Environment,
  ExecutionOutput,
  Message,
  Model,
  Observation,
} from "./protocols.ts";

const observationTemplate =
  "{{ output.returncode }}:{{ output.output }}:{{ output.detail }}";
const exceptionTemplate = "{{ output.exception_info }}:{{ output.output }}";

class StructuralModel implements Model {
  config: unknown = {};
  private calls = 0;

  query(): Message {
    this.calls += 1;
    if (this.calls > 1) {
      throw new Submitted({
        role: "exit",
        content: "done",
        extra: { exit_status: "Submitted", submission: "done" },
      });
    }
    return {
      role: "assistant",
      content: "run",
      extra: { actions: [{ command: "echo hi" }], cost: 0 },
    };
  }

  format_message(fields: Message): Message {
    return fields;
  }

  format_observation_messages(
    _message: Message,
    outputs: ExecutionOutput[],
  ): Message[] {
    return outputs.map((output) => ({
      role: "user",
      content: output.output,
    }));
  }

  get_template_vars(): Record<string, unknown> {
    return {};
  }

  serialize(): Record<string, unknown> {
    return {};
  }
}

class StructuralEnv implements Environment {
  config: unknown = {};
  commands: string[] = [];

  execute(action: Action): ExecutionOutput {
    const command = String(action.command);
    this.commands.push(command);
    return {
      output: `${command}\n`,
      returncode: 0,
      exception_info: "",
    };
  }

  get_template_vars(): Record<string, unknown> {
    return {};
  }

  serialize(): Record<string, unknown> {
    return {};
  }
}

describe("public protocols", () => {
  test("DefaultAgent runs structural collaborators that have no model_dump", async () => {
    const model = new StructuralModel();
    const env = new StructuralEnv();
    const agent = new DefaultAgent(model, env, {
      system_template: "system",
      instance_template: "task {{ task }}",
      output_path: null,
      cost_limit: 0,
    });
    const result = await agent.run("ship");
    expect(model.config).toEqual({});
    expect(env.config).toEqual({});
    expect(env.commands).toEqual(["echo hi"]);
    expect(result).toEqual({ exit_status: "Submitted", submission: "done" });
    expect(agent.messages.map((message) => message.content)).toEqual([
      "system",
      "task ship",
      "run",
      "echo hi\n",
      "done",
    ]);
  });

  test("native formatters render an observation that omits exception_info", () => {
    const open: Observation = {
      output: "hello",
      returncode: 0,
      detail: "custom",
    };
    const failed = {
      output: "hello",
      returncode: 0,
      exception_info: "boom",
    };
    const models = [
      new LitellmModel({
        model_name: "fixture-model",
        observation_template: observationTemplate,
      }),
      new LitellmTextbasedModel({
        model_name: "fixture-model",
        observation_template: observationTemplate,
      }),
    ];
    for (const model of models) {
      const [plain] = model.format_observation_messages(
        {
          extra: { actions: [{ command: "echo hi", tool_call_id: "call-1" }] },
        },
        [open],
      );
      expect(plain?.content).toBe("0:hello:custom");
      expect(plain?.extra?.exception_info).toBeUndefined();
      expect(plain?.extra?.returncode).toBe(0);
      expect(plain?.extra?.raw_output).toBe("hello");
    }
    const markedModel = new LitellmModel({
      model_name: "fixture-model",
      observation_template: exceptionTemplate,
    });
    const [marked] = markedModel.format_observation_messages(
      { extra: { actions: [{ command: "echo hi", tool_call_id: "call-1" }] } },
      [failed],
    );
    expect(marked?.content).toBe("boom:hello");
  });
});
