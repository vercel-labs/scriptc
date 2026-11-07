// A computed property key that holds a constant string names the anonymous
// definition it initializes: V8 evaluates the key, then SetFunctionName gives
// the definition that string. The name stays with the function, so a read
// through a binding, a destructured name or a class field reports it.

const key = "quoted";
const aliasKey = "throughAlias";
const numeric = 7;

const table = {
  [key]: function () {},
  [aliasKey]: () => {},
  ["literal"]: function () {},
  ["named"]: function inner() {},
  [numeric]: function () {},
};

const holder = { [key]: function () {} };
const methods = {
  [key]() {},
};
const held = holder.quoted;
const { throughAlias } = table;

class FieldHolder {
  [key] = function () {};
}

function label(value) {
  return value.name === "" ? "<anonymous>" : value.name;
}

console.log("const key", label(table.quoted));
console.log("const alias key", label(throughAlias));
console.log("const numeric key", label(table[numeric]));
console.log("literal keys", label(table.literal), label(table.named));
console.log("const key method", label(methods.quoted));
console.log("read alias", label(held));
console.log("field", label(new FieldHolder().quoted));
