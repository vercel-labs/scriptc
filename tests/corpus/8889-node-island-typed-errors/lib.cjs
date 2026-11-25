"use strict";
const own = (error, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  if (!descriptor) return `${key}:none`;
  return `${key}:${typeof descriptor.value}${descriptor.enumerable ? " enumerable" : ""}`;
};
const describe = (error, properties) =>
  [
    error instanceof Error,
    error.name,
    JSON.stringify(error.message),
    String(error),
    ...properties.map((key) => own(error, key)),
    JSON.stringify(Object.keys(error)),
    JSON.stringify(error),
    typeof error.stack,
    String(error.stack).split("\n")[0],
  ].join(" | ");
exports.describe = (error) => describe(error, ["message", "name", "cause"]);
exports.describeBare = (error) => describe(error, ["name", "cause"]);
exports.caught = (run) => {
  try {
    run();
    return "no throw";
  } catch (error) {
    return exports.describe(error);
  }
};
exports.rethrow = (error) => {
  throw error;
};
