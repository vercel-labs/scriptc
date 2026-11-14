// process.title's setter runs ToString on the assigned value: numbers,
// booleans, null and undefined write their text, an array joins with
// commas, and an object with its own toString writes what that method
// answers — a throw from it propagates and leaves the previous title. A
// symbol throws "Cannot convert a Symbol value to a string".
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
report("number", () => {
  process.title = 123;
  return process.title;
});
report("array", () => {
  process.title = [1, [2, 3]];
  return process.title;
});
report("boolean", () => {
  process.title = true;
  return process.title;
});
report("null", () => {
  process.title = null;
  return process.title;
});
report("undefined", () => {
  process.title = undefined;
  return process.title;
});
const symbol = /** @type {any} */ (Symbol("t"));
report("symbol", () => {
  process.title = symbol;
  return process.title;
});
report("object", () => {
  process.title = { toString: () => "custom-title" };
  return process.title;
});
report("throwing", () => {
  process.title = {
    toString() {
      throw new Error("title failed");
    },
  };
  return process.title;
});
report("numeric string", () => {
  process.title = "0x10";
  return process.title;
});
