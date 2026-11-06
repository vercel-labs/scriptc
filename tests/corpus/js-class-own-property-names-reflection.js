"use strict";
// Object.getOwnPropertyNames on a class value reflects the constructor's
// live own-property table, and the prototype it reaches holds its own
// constructor and every declared member in declaration order.
class Box {
  constructor(n) {
    this.n = n;
  }
  double() {
    return this.n * 2;
  }
  get half() {
    return this.n / 2;
  }
  set half(value) {
    this.n = value * 2;
  }
}
console.log(Object.getOwnPropertyNames(Box).join(","));
const descriptor = Object.getOwnPropertyDescriptor(Box, "prototype");
const proto = descriptor.value;
console.log(
  "descriptor",
  typeof descriptor.value,
  descriptor.writable,
  descriptor.enumerable,
  descriptor.configurable,
);
console.log("identity", proto === Box.prototype, "constructor", proto.constructor === Box);
console.log(Object.getOwnPropertyNames(proto).join(","));
const show = (target, key) =>
  JSON.stringify(Object.getOwnPropertyDescriptor(target, key), (name, value) =>
    typeof value === "function" ? "function" : value,
  );
for (const key of ["constructor", "double", "half"]) console.log(key, show(proto, key));
console.log("length", show(Box, "length"), "name", show(Box, "name"));
const instance = new Box(3);
console.log("instance", instance.double(), instance.half);
instance.half = 5;
console.log("assigned", instance.n);
