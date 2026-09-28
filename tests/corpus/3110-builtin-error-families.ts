export {};

class ChildReferenceError extends ReferenceError {}
class ChildEvalError extends EvalError {}
class ChildURIError extends URIError {}

function report(label: string, error: Error): void {
  console.log(label, error.name, JSON.stringify(error.message), error instanceof Error,
    error instanceof ReferenceError, error instanceof EvalError, error instanceof URIError,
    "cause" in error, error.cause);
}

report("reference", new ReferenceError("missing", { cause: "source" }));
report("eval", new EvalError("eval"));
report("uri", new URIError("uri"));
report("child reference", new ChildReferenceError("child"));
report("child eval", new ChildEvalError("child"));
report("child uri", new ChildURIError("child"));
report("child cause", new ChildReferenceError("present", { cause: undefined }));

try {
  throw new ReferenceError("caught");
} catch (error) {
  console.log("caught reference", error instanceof ReferenceError, error instanceof Error);
}

const boxed: unknown = new URIError("boxed");
console.log("boxed uri", boxed instanceof URIError, boxed instanceof Error);

declare const MISSING_CONSTANT: number;
try {
  console.log(MISSING_CONSTANT);
} catch (error) {
  console.log("missing name", error instanceof ReferenceError, error instanceof Error);
}
