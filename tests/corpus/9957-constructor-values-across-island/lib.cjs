"use strict";
// What an island sees of a value it is handed, and what it hands back.
exports.echo = (value) => value;
exports.isGlobal = (value, name) => value === globalThis[name];
exports.describe = (value) => typeof value + ":" + value.name + ":" + value.length;
exports.callWith = (f, x) => {
  const r = f(x);
  return typeof r + ":" + String(r);
};
exports.member = (holder, key) => holder[key];
exports.sameMember = (holder, key, name) => holder[key] === globalThis[name];
exports.wrap = (value) => ({ type: value, list: [value] });
exports.own = (name) => globalThis[name];
