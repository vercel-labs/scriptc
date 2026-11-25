// `"code" in error`: an Error subclass that declares a `code` field has it as
// an own property on every instance, a system error has it stamped, a code
// assigned later is present, and a plain error has none. The guard shape
// `value instanceof Error && "code" in value` must answer for all of them.
import { readFileSync } from "node:fs";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class Timeout extends HttpError {
  constructor() {
    super("timeout", 408, "timeout");
  }
}
class Uncoded extends Error {
  detail = "d";
}

function isCoded(value: unknown): value is Error & { code: unknown } {
  return value instanceof Error && "code" in value;
}

function raise(kind: string): void {
  if (kind === "http") throw new HttpError("denied", 403, "forbidden");
  if (kind === "timeout") throw new Timeout();
  if (kind === "uncoded") throw new Uncoded("nothing");
  if (kind === "plain") throw new Error("plain");
  if (kind === "assigned") {
    const failure = new Error("assigned") as Error & { code?: string };
    failure.code = "E_LATE";
    throw failure;
  }
  if (kind === "system") readFileSync("/nonexistent/scriptc-9364");
  if (kind === "string") throw "text";
}

for (const kind of ["http", "timeout", "uncoded", "plain", "assigned", "system", "string"]) {
  try {
    raise(kind);
  } catch (err) {
    if (isCoded(err)) console.log(kind, "coded", String(err.code), err.message.slice(0, 8));
    else console.log(kind, "uncoded", err instanceof Error ? err.message : String(err));
    if (err instanceof Error) {
      console.log(kind, "code" in err, "status" in err, "detail" in err, "message" in err, "missing" in err);
    }
  }
}

// Outside a catch clause, through the static types.
const http = new HttpError("x", 500, "E_X");
const asError: Error = http;
const timeout: HttpError = new Timeout();
console.log("code" in http, "code" in asError, "code" in timeout, "code" in new Uncoded("u"), "code" in new Error("e"));
