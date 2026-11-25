// The implicit global write islands this module under --node-islands=auto;
// the classes it requires stay native and cross as a shared module.
const lib = require("./lib.ts");

for (const [label, make] of [
  ["no-args", () => new lib.Coded()],
  ["message", () => new lib.Coded("boom")],
]) {
  const error = make();
  console.log(label, error.name, JSON.stringify(error.message), String(error));
  console.log("  native:", lib.inspect(error));
}
const tagged = new lib.Tagged("tagged");
console.log("tagged", JSON.stringify(tagged.message), String(tagged), lib.inspect(tagged));
console.log("class values", lib.Coded.name, lib.Tagged.name, typeof lib.Coded, typeof lib.Tagged);

undeclaredGlobal = 1;
