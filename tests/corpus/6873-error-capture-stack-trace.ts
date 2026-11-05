// Error.captureStackTrace on errors, as Node does it: the error's stack
// becomes its heading and the current frames, starting at the function that
// called it; a constructor argument leaves out the frames up to and
// including that function's topmost call, and every frame when it is not on
// the stack. Error subclasses that call it with this.constructor (also
// through ?.) keep the frames from the code that ran `new`.
function frames(stack: string | undefined): string {
  const lines = (stack ?? "").split("\n");
  const wanted = ["inner", "middle", "outer", "makeExpired", "skipped", "caller"];
  const names = lines.slice(1).map((line) => line.trim().split(" ")[1] ?? "");
  return `${lines[0]} | ${names.filter((name) => wanted.includes(name)).join(",")}`;
}

function inner(target: Error): Error {
  Error.captureStackTrace(target);
  return target;
}
function middle(target: Error): Error {
  return inner(target);
}
function outer(target: Error): Error {
  return middle(target);
}
console.log("error", frames(outer(new Error("plain")).stack));
console.log("type error", frames(outer(new TypeError("typed")).stack));

function skipped(target: Error): Error {
  Error.captureStackTrace(target, skipped);
  return target;
}
function caller(target: Error): Error {
  return skipped(target);
}
console.log("constructorOpt", frames(caller(new Error("skip")).stack));
function unrelated(): void {}
const missing = new Error("missing");
Error.captureStackTrace(missing, unrelated);
console.log("not on the stack", JSON.stringify(missing.stack));

class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
    Error.captureStackTrace(this, this.constructor);
  }
}
class Expired extends AppError {
  constructor(message: string) {
    super(message);
    this.name = "Expired";
  }
}
class Optional extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Optional";
    Error.captureStackTrace?.(this, this.constructor);
  }
}
class Named extends Error {
  constructor(message: string) {
    super(message);
    Error.captureStackTrace(this, Named);
  }
}
function makeExpired(): Error {
  return new Expired("token expired");
}
const expired = makeExpired();
console.log("subclass", frames(expired.stack), expired instanceof AppError, expired.message);
console.log("optional call", frames(new Optional("maybe").stack));
console.log("class name", frames(new Named("named").stack));

const renamed = new RangeError("range");
renamed.name = "Custom";
Error.captureStackTrace(renamed);
console.log("renamed", frames(renamed.stack));
const late = new Error("late");
Error.captureStackTrace(late);
late.name = "Late";
console.log("renamed after", frames(late.stack));

Error.stackTraceLimit = 1;
console.log("limit", frames(outer(new Error("limited")).stack));
Error.stackTraceLimit = 0;
console.log("limit 0", JSON.stringify(outer(new Error("none")).stack));
Error.stackTraceLimit = 10;

// `this.constructor` in a constructor runs a `constructor` getter, and its
// exception propagates.
class Watched extends Error {
  constructor() {
    super("watched");
    Error.captureStackTrace(this, this.constructor);
  }
  get ["constructor"](): typeof Watched {
    console.log("constructor getter ran");
    return Watched;
  }
}
console.log("getter", typeof new Watched().stack);
class Throwing extends Error {
  constructor() {
    super("throwing");
    Error.captureStackTrace(this, this.constructor);
  }
  get ["constructor"](): typeof Throwing {
    throw new RangeError("constructor getter threw");
  }
}
try {
  new Throwing();
  console.log("getter did not throw");
} catch (e: any) {
  console.log("getter threw", e instanceof RangeError, e.message);
}
