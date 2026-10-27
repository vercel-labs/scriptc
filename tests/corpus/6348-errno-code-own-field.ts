// `(err as NodeJS.ErrnoException).code` reads an Error subclass's own
// `code` field, as Node reads the own property, and still reads the errno
// code of runtime errors and undefined for plain errors.
import { readFileSync } from "node:fs";

class AppError extends Error {
  code: string;
  constructor(message: string, code = "E_APP") {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
class DbError extends AppError {
  constructor() {
    super("db", "E_DB");
  }
}
class Later extends Error {
  code?: string;
}

function codeOf(err: unknown): string {
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? "(none)";
  return "(not an error)";
}

console.log(codeOf(new AppError("direct")));
console.log(codeOf(new DbError()));
const wrapped = new TypeError("wrapped", { cause: new AppError("cause", "E_CAUSE") });
console.log(codeOf(wrapped.cause), codeOf(wrapped));
try {
  throw new DbError();
} catch (err) {
  console.log(codeOf(err));
}
const later = new Later("later");
console.log(codeOf(later));
later.code = "E_LATER";
console.log(codeOf(later));
try {
  readFileSync("/nonexistent/scriptc-corpus-6348");
} catch (err) {
  console.log(codeOf(err));
}
console.log(codeOf(new Error("plain")), codeOf(new RangeError("range")), codeOf("text"));
