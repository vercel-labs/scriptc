// console.log/console.error of Error subclass instances: the class fields
// print beside the message the way Node renders them, a declared `cause`
// prints under the message instead of being lost to the fields, an Error
// passed as another's cause prints as an error, a cycle stops where Node
// stops, and untyped fields added after construction still print.
// Error.stackTraceLimit = 0 keeps the stack frames out of the comparison.

Error.stackTraceLimit = 0;

class Retried extends Error {
  override cause: unknown = "first attempt";
  retries = 2;
}
class Coded extends Error {
  code = "E_CODE";
}
class Plain extends Error {
  detail = "d";
}

console.log(new Retried("failed"));
console.log(new Coded("bad"));
console.log(new Plain("plain"));
console.error(new Coded("to stderr"));

const cause = new Coded("inner");
const outer = new Error("outer", { cause });
console.log(outer);
console.log(outer.cause);

const withCause = new Retried("outer", { cause: new Plain("inner") });
console.log(withCause);

const cyclic: any = new Error("loop");
cyclic.cause = cyclic;
console.log(cyclic);

const bag: any = new Error("bag");
bag.extra = 1;
bag.flag = true;
console.log(bag);
