export class ResponseResult {
  [key: string]: unknown;
  #body: Record<string, unknown>;

  constructor(body: Record<string, unknown>) {
    this.#body = body;
    for (const [key, value] of Object.entries(body)) {
      if (key !== "model_dump") Reflect.set(this, key, value);
    }
    if (Array.isArray(body.choices)) {
      this.choices = body.choices.map((choice: unknown) => {
        if (typeof choice !== "object" || choice === null) return choice;
        const message: unknown = Reflect.get(choice, "message");
        if (
          typeof message !== "object" ||
          message === null ||
          Array.isArray(message)
        ) {
          return choice;
        }
        return { ...choice, message: new ResponseResult({ ...message }) };
      });
    }
  }

  model_dump(): Record<string, unknown> {
    return structuredClone(this.#body);
  }
}
