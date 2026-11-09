export class ResponseResult {
  [key: string]: unknown;
  #body: Record<string, unknown>;

  constructor(body: Record<string, unknown>) {
    this.#body = body;
    Object.assign(this, body);
    Reflect.deleteProperty(this, "model_dump");
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
