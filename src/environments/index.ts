import type { Environment } from "../protocols.ts";
import { DockerEnvironment } from "./docker.ts";
import { LocalEnvironment } from "./local.ts";

const ENVIRONMENTS: Record<
  string,
  new (data: Record<string, unknown>) => Environment
> = {
  local: LocalEnvironment,
  docker: DockerEnvironment,
};

export function getEnvironment(
  config: Record<string, unknown> = {},
  defaultType = "",
): Environment {
  const copy = { ...config };
  const spec =
    typeof copy.environment_class === "string"
      ? copy.environment_class
      : defaultType;
  delete copy.environment_class;
  const EnvironmentClass = ENVIRONMENTS[spec];
  if (!EnvironmentClass) {
    throw new Error(
      `Unknown environment type: ${spec} (available: ${Object.keys(ENVIRONMENTS).join(", ")})`,
    );
  }
  return new EnvironmentClass(copy);
}
