"use strict";
// Plain objects, functions and symbols an island makes, keeps and hands
// back.
const kept = new Map();
let last = null;

exports.make = (name) => (last = { name, fields: [] });
exports.last = () => last;
exports.same = (value) => value;
exports.holder = (name) => ({ name, child: { name: name + ".child" } });
exports.childOf = (holder) => holder.child;
exports.keep = (name) => {
  const value = { name };
  kept.set(name, value);
  return value;
};
exports.kept = (name) => kept.get(name);
exports.forget = (name) => kept.delete(name);
exports.describe = (value) => ({ of: value.name });
exports.owner = (value) => ({ owns: value });
exports.nameOf = (value) => value.name;
exports.fn = (name) => {
  const f = () => name;
  kept.set("fn:" + name, f);
  return f;
};
exports.symbol = (name) => Symbol(name);
exports.registered = (name) => Symbol.for(name);
