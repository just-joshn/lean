type Usage = Record<string, unknown>;

function record(value: unknown): Usage {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Usage)
    : {};
}

function tokens(value: unknown): number {
  if (value == null) return 0;
  return typeof value === "number" ? value : Number(value);
}

export function anthropicUsage(raw: Usage, hasThinking = false): Usage {
  const iterations = Array.isArray(raw.iterations)
    ? raw.iterations.map(record)
    : [];
  const entries = iterations.length ? iterations : [raw];
  const sum = (key: string) =>
    entries.reduce((total, entry) => total + tokens(entry[key]), 0);
  const input = sum("input_tokens");
  const output = sum("output_tokens");
  const read = sum("cache_read_input_tokens");
  const created = sum("cache_creation_input_tokens");
  const breakdowns = entries
    .filter((entry) => entry.cache_creation != null)
    .map((entry) => record(entry.cache_creation));
  let creation: Usage | null = null;
  if (breakdowns.length) {
    const five = breakdowns.reduce(
      (total, entry) => total + tokens(entry.ephemeral_5m_input_tokens),
      0,
    );
    const hour = breakdowns.reduce(
      (total, entry) => total + tokens(entry.ephemeral_1h_input_tokens),
      0,
    );
    creation = {
      ephemeral_5m_input_tokens: iterations.length
        ? five + Math.max(created - five - hour, 0)
        : (breakdowns[0]?.ephemeral_5m_input_tokens ?? null),
      ephemeral_1h_input_tokens: iterations.length
        ? hour
        : (breakdowns[0]?.ephemeral_1h_input_tokens ?? null),
    };
  }
  const reported = entries.map(
    (entry) => record(entry.output_tokens_details).thinking_tokens,
  );
  const reasoning = reported.every((value) => typeof value === "number")
    ? Math.min(
        Math.max(
          reported.reduce<number>((total, value) => total + tokens(value), 0),
          0,
        ),
        output,
      )
    : hasThinking
      ? null
      : 0;
  return {
    prompt_tokens: input + read + created,
    completion_tokens: output,
    total_tokens: input + read + created + output,
    prompt_tokens_details: {
      audio_tokens: null,
      image_tokens: null,
      video_tokens: null,
      initial_prompt_tokens: null,
      cached_tokens: read,
      cache_write_tokens: created,
      cache_creation_tokens: created,
      cache_creation_token_details: creation,
      text_tokens: input,
    },
    completion_tokens_details: {
      accepted_prediction_tokens: null,
      rejected_prediction_tokens: null,
      audio_tokens: null,
      image_tokens: null,
      video_tokens: null,
      reasoning_tokens: reasoning,
      text_tokens: reasoning === null ? null : output - reasoning,
    },
    cache_read_input_tokens: read,
    cache_creation_input_tokens: created,
    iterations: raw.iterations ?? null,
    service_tier: raw.service_tier ?? null,
    inference_geo: raw.inference_geo ?? null,
    speed: raw.speed ?? null,
    ...(raw.cost == null ? {} : { cost: raw.cost }),
    ...(raw.server_tool_use == null
      ? {}
      : { server_tool_use: raw.server_tool_use }),
  };
}
