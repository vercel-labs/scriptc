// @disallow-code-generation
// `f.constructor` on a function value is the Function constructor itself
// (Node's Function.prototype.constructor), so calling it answers Node's
// EvalError under --disallow-code-generation-from-strings, and the receiver
// evaluates before the arguments. A function the program gives its own
// `constructor` property keeps that value instead (9412 pins the untyped
// case).
function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no throw");
  } catch (error) {
    console.log(label, (error as Error).name + ": " + (error as Error).message);
  }
}

const expression = function () {
  return 1;
};
const arrow = () => 2;
function declaration() {
  return 3;
}
class Example {
  method() {
    return 4;
  }
}
const instance = new Example();

report("function expression", () => {
  expression.constructor("return 1");
});
report("arrow", () => {
  arrow.constructor("return 1");
});
report("declaration", () => {
  declaration.constructor("return 1");
});
report("class", () => {
  Example.constructor("return 1");
});
report("method", () => {
  instance.method.constructor("return 1");
});
report("bound", () => {
  expression.bind(null).constructor("return 1");
});
report("element access", () => {
  expression["constructor"]("return 1");
});

// A callable return type cannot hide the function's own `constructor`
// property: the value answers the read.
function make(): () => number {
  const made = () => 1;
  made.constructor = () => 2;
  return made;
}
report("own constructor", () => {
  console.log(make().constructor());
});

// A nullish receiver throws the property-read TypeError before any
// argument runs.
const absent: (() => number) | undefined = undefined;
const nothing: (() => number) | null = null;
const skipped: string[] = [];
function recorded(tag: string): string {
  skipped.push(tag);
  return "return 5";
}
report("undefined receiver", () => {
  absent!.constructor(recorded("never"));
});
report("null receiver", () => {
  nothing!.constructor(recorded("never"));
});
console.log(skipped.join(","));

// The receiver is read first, then the arguments, in order.
const order: string[] = [];
function receiver(): () => number {
  order.push("receiver");
  return () => 1;
}
function argument(tag: string): string {
  order.push(tag);
  return "return 2";
}
report("evaluation order", () => {
  receiver().constructor(argument("first"), argument("second"));
});
console.log(order.join(","));
