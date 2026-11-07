"use strict";
const util = require("node:util");

let last;
let held;

exports.describe = (p) => [
  `tag ${Object.prototype.toString.call(p)} ${p instanceof URLSearchParams}`,
  `proto ${Object.getPrototypeOf(p) === URLSearchParams.prototype} ${p.constructor === URLSearchParams}`,
  `brand ${URLSearchParams.prototype.toString.call(p)} ${URLSearchParams.prototype.get.call(p, "b")}`,
  `read ${p.get("a")} ${p.getAll("b")} ${p.has("a")} ${p.has("zz")} ${p.size}`,
  `entries ${JSON.stringify([...p])} ${[...p.keys()]} ${[...p.values()]}`,
  `inspect ${util.inspect(p)}`,
  `as a body ${new Request("http://example.test/", { method: "POST", body: p }).headers.get("content-type")}`,
];
exports.keep = (p) => {
  const same = last === p;
  last = p;
  return same;
};
exports.back = (p) => p;
exports.write = (p, method, a, b) => {
  if (method === "sort") p.sort();
  else if (method === "delete") p.delete(a);
  else p[method](a, b);
};
exports.text = (p) => p.toString();
exports.hold = (p) => {
  held = p;
};
exports.heldText = () => held.toString();
exports.keepParams = (p) => {
  last = p;
  return p.toString();
};
exports.isParamsOf = (url, p) => url.searchParams === p;
exports.href = (url) => url.href;
