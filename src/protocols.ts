export interface Message {
  role?: string;
  content?: unknown;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Action {
  command?: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ExecutionOutput {
  output: string;
  returncode: number;
  exception_info: string;
  extra?: Record<string, unknown>;
}

export interface Model {
  config: { model_dump: () => Record<string, unknown> };
  query(
    messages: Message[],
    kwargs?: Record<string, unknown>,
  ): Message | Promise<Message>;
  format_message(fields: Message): Message | Promise<Message>;
  format_observation_messages(
    message: Message,
    outputs: ExecutionOutput[],
    template_vars?: Record<string, unknown>,
  ): Message[] | Promise<Message[]>;
  get_template_vars(
    extra?: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  serialize(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface Environment {
  config: { model_dump: () => Record<string, unknown> };
  execute(
    action: Action,
    cwd?: string,
    timeout?: number | null,
  ): ExecutionOutput | Promise<ExecutionOutput>;
  get_template_vars(
    extra?: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  serialize(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface Agent {
  config: { model_dump: () => Record<string, unknown> };
  run(
    task?: string,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  save(
    path: string | null,
    ...extra: Array<Record<string, unknown> | null | undefined>
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}
