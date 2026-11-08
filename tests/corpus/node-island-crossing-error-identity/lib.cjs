"use strict";
const util = require("node:util");
exports.run = (fn) => fn();
exports.runAsync = async (fn) => await fn();
exports.each = (items, fn) => items.forEach(fn);
exports.rethrow = (fn) => {
  try {
    fn();
  } catch (e) {
    throw e;
  }
};
exports.wrap = (fn) => {
  try {
    fn();
  } catch (e) {
    throw new Error("island wrapper", { cause: e });
  }
};
let kept;
exports.keep = (e) => {
  kept = e;
};
exports.same = (e) => e === kept;
exports.read = (e) => `${e === kept} ${e.name}: ${e.message} | ${String(e.stack).split("\n")[0]} | ${e.code} | ${e.status}`;
exports.kept = () => kept;
exports.describe = (fn, Cls) => {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    const parts = [
      `name=${e.name}`,
      `message=${e.message}`,
      `str=${String(e)}`,
      `stack=${typeof e.stack}:${String(e.stack).split("\n")[0]}`,
      `is=${[Error, TypeError, RangeError, AggregateError].filter((C) => e instanceof C).map((C) => C.name).join("+")}`,
      `tag=${Object.prototype.toString.call(e)}`,
      `native=${util.types.isNativeError(e)}`,
    ];
    if (e.code !== undefined) parts.push(`code=${e.code}`);
    if (e.status !== undefined) parts.push(`status=${e.status}`);
    if ("cause" in e) parts.push(`cause=${e.cause instanceof Error ? e.cause.message : String(e.cause)}`);
    if (e.errors !== undefined) parts.push(`errors=${e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join(",")}`);
    parts.push(`keys=${Object.keys(e).join(",")}`);
    parts.push(`json=${JSON.stringify(e)}`);
    return parts.join(" ");
  }
};
// An island error class, thrown through native frames.
class IslandError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "IslandError";
    this.detail = detail;
  }
  where() {
    return `island ${this.detail}`;
  }
}
exports.IslandError = IslandError;
exports.make = (message, detail) => new IslandError(message, detail);
exports.throwing = (e) => () => {
  throw e;
};
exports.callAndCatch = (fn, original) => {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return `same=${e === original} ${e instanceof IslandError} ${e.detail} ${e.where()} ${String(e.stack).split("\n")[0]}`;
  }
};
