// @requires-libnode
// Errors thrown in Node.js cross into the program as copies: an Error as
// its nearest intrinsic class with its message and string code, any other
// thrown value as its JSON copy.
import { callSync } from "@scriptc/node";

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "returned");
  } catch (e) {
    if (e instanceof Error) {
      const code = (e as NodeJS.ErrnoException).code;
      console.log(
        label,
        e.name,
        e instanceof TypeError,
        e instanceof RangeError,
        JSON.stringify(e.message),
        code ?? "-",
      );
    } else {
      console.log(label, "value", JSON.stringify(e));
    }
  }
}

attempt("type", () => callSync("./throws.cjs", "typeError"));
attempt("range", () => callSync("./throws.cjs", "rangeError"));
attempt("syntax", () => callSync("./throws.cjs", "syntaxError"));
attempt("coded", () => callSync("./throws.cjs", "coded"));
attempt("custom class", () => callSync("./throws.cjs", "custom"));
attempt("string", () => callSync("./throws.cjs", "string"));
attempt("object", () => callSync("./throws.cjs", "object"));
attempt("not a function", () => callSync("./throws.cjs", "notAFunction"));
attempt("missing export", () => callSync("./throws.cjs", "missing"));
attempt("promise", () => callSync("./throws.cjs", "later"));
attempt("bigint result", () => callSync("./throws.cjs", "big"));
attempt("returns", () => callSync("./throws.cjs", "fine"));
try {
  callSync("./does-not-exist.cjs", "anything");
} catch (e) {
  console.log("missing module", (e as NodeJS.ErrnoException).code);
}
console.log("done");
