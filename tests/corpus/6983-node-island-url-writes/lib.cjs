"use strict";
let held;
let heldParams;

exports.set = (u, part, value) => {
  u[part] = value;
  return u[part];
};
exports.href = (u) => u.href;
exports.params = (u, method, a, b) => {
  if (method === "sort") u.searchParams.sort();
  else if (method === "delete") u.searchParams.delete(a);
  else u.searchParams[method](a, b);
};
exports.hold = (u) => {
  held = u;
};
exports.heldHref = () => held.href;
exports.heldSearch = () => `${held.search}|${held.searchParams}`;
exports.holdParams = (u) => {
  heldParams = u.searchParams;
};
exports.heldParams = () => heldParams.toString();
exports.appendHeld = (name, value) => heldParams.append(name, value);
