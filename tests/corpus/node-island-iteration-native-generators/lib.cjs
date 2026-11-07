"use strict";
const log = (s) => console.log(s);
exports.take = (iterable, n) => {
  const out = [];
  for (const v of iterable) {
    out.push(v);
    if (out.length === n) break;
  }
  return out.join(",");
};
exports.all = (iterable) => [...iterable].join(",");
exports.destructure = (iterable) => {
  const [a, b] = iterable;
  return `${a} ${b}`;
};
exports.from = (iterable) => Array.from(iterable, (v) => v * 2).join(",");
exports.manual = (it) => {
  const steps = [it.next(), it.next("sent"), it.return("early"), it.next()];
  return steps.map((r) => `${r.value}/${r.done}`).join(" ");
};
exports.throwInto = (it) => {
  it.next();
  const r = it.throw(new Error("island threw into the generator"));
  return `${r.value}/${r.done}`;
};
exports.describe = (it) =>
  [
    typeof it[Symbol.iterator],
    it[Symbol.iterator]() === it,
    typeof it.next,
    typeof it.return,
    typeof it.throw,
    Object.prototype.toString.call(it),
  ].join(" ");
exports.describeAsync = (it) =>
  [typeof it[Symbol.asyncIterator], it[Symbol.asyncIterator]() === it, typeof it.next].join(" ");
exports.takeAsync = async (iterable, n) => {
  const out = [];
  for await (const v of iterable) {
    out.push(v);
    if (out.length === n) break;
  }
  return out.join(",");
};
exports.awaitSync = async (iterable) => {
  const out = [];
  for await (const v of iterable) out.push(v);
  return out.join(",");
};
exports.yieldStar = function* (iterable) {
  log("island delegates");
  const result = yield* iterable;
  log(`island delegate returned ${result}`);
};
