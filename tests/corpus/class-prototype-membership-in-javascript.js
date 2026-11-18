// `name in C.prototype` in JavaScript, the feature test a browser test
// harness runs before anything else, over a class hierarchy.
class Node0 {
  constructor(tag) {
    this.tag = tag;
  }
  cloneNode() {
    return new this.constructor(this.tag);
  }
}
class Element0 extends Node0 {
  animate() {
    return "animating " + this.tag;
  }
}
class Unknown0 extends Element0 {}

function isSupported() {
  return "animate" in Element0.prototype;
}
console.log(isSupported(), "animate" in Node0.prototype, "cloneNode" in Unknown0.prototype);
const node = new Unknown0("hi");
const clone = node.cloneNode();
console.log(
  Unknown0.prototype.isPrototypeOf(clone),
  Element0.prototype.isPrototypeOf(clone),
  Object.getPrototypeOf(clone) === Unknown0.prototype,
  clone.animate(),
);
const proto = Object.create(Element0.prototype);
console.log(Element0.prototype.isPrototypeOf(proto), proto.isPrototypeOf(clone), "animate" in proto);
