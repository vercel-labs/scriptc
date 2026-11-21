// Every use of a binding of the CommonJS `module` object answers Node's
// Module object: String and template conversions, loose and strict
// comparisons, call arguments, returns, closure captures and member reads.
require("./child.cjs");
const held = module;

console.log("string", String(held));
console.log("template", `${held}`);
console.log("loose", held == module, held != require.main);
console.log("strict", held === module, held !== module.children[0]);
console.log("typeof", typeof held);

function identity(value) {
  return value === module;
}
console.log("argument", identity(held), identity(require.main));

const returned = (() => held)();
console.log("return", returned === module, typeof returned);

function give() {
  return held;
}
const given = give();
console.log("given", given === module, typeof given);

function capture() {
  const read = () => held.id;
  return read() === module.id;
}
console.log("capture", capture());

console.log("member", held.id.length > 0, held.children.length, held.loaded);
console.log("path", typeof held.filename, Array.isArray(held.paths));
