// @requires-libnode
// Island loads written in the part of a statement that always runs: the
// condition of a loop, a `for`'s initializer, the first pass of a `do` body,
// the first test of a switch, the operand of a throw. Every step package
// appends its letter to one global when it loads and exports what the global
// held before, so each load shows which loads ran ahead of it. The build
// records a deferred module's snapshot in one probe process, in the order
// the program evaluates the loads: a load in one of these positions that the
// order left out was probed after the last one, and the modules after it
// exported a history Node never produces.
let n = 0;

while (require("step-a").n > 0 && n < 1) n++;

for (let i = require("step-b").n; i < 0; i++) n += 100;

for (let i = 0; require("step-c").n > 0 && i < 1; i++) n++;

do {
  n += require("step-d").n;
} while (n < 0);

do {
  n++;
} while (require("step-e").n < 0);

switch (n > 0) {
  case require("step-f").n > 0:
    n++;
    break;
  default:
    n += 100;
}

try {
  throw require("step-g").n;
} catch (e) {
  n += e;
}

const last = require("step-h");

console.log("n:", n);
console.log("a saw:", JSON.stringify(require("step-a").seen));
console.log("b saw:", JSON.stringify(require("step-b").seen));
console.log("c saw:", JSON.stringify(require("step-c").seen));
console.log("d saw:", JSON.stringify(require("step-d").seen));
console.log("e saw:", JSON.stringify(require("step-e").seen));
console.log("f saw:", JSON.stringify(require("step-f").seen));
console.log("g saw:", JSON.stringify(require("step-g").seen));
console.log("h saw:", JSON.stringify(last.seen));
