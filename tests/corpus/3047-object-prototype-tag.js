console.log(
  Object.prototype.toString.call(),
  Object.prototype.toString.call(undefined),
  Object.prototype.toString.call(null),
  Object.prototype.toString.call(false),
  Object.prototype.toString.call(0),
  Object.prototype.toString.call("x"),
  Object.prototype.toString.call(2n),
  Object.prototype.toString.call(Symbol("x")),
);
console.log(
  Object.prototype.toString.call([]),
  Object.prototype.toString.call({ a: 1 }),
  Object.prototype.toString.call(/x/),
  Object.prototype.toString.call(new Date(0)),
  Object.prototype.toString.call(new Error("x")),
);
console.log(
  Object.prototype.toString.call(new Map([["x", 1]])),
  Object.prototype.toString.call(new Set([1])),
  Object.prototype.toString.call(new Uint8Array([1, 2])),
  Object.prototype.toString.call(function named() {}),
);
console.log(
  Object.prototype.toString.call(JSON.parse("null")),
  Object.prototype.toString.call(JSON.parse("[1]")),
  Object.prototype.toString.call(JSON.parse("{\"a\":1}")),
  Object.prototype.toString.call(JSON.parse("true")),
  Object.prototype.toString.call(JSON.parse("3")),
  Object.prototype.toString.call(JSON.parse('"text"')),
);
console.log(
  Object.prototype.toString.call(Object(9)),
  Object.prototype.toString.call(Object(Number(9))),
  Object.prototype.toString.call(new Number("9")),
  Object.prototype.toString.call(Object(new Number(9))),
  Object.prototype.toString.call(new Boolean(0)),
  Object.prototype.toString.call(new String(7)),
);
console.log(
  Object.prototype.toString.call(Object(null)),
  Object.prototype.toString.call(Object(undefined)),
  Object.prototype.toString.call(Object({ a: 1 })),
  Object.prototype.toString.call(new Object({ b: 2 })),
  Object.prototype.toString.call(new Object()),
  Object.prototype.toString.call(Object()),
  Object.prototype.toString.call(Array()),
  Object.prototype.toString.call(Object(Array())),
);
const order = [];
function receiver() { order.push("receiver"); return 1; }
function ignored() { order.push("ignored"); return 2; }
console.log(Object.prototype.toString.call(receiver(), ignored()), order.join(","));
try {
  Object.prototype.toString.call(receiver(), (() => { throw new Error("extra"); })());
} catch (error) {
  console.log(error.message, order.join(","));
}
const effects = [];
function tagValue() { effects.push("value"); return 9; }
function tagExtra() { effects.push("extra"); return 0; }
console.log(Object.prototype.toString.call(Object(tagValue(), tagExtra()), tagExtra()), effects.join(","));
