export class ParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "ParseError";
    this.line = line;
  }
}
