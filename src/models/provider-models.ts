import { LitellmModel } from "./litellm-model.ts";
import { ProviderParityGateError } from "./route.ts";

abstract class UnprovenProviderModel extends LitellmModel {
  protected override async request(): Promise<never> {
    throw new ProviderParityGateError(
      this.type_name,
      "dedicated model component has not been implemented or source-controlled",
    );
  }
}

export class OpenRouterModel extends UnprovenProviderModel {
  override readonly type_name =
    "minisweagent.models.openrouter_model.OpenRouterModel";
}

export class PortkeyModel extends UnprovenProviderModel {
  override readonly type_name =
    "minisweagent.models.portkey_model.PortkeyModel";
}

export class RequestyModel extends UnprovenProviderModel {
  override readonly type_name =
    "minisweagent.models.requesty_model.RequestyModel";
}
