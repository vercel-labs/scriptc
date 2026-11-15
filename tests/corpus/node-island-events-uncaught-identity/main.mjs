// @requires-libnode
// What an uncaughtException listener receives when the listeners of both
// sides share one emitter: the native listener gets the native value that
// was thrown (the same error object, with its class, fields and methods; the
// same plain object; the primitive), also with an island listener ahead of
// it, and an island error with the properties island code gave it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
  describe() {
    return `${this.name}/${this.status}`;
  }
}

let thrown;
lib.install();
process.on("uncaughtException", (e, origin) => {
  if (e instanceof AppError) {
    log(`native: AppError same=${e === thrown} ${e.message} ${e.status} ${e.describe()} ${origin}`);
  } else if (e instanceof Error) {
    log(`native: ${e.name} same=${e === thrown} ${e.message} code=${e.code} status=${e.status}`);
  } else {
    log(`native: ${typeof e} same=${e === thrown} ${typeof e === "object" ? e.code : e}`);
  }
});

const steps = [
  () => {
    thrown = new AppError("typed failure", 418);
    throw thrown;
  },
  () => {
    thrown = new RangeError("out of range");
    throw thrown;
  },
  () => {
    thrown = { code: 5 };
    throw thrown;
  },
  () => {
    thrown = "text";
    throw thrown;
  },
  () => {
    thrown = 42;
    throw thrown;
  },
  () => {
    thrown = undefined;
    lib.throwSoon("island failure", "E_ISLAND", 503);
  },
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
