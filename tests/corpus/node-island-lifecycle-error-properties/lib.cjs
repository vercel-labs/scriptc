"use strict";
class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
  retryable() {
    return this.status >= 500;
  }
}
exports.fail = (status) => {
  throw new HttpError(status, { reason: "nope" });
};
exports.failAsync = async (status) => {
  throw new HttpError(status, { reason: "later" });
};
exports.failCause = () => {
  throw new Error("outer", { cause: new HttpError(500, null) });
};
exports.failFs = () => require("node:fs").readFileSync("/nonexistent/x");
exports.failMany = () => {
  throw new AggregateError([new Error("a"), new Error("b")], "many");
};
