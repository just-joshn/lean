export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class ContextWindowExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextWindowExceededError";
  }
}

export class UnsupportedParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedParamsError";
  }
}
