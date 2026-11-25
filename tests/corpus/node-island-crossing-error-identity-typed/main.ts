// @requires-libnode
// A typed native error class thrown from a native callback that island
// code invoked: the catch in native code gets the same instance, with its
// class and typed fields, and island code that catches it reads them.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

class ValidationError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
  retryable(): boolean {
    return this.status >= 500;
  }
}

const original = new ValidationError("bad input", 422);
const stack = original.stack;

function report(label: string, e: unknown): void {
  if (e instanceof ValidationError) {
    console.log(label, e === original, e.status, e.name, e.retryable(), e.stack === stack);
  } else {
    console.log(label, "not a ValidationError", e instanceof Error, String(e));
  }
}

try {
  lib.run((): void => {
    throw original;
  });
} catch (e) {
  report("sync", e);
}
try {
  await lib.runAsync(async (): Promise<void> => {
    throw original;
  });
} catch (e) {
  report("async", e);
}
try {
  lib.run((): void => lib.rethrow((): void => {
    throw original;
  }));
} catch (e) {
  report("twice", e);
}
try {
  lib.wrap((): void => {
    throw original;
  });
} catch (e) {
  const wrapper: any = e;
  console.log("wrapped", wrapper.message, wrapper.cause === original);
  report("cause", wrapper.cause);
}
try {
  lib.run((): void => {
    throw new TypeError("typed type error", { cause: original });
  });
} catch (e) {
  console.log("type error", e instanceof TypeError, (e as Error).message, (e as Error).cause === original);
}
console.log("island reads", lib.read((): void => {
  throw new ValidationError("seen by island", 503);
}));
console.log("island reads", lib.read((): void => {
  throw new TypeError("typed", { cause: new Error("inner") });
}));
