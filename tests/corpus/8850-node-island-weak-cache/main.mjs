// @requires-libnode
// A cache keyed by objects an island made, in a native WeakMap: one
// compiled validator per schema object, each validator an island object
// that reaches its schema.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

const cache = new WeakMap();
let compiled = 0;

function validatorFor(schema) {
  let validator = cache.get(schema);
  if (validator === undefined) {
    compiled++;
    validator = lib.compile(schema);
    cache.set(schema, validator);
  }
  return validator;
}

const first = lib.make("first");
const second = lib.make("second");
console.log(validatorFor(first).of, validatorFor(first).check({}), validatorFor(second).of, compiled);
console.log(cache.has(first), cache.has({}), cache.delete(second), cache.has(second));
console.log(validatorFor(first) === validatorFor(first), validatorFor(first).schema === first, compiled);

// Every call of a tool looks its validator up again.
const tools = [];
for (let i = 0; i < 40; i++) tools.push(lib.make("tool" + i));
let checks = 0;
for (let round = 0; round < 50; round++) {
  for (const tool of tools) if (validatorFor(tool).check({ round })) checks++;
}
console.log(checks, compiled);
