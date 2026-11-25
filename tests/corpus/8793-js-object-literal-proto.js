// Object-literal `__proto__` with any value. An object or function value
// becomes the new object's [[Prototype]]; every other value is skipped —
// no TypeError (unlike Object.setPrototypeOf) and no own "__proto__"
// property. A computed `["__proto__"]` key and the shorthand `{ __proto__ }`
// stay ordinary own properties, and the value evaluates exactly once, in
// source order.

function tag(label, value) {
  order.push(label);
  return value;
}

const base = {
  greet() {
    return "hello " + this.name;
  },
  shared: 1,
};
const fnProto = function named() {};

const order = [];

function describe(value) {
  const o = { __proto__: value, k: 1 };
  const proto = Object.getPrototypeOf(o);
  return [
    proto === Object.prototype ? "Object.prototype" : proto === null ? "null" : "custom",
    Object.prototype.hasOwnProperty.call(o, "__proto__"),
    Object.keys(o).join(","),
  ].join(" ");
}

console.log("number", describe(5));
console.log("float", describe(1.5));
console.log("string", describe("s"));
console.log("true", describe(true));
console.log("undefined", describe(undefined));
console.log("symbol", describe(Symbol("s")));
console.log("bigint", describe(5n));

const nullProto = { __proto__: null, only: 1 };
console.log(
  "null",
  Object.getPrototypeOf(nullProto),
  Object.prototype.hasOwnProperty.call(nullProto, "__proto__"),
  Object.keys(nullProto).join(","),
  "toString" in nullProto,
);

const child = { name: "child", __proto__: base };
console.log("object", Object.getPrototypeOf(child) === base, child.greet(), child.shared);
console.log("own", Object.prototype.hasOwnProperty.call(child, "greet"), Object.keys(child).join(","));

const grandchild = { __proto__: child };
console.log("chain", grandchild.greet(), grandchild.shared, Object.keys(grandchild).length);

const fromFunction = { __proto__: fnProto, n: 2 };
console.log(
  "function",
  Object.getPrototypeOf(fromFunction) === fnProto,
  typeof fnProto,
  Object.keys(fromFunction).join(","),
);

const inline = { __proto__: { sole: "inline" } };
console.log("inline", inline.sole, "sole" in inline, Object.keys(inline).join(","));

const computedKey = "__proto__";
const viaComputed = { [computedKey]: base };
console.log(
  "computed",
  Object.getPrototypeOf(viaComputed) === Object.prototype,
  Object.prototype.hasOwnProperty.call(viaComputed, "__proto__"),
  viaComputed.__proto__ === base,
);

function shorthand() {
  const __proto__ = base;
  return { __proto__ };
}
const viaShorthand = shorthand();
console.log(
  "shorthand",
  Object.getPrototypeOf(viaShorthand) === Object.prototype,
  Object.prototype.hasOwnProperty.call(viaShorthand, "__proto__"),
  viaShorthand.__proto__ === base,
);

const ordered = {
  a: tag("a", 1),
  __proto__: tag("proto", base),
  b: tag("b", 2),
};
console.log("order", order.join(","), Object.getPrototypeOf(ordered) === base, ordered.b);

let calls = 0;
function once(value) {
  calls += 1;
  return value;
}
const counted = { __proto__: once(base) };
const countedPrimitive = { __proto__: once(7) };
console.log(
  "once",
  calls,
  Object.getPrototypeOf(counted) === base,
  Object.getPrototypeOf(countedPrimitive) === Object.prototype,
);

const replaced = { __proto__: base, m: 1 };
Object.setPrototypeOf(replaced, null);
console.log("setPrototypeOf", Object.getPrototypeOf(replaced), Object.keys(replaced).join(","));
