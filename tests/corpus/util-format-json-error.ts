// util.format %j over Error values: JSON.stringify sees an error's own
// enumerable properties, and message, stack and name are not enumerable,
// so a plain error prints "{}" while a subclass that declares fields
// prints those. Fields typed as errors and fields holding undefined
// serialize the way Node's walk does. Node is the oracle.
import { format } from "node:util";

class Bare extends Error {}
class Fielded extends Error {
  code: string;
  detail: string | undefined;
  count: number;
  constructor(message: string) {
    super(message);
    this.code = "E_FIELDED";
    this.detail = undefined;
    this.count = 2;
  }
}
class Wraps extends Error {
  inner: Error;
  list: number[];
  constructor() {
    super("outer");
    this.inner = new Error("inner");
    this.list = [1, 2];
  }
}

console.log(format("%j", new Error("boom")));
console.log(format("%j", new TypeError("boom")));
console.log(format("%j", new RangeError("out of range")));
console.log(format("%j", new Bare("boom")));
console.log(format("%j", new Fielded("boom")));
console.log(format("%j", new Wraps()));
console.log(format("%j", new Error("outer", { cause: new Error("inner") })));
console.log(format("%j %s", new Fielded("boom"), "trailing"));

// The receiver expression evaluates once, however many fields it prints.
let calls = 0;
function make(): Fielded {
  calls++;
  return new Fielded("made");
}
console.log(format("%j", make()));
console.log(`calls ${calls}`);
