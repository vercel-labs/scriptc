// Inspecting an instance of a program-declared Error subclass names its
// constructor the way Node's improveStack does: `[Plain [Error]: m]`, or
// `[FetchFailedError: m]` when the constructor name already contains the
// error's name; runtime error classes keep their own header. Own `cause`
// properties (declared, assigned in the constructor or later) and a
// declared `name` follow Node's rendering, as does a cause's own
// `[cause]` and an AggregateError cause's `[errors]`, and beyond the depth
// limit an instance with own properties renders as `[Constructor]`. (The
// stack is cleared: compiled errors carry none.)
import * as util from "node:util";

class Plain extends Error {}
class FetchFailedError extends Error {}
class Deeper extends Plain {}
class Caused extends Error {
  override cause: unknown = "declared";
}
class Assigned extends Error {
  constructor(message?: string) {
    super(message);
    this.cause = { at: "constructor" };
  }
}
class Renamed extends Error {
  override name = "RenamedError";
}
class Typed extends TypeError {}
class RangeLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.cause = 3;
  }
}

function clean(error: Error): Error {
  error.stack = "";
  return error;
}

function show(error: Error): void {
  console.log(util.format(error), "|", util.format("%s", error));
  console.log(util.inspect({ nested: error }));
}

show(clean(new Plain("p")));
show(clean(new FetchFailedError("f")));
show(clean(new Deeper("d")));
show(clean(new Caused("c")));
show(clean(new Assigned("a")));
show(clean(new Renamed("r")));
show(clean(new Error("plain")));
show(clean(new TypeError("type")));
show(clean(new Typed("typed")));
show(clean(new RangeLimitError("range")));
const typed: Plain = new Deeper("typed as the base");
typed.stack = "";
console.log(util.inspect(typed));
const listed = [new Plain("in an array")];
listed[0]!.stack = "";
console.log(util.inspect(listed));
const later = clean(new Plain("later"));
later.cause = "assigned later";
console.log(util.inspect(later));
const multiline = clean(new Plain("first\nsecond"));
console.log(util.inspect({ multiline }));
const deep = [clean(new Assigned("beyond depth")), clean(new Assigned()), clean(new Plain())];
for (const error of deep) console.log(util.inspect({ a: { b: error } }, { depth: 1 }));
const inner = new Error("inner", { cause: "deep" });
inner.stack = "";
console.log(util.inspect(inner));
const wrapped = clean(new Plain("outer"));
wrapped.cause = inner;
console.log(util.inspect(wrapped));
const first = new Error("first");
first.stack = "";
const aggregate: Error = new AggregateError([first], "all failed", { cause: "why" });
aggregate.stack = "";
const holder = clean(new Plain("holder"));
holder.cause = aggregate;
console.log(util.inspect(holder, { depth: 4 }));
