"use strict";
const timersPromises = require("node:timers/promises");
const log = (s) => console.log(s);
exports.sleep = (ms, value) => timersPromises.setTimeout(ms, value);
exports.soon = (value) => timersPromises.setImmediate(value);
exports.abortable = (ms) => {
  const controller = new AbortController();
  const promise = timersPromises.setTimeout(ms, "NOT REACHED", { signal: controller.signal });
  return { promise, abort: () => controller.abort() };
};
exports.awaitNative = async (promise, label) => {
  const value = await promise;
  log(`island awaited ${label}: ${value}`);
  return `island saw ${value}`;
};
exports.ticks = async (ms, n) => {
  const seen = [];
  for await (const value of timersPromises.setInterval(ms, "tick")) {
    seen.push(value);
    if (seen.length === n) break;
  }
  return seen.join(",");
};
