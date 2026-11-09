import type { Agent, Environment, Model } from "../protocols.ts";
import { DefaultAgent } from "./default.ts";
import { InteractiveAgent } from "./interactive.ts";

const AGENTS: Record<
  string,
  new (model: Model, env: Environment, data: Record<string, unknown>) => Agent
> = {
  default: DefaultAgent,
  interactive: InteractiveAgent,
};

export function getAgent(
  model: Model,
  env: Environment,
  config: Record<string, unknown> = {},
  defaultType = "",
): Agent {
  const copy = { ...config };
  const spec =
    typeof copy.agent_class === "string" ? copy.agent_class : defaultType;
  delete copy.agent_class;
  const AgentClass = AGENTS[spec];
  if (!AgentClass)
    throw new Error(
      `Unknown agent type: ${spec} (available: ${Object.keys(AGENTS).join(", ")})`,
    );
  return new AgentClass(model, env, copy);
}
