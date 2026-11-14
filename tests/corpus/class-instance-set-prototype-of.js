// Object.setPrototypeOf on a class instance: the instance keeps the
// prototype it was given for as long as it lives, so getPrototypeOf,
// isPrototypeOf, instanceof, `in` and its method calls all go through it,
// as in Node. Other instances of the class keep their class's prototype.
class Node0 {
  constructor(tag) {
    this.tag = tag;
  }
  cloneNode(deep) {
    return new Unknown0(this.tag + (deep ? "+" : ""));
  }
  hello() {
    return "node hello";
  }
}
class Element0 extends Node0 {
  animate() {
    return "animating " + this.tag;
  }
}
class Unknown0 extends Element0 {
  kind() {
    return "unknown";
  }
  hello() {
    return "unknown hello";
  }
}

const proto = Object.create(Element0.prototype);
const node = new Unknown0("hi");
const other = new Unknown0("other");
Object.setPrototypeOf(node, proto);
console.log(
  proto.isPrototypeOf(node),
  Object.getPrototypeOf(node) === proto,
  Element0.prototype.isPrototypeOf(node),
  Unknown0.prototype.isPrototypeOf(node),
);
console.log(node instanceof Element0, node instanceof Unknown0, node.animate(), node.hello(), node.tag);
console.log(typeof node.kind, "kind" in node, "animate" in node);
try {
  node.kind();
} catch (error) {
  console.log("not a function:", error instanceof TypeError);
}

// A clone is a new instance with its class's prototype.
const clone = node.cloneNode();
const deep = node.cloneNode(true);
console.log(proto.isPrototypeOf(clone), Unknown0.prototype.isPrototypeOf(clone), clone instanceof Unknown0);
console.log(proto.isPrototypeOf(deep), deep.tag, deep.kind(), deep.hello());

// Instances the program never reprototyped are untouched.
console.log(Object.getPrototypeOf(other) === Unknown0.prototype, other instanceof Unknown0, other.kind());

// Back to its class's prototype, then to null.
Object.setPrototypeOf(node, Unknown0.prototype);
console.log(proto.isPrototypeOf(node), Object.getPrototypeOf(node) === Unknown0.prototype, node.kind(), node.hello());
Object.setPrototypeOf(node, null);
console.log(Object.getPrototypeOf(node), node instanceof Node0, "hello" in node);

// Many short-lived instances: each one's prototype goes with it.
let seen = 0;
for (let i = 0; i < 200; i++) {
  const temporary = new Unknown0("t" + i);
  if (i % 2 === 0) Object.setPrototypeOf(temporary, proto);
  else Object.setPrototypeOf(temporary, Node0.prototype);
  if (temporary instanceof Element0) seen++;
}
const fresh = new Unknown0("fresh");
console.log(seen, Object.getPrototypeOf(fresh) === Unknown0.prototype, fresh.kind());
