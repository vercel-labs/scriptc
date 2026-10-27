"use strict";
// Runtime computed keys in object patterns over JavaScript values: the
// live property is read, undefined when absent, including nested patterns
// over a typed module object (`const { signals: { [name]: n } } = os.constants`).
const os = require("os");
const table = [
  { name: "SIGINT", number: 2 },
  { name: "SIGTERM", number: 15 },
  { name: "SIGNOPE", number: 99 },
];
function resolve({ name, number: fallback }) {
  const {
    signals: { [name]: constant },
  } = os.constants;
  const supported = constant !== undefined;
  return `${name}:${supported}:${supported ? constant : fallback}`;
}
console.log(table.map(resolve).join(" "));

function lookup(source, field) {
  const { [field]: value = "none", [`${field}Count`]: count } = source;
  return `${field}=${value}/${count}`;
}
const record = { color: "red", colorCount: 3, size: 4 };
console.log(lookup(record, "color"), lookup(record, "size"), lookup(record, "shape"));

// A nullish source throws before a runtime first key is evaluated.
let keyCalls = 0;
function keyOf(name) {
  keyCalls++;
  return name;
}
const nothing = () => JSON.parse("null");
const flag = process.argv.length > 99;
for (const attempt of [
  () => {
    const { [keyOf("a")]: v } = nothing();
    return v;
  },
  () => {
    const { [keyOf("a")]: v = 1 } = flag ? nothing() : undefined;
    return v;
  },
  () => {
    const { a: { [keyOf("b")]: v } } = JSON.parse('{"a":null}');
    return v;
  },
]) {
  try {
    attempt();
  } catch (e) {
    console.log(e instanceof TypeError, keyCalls);
  }
}
try {
  const { [keyOf("a")]: v } = nothing();
  console.log(v);
} catch (e) {
  console.log(e.message, keyCalls);
}
