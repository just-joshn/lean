// The published 0.5.11 declarations use extensionless imports, which nodenext
// resolves as any.
declare module "@huggingface/jinja" {
  interface JinjaValue {
    type: string;
    value: unknown;
    __bool__(): JinjaValue;
    toString(): string;
  }

  interface Statement {
    type: string;
  }

  interface Program extends Statement {
    body: Statement[];
  }

  export class Environment {
    lookupVariable(name: string): JinjaValue;
    set(name: string, value: unknown): JinjaValue;
  }

  export class Interpreter {
    global: Environment;
    constructor(env?: Environment);
    run(program: Program): JinjaValue;
    evaluate(
      statement: Statement | undefined,
      environment: Environment,
    ): JinjaValue;
  }

  export function tokenize(
    source: string,
    options?: { lstrip_blocks?: boolean; trim_blocks?: boolean },
  ): unknown;

  export function parse(tokens: unknown): Program;
}
