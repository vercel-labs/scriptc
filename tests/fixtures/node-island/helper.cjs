"use strict";
exports.answer = () => 42;
exports.echo = (value) => value;
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
