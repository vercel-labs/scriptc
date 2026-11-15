"use strict";
exports.answer = () => 42;
exports.echo = (value) => value;
// A native value the island keeps by reference: the export table is the
// island thread's, so only that thread may take the value back.
let kept = null;
exports.keep = (value) => {
  kept = value;
  return "kept";
};
exports.get = () => kept;
let keptFunction = null;
exports.keepFunction = (fn) => {
  keptFunction = fn;
  return "kept";
};
exports.getFunction = () => keptFunction;
// What a worker thread cannot pass to or take from the island (worker.ts):
// a function to call back, bytes and symbols either way, and an error of
// its own.
exports.callBack = (fn) => fn(1);
exports.byteLength = (bytes) => bytes.length;
exports.bytes = () => new Uint8Array(4);
exports.buffer = () => new ArrayBuffer(4);
exports.describe = (symbol) => symbol.description;
exports.symbol = () => Symbol("island");
exports.errorName = (error) => error.name;
// A thenable that is not a promise, and an object without a `then`.
exports.thenable = () => ({ then: (resolve) => resolve(7) });
exports.plain = () => ({ answer: 42 });
// The module's own state: one instance for every thread of the program.
let counted = 0;
exports.count = () => ++counted;
// An error whose message cannot be read.
exports.unreadable = () => {
  const error = new Error();
  Object.defineProperty(error, "message", {
    get() {
      throw Symbol("message");
    },
  });
  throw error;
};
// A fork without an execPath of its own: in a program it would start the
// program again.
exports.forkSelf = () => {
  try {
    require("node:child_process").fork(__filename);
    return "forked";
  } catch (error) {
    return error.message;
  }
};
