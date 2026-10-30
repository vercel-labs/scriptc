"use strict";
// Object.getPrototypeOf of an Error is Error.prototype, whose own prototype
// is Object.prototype: with or without a message, after its name is
// reassigned, and when it was thrown and caught.

const describe = (label, value) => {
  const proto = Object.getPrototypeOf(value);
  console.log(label, proto === Error.prototype, proto === Object.prototype, Object.getPrototypeOf(proto) === Object.prototype);
};

describe("message", new Error("boom"));
describe("empty", new Error());
const renamed = new Error("x");
renamed.name = "Custom";
describe("renamed", renamed);
const coded = new Error("y");
coded.code = "E_CODE";
describe("coded", coded);
try {
  throw new Error("thrown");
} catch (error) {
  describe("caught", error);
}

// Walks up the chain, as error serializers and type sniffers do.
/** @param {unknown} value */
function chainLength(value) {
  let length = 0;
  for (let current = Object.getPrototypeOf(value); current !== null; current = Object.getPrototypeOf(current)) length++;
  return length;
}
console.log(chainLength(new Error("a")), chainLength({}), chainLength([]));

/** @param {unknown} value */
function kind(value) {
  if (typeof value !== "object" || value === null) return typeof value;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return "plain";
  if (proto === Error.prototype) return "error";
  if (proto === Array.prototype) return "array";
  return "other";
}
const values = [new Error("e"), {}, Object.create(null), [], JSON.parse('{"a":1}'), "s"];
console.log(values.map(kind).join(","));
const proto = Object.getPrototypeOf(new Error("m"));
console.log(proto.name, JSON.stringify(proto.message), Object.prototype.hasOwnProperty.call(proto, "name"));

// After Object.setPrototypeOf, the prototype is the object that was set.
const custom = {};
const moved = Object.setPrototypeOf(new Error("moved"), custom);
console.log(Object.getPrototypeOf(moved) === custom, Object.getPrototypeOf(moved) === Error.prototype);
const named = { kind: "named" };
const movedNamed = new Error();
Object.setPrototypeOf(movedNamed, named);
console.log(Object.getPrototypeOf(movedNamed) === named, Object.getPrototypeOf(movedNamed).kind);
