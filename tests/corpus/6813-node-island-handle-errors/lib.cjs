"use strict";
class NotFound extends Error {
  constructor(what) {
    super(`${what} not found`);
    this.name = "NotFound";
    this.code = "E_NOT_FOUND";
  }
}
let last;
exports.NotFound = NotFound;
exports.fail = (kind) => {
  if (kind === "type") {
    const e = new TypeError("bad type");
    e.code = "ERR_BAD";
    last = e;
    throw e;
  }
  if (kind === "range") throw (last = new RangeError("out of range"));
  if (kind === "custom") throw (last = new NotFound("thing"));
  if (kind === "string") throw "just a string";
  if (kind === "object") throw (last = { reason: "plain object" });
  return "no throw";
};
exports.isLast = (e) => e === last;
exports.inspectError = (e) =>
  `${e instanceof Error} ${e.constructor.name} ${e.name} ${JSON.stringify(e.message)} ${e.code} ${typeof e.stack}`;
exports.rethrow = (e) => {
  throw e;
};
exports.call = (o, m) => o[m]();
