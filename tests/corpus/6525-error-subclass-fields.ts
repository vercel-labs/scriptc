// Inspecting an Error-typed value whose runtime class declares fields
// prints the stackless error base, with Node's constructor-name header
// (`[Bailable [Error]: m]`), followed by the own properties — on one line
// or broken across lines by the same width rule as any object, and as
// `[Name]` beyond the depth budget. A `cause` follows the fields: `cause:`
// when assigned, `[cause]:` from the constructor's options, and a cause
// prints its own cause. (The stack is cleared: compiled errors carry none.)
import * as util from "node:util";
class Bailable extends Error {
  bail = false;
}
class Detailed extends Bailable {
  attempts: number[] = [];
  label = "x";
}
function clean<E extends Error>(e: E): E {
  e.stack = "";
  return e;
}
function show(error: Error): void {
  console.log(util.format(error));
  console.log(util.format("%s", error));
  console.log(util.inspect({ wrapped: { deeper: { error } } }));
}
const b = clean(new Bailable("download failed"));
b.bail = true;
show(b);
show(clean(new Error("plain")));
const d = clean(new Detailed("y".repeat(70)));
d.attempts.push(1, 2);
show(d);
class FetchFailedError extends Error {
  status = 0;
}
const f = clean(new FetchFailedError("not found"));
f.status = 404;
show(f);
class Plain extends Error {}
show(clean(new Plain("field-less beside fielded subclasses")));
class Retried extends Error {
  retries = 2;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
show(clean(new Retried("with a cause", "from the options")));
show(clean(new Retried("with an undefined cause")));
const assigned = clean(new Bailable("assigned"));
assigned.cause = { code: 1 };
show(assigned);
const root = new Error("root");
root.stack = "";
const middle: Error = new TypeError("middle", { cause: root });
middle.stack = "";
show(clean(new Retried("nested causes", middle)));
