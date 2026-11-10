import type { Agent, Environment, Model } from "../protocols.ts";
import { copyConfig, loadClass } from "../utils/load.ts";
import { DefaultAgent } from "./default.ts";
import { InteractiveAgent } from "./interactive.ts";

const AGENTS: Record<
  string,
  new (model: Model, env: Environment, data: Record<string, unknown>) => Agent
> = {
  default: DefaultAgent,
  interactive: InteractiveAgent,
};

export function getAgentClass(spec: string): (typeof AGENTS)[string] {
  return loadClass(spec, AGENTS, "agent type");
}

export function getAgent(
  model: Model,
  env: Environment,
  config: Record<string, unknown> = {},
  defaultType = "",
): Agent {
  const copy = copyConfig(config);
  const spec =
    typeof copy.agent_class === "string" ? copy.agent_class : defaultType;
  delete copy.agent_class;
  const AgentClass = getAgentClass(spec);
  return new AgentClass(model, env, copy);
}
