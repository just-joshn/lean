import type { Message } from "./protocols.ts";

export class InterruptAgentFlow extends Error {
  readonly messages: Message[];

  constructor(...messages: Message[]) {
    super(messages[0]?.content ? String(messages[0].content) : "");
    this.messages = messages;
    this.name = this.constructor.name;
  }
}

export class Submitted extends InterruptAgentFlow {}

export class LimitsExceeded extends InterruptAgentFlow {}

export class TimeExceeded extends LimitsExceeded {}

export class UserInterruption extends InterruptAgentFlow {}

export class FormatError extends InterruptAgentFlow {}

export class KeyboardInterrupt extends Error {
  constructor(message = "") {
    super(message);
    this.name = "KeyboardInterrupt";
  }
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
