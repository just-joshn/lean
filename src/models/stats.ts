import { RuntimeError } from "../exceptions.ts";

export class GlobalModelStats {
  cost = 0;
  n_calls = 0;
  cost_limit = Number(process.env.MSWEA_GLOBAL_COST_LIMIT ?? "0");
  call_limit = Number(process.env.MSWEA_GLOBAL_CALL_LIMIT ?? "0");

  add(cost: number): void {
    this.cost += cost;
    this.n_calls += 1;
    if (
      (this.cost_limit > 0 && this.cost > this.cost_limit) ||
      (this.call_limit > 0 && this.call_limit < this.n_calls + 1)
    ) {
      throw new RuntimeError(
        `Global cost/call limit exceeded: $${this.cost.toFixed(4)} / ${this.n_calls}`,
      );
    }
  }

  reset(): void {
    this.cost = 0;
    this.n_calls = 0;
  }
}

export const GLOBAL_MODEL_STATS = new GlobalModelStats();
