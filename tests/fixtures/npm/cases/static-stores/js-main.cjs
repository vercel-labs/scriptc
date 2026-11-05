// The JavaScript consumer of static-stores (main.ts is the TypeScript one).
const { lib, other } = require("static-stores");

let near = 0;
for (let i = 0; i < 20; i++) if (lib.near((i - 10) / 10)) near++;
console.log(near, lib.name(), lib.early, lib.after);
console.log(lib.counter.inc(), lib.counter.inc(), lib.twice(21), lib.tagOf.call({ tag: "t" }));
const key = process.argv.length > 99 ? "dbl" : "inc";
console.log(lib.apply("inc", 1), lib.apply("dbl", 4), lib.applyAny("dbl", 5), lib.applyAny(key, 3));
console.log(other.seen, other.check());
