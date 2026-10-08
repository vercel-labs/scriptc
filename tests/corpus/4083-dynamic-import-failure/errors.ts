export class SetupError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}
