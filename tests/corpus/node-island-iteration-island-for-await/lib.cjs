"use strict";
const log = (s) => console.log(s);
exports.consume = async (iterable, stopAt) => {
  const seen = [];
  for await (const v of iterable) {
    log(`island got ${v}`);
    seen.push(v);
    if (v === stopAt) break;
  }
  return seen.join(",");
};
exports.consumeThrow = async (iterable, at) => {
  try {
    for await (const v of iterable) {
      if (v === at) throw new Error(`island threw at ${v}`);
    }
  } catch (e) {
    return `island caught: ${e.message}`;
  }
  return "island finished";
};
exports.manual = async (it) => {
  const a = await it.next();
  const b = await it.next("sent");
  const c = await it.return("early");
  const d = await it.next();
  return JSON.stringify([a, b, c, d]);
};
exports.consumeSync = (iterable) => {
  const out = [];
  for (const v of iterable) {
    out.push(v);
    if (v === 2) break;
  }
  return out.join(",");
};
