// `new Error(message)` with a string message, or none, and no options: the
// error takes the typed constructor. What Node defines for such an error is
// pinned here from typed code: an own non-enumerable `message` (absent when
// no message is passed), no own `name` and no `cause`, the inherited name,
// the string form and the first line of the stack.
export {};

function probe(label: string, error: Error): void {
  console.log(label, error.name, JSON.stringify(error.message), error.toString(), String(error));
  console.log(
    " own",
    Object.prototype.hasOwnProperty.call(error, "message"),
    Object.prototype.hasOwnProperty.call(error, "name"),
    Object.prototype.hasOwnProperty.call(error, "cause"),
    Object.prototype.hasOwnProperty.call(error, "stack"),
    "in",
    "message" in error,
    "name" in error,
    "cause" in error,
  );
  console.log(" names", Object.getOwnPropertyNames(error).join(","), "cause", error.cause);
  console.log(" stack", (error.stack ?? "").split("\n")[0]);
  console.log(
    " class",
    error instanceof Error,
    error instanceof TypeError,
    error instanceof RangeError,
    Object.getPrototypeOf(error) === Error.prototype,
  );
}

const text = ["built", "at", "run", "time"].join(" ");
function label(n: number): string {
  return `item ${n}`;
}

probe("literal", new Error("literal message"));
probe("variable", new Error(text));
probe("template", new Error(`template ${text.length}`));
probe("concat", new Error("concat " + label(3)));
probe("call", new Error(label(4)));
probe("empty", new Error(""));
probe("absent", new Error());
probe("undefined", new Error(undefined));
probe("undefined options", new Error("undefined options", undefined));

probe("TypeError", new TypeError("type message"));
probe("RangeError", new RangeError("range message"));
probe("SyntaxError", new SyntaxError("syntax message"));
probe("ReferenceError", new ReferenceError("reference message"));
probe("EvalError", new EvalError("eval message"));
probe("URIError", new URIError("uri message"));
probe("TypeError absent", new TypeError());
probe("RangeError absent", new RangeError());

// The call form constructs the same way.
probe("Error()", Error("called"));
probe("Error() absent", Error());
probe("TypeError()", TypeError("called type"));

// Thrown and caught, the error is the object that was constructed.
function fail(n: number): number {
  if (n > 2) throw new RangeError(`too big: ${n}`);
  return n;
}
for (const n of [1, 5]) {
  try {
    console.log("ok", fail(n));
  } catch (error) {
    if (error instanceof RangeError) probe("caught", error);
    else console.log("unexpected");
  }
}

// Later writes act on the same properties.
const edited = new Error("first");
edited.message = "second";
edited.name = "Edited";
probe("edited", edited);
const filled = new Error();
filled.message = "filled";
probe("filled", filled);
