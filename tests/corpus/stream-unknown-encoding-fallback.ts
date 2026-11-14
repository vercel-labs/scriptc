// A stream program that never mentions util.inspect links no inspect unit,
// so the stream unit answers ERR_UNKNOWN_ENCODING with its own String()
// rendering: a number as JS ToString, a boolean as "true". Both spell the
// same text Node's util.format-based message does.
import { Readable } from "node:stream";

function attempt(label: string, encoding: unknown): void {
  try {
    Readable.from(["x"], { encoding: encoding as BufferEncoding });
    console.log("accepted", label);
  } catch (error: any) {
    console.log(`${label} ${error.name} ${error.code} ${error.message}`);
  }
}

attempt("number", 42);
attempt("boolean", true);
