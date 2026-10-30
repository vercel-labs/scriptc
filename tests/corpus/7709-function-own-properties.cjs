// Function values with own properties: inspect shows their own name and
// enumerable members.
const util = require("node:util");

function named() {}
named.x = 1;
named.list = [1, 2];
console.log(named);

const dep = util.deprecate(function inner(a, b) {}, "unused");
dep.y = 2;
console.log(dep, Object.keys(dep));
/** @type {any} */
const held = dep;
console.log({ g: held }, [held]);
console.log({ a: { b: { c: { f: held } } } });
Object.defineProperty(dep, "name", { value: "renamed" });
Object.defineProperty(dep, "hidden", { value: 3, enumerable: false });
console.log(dep, util.inspect(held, { compact: false }));

const plain = util.callbackify(async () => 1);
console.log(plain);
