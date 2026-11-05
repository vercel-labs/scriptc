// The JavaScript consumer of static-ns (tests/harness/static-objects.test.ts
// compiles it with the shape overlay on).
const { ns } = require("static-ns");

console.log(ns.run());
let total = 0;
for (let i = 0; i < 100; i++) total += new ns.Point(i, i).moved(1).norm();
console.log(Math.round(total));
