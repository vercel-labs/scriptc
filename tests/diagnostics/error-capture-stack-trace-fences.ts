// Error.captureStackTrace gives a stack to errors and untyped objects; a
// typed object has no stack property to receive it, and a constructor
// argument other than a function declaration or the constructing class
// cannot be found on the stack.
interface Report {
  message: string;
}
const report: Report = { message: "typed" };
Error.captureStackTrace(report);

const arrow = (): void => {};
Error.captureStackTrace(new Error("arrow"), arrow);

class Other {}
class Wrapped extends Error {
  constructor() {
    super("wrapped");
    Error.captureStackTrace(this, Other);
  }
}
console.log(new Wrapped().stack);
