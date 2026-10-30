// %Set.prototype%: Object.getPrototypeOf(new Set()) answers it, and it
// carries Symbol.toStringTag and the size accessor with Node's attributes.
const prototype = Object.getPrototypeOf(new Set());
console.log("is Set.prototype", prototype === Set.prototype);
console.log("tag", prototype[Symbol.toStringTag]);
const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
console.log("tag descriptor", JSON.stringify([tag.value, tag.writable, tag.enumerable, tag.configurable]));
const size = Object.getOwnPropertyDescriptor(prototype, "size");
console.log(
  "size descriptor",
  JSON.stringify([typeof size.get, size.set === undefined, size.enumerable, size.configurable]),
);
console.log("toString", Object.prototype.toString.call(new Set()));
console.log("prototype string", `${prototype}`);
console.log("values descriptor", (() => {
  const values = Object.getOwnPropertyDescriptor(prototype, "values");
  return JSON.stringify([values.writable, values.enumerable, values.configurable]);
})());
console.log("union descriptor", (() => {
  const union = Object.getOwnPropertyDescriptor(prototype, "union");
  return JSON.stringify([union.writable, union.enumerable, union.configurable, union.value.name]);
})());
console.log("has own tag", Object.prototype.hasOwnProperty.call(prototype, Symbol.toStringTag));
console.log("proto of prototype", Object.getPrototypeOf(prototype) === Object.prototype);
console.log("getter brand", (() => {
  try {
    return prototype.size;
  } catch (error) {
    return error.name;
  }
})());
