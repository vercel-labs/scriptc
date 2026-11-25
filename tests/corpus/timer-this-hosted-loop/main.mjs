// @requires-libnode
// A timer callback keeps its handle as `this` after an island has moved
// the program onto Node's loop: the runtime's own timer entry and a timer
// armed on the hosted loop bind the same handle, so clearInterval(this)
// stops an interval, a held handle matches the receiver, and the adapted
// callback signatures still see it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
console.log("island", lib.twice(21));

const seen = [];
let ticks = 0;
const interval = setInterval(function () {
  ticks++;
  if (ticks === 2) clearInterval(this);
  // A bounded run: a receiver that is not the handle would leave the
  // interval firing, and the handle the call returned stops it here.
  if (ticks === 5) clearInterval(interval);
  seen.push(["interval", this === interval]);
}, 1);
const timeout = setTimeout(function (x) {
  seen.push(["timeout", this === timeout, x === undefined]);
}, 2);
const immediate = setImmediate(function (x = this) {
  seen.push(["immediate", x === immediate]);
});
const returning = setTimeout(function () {
  seen.push(["returning", this === returning]);
  return 1;
}, 2);

setTimeout(function () {
  for (const entry of seen.map((e) => e.join(" ")).sort()) console.log(entry);
  console.log("ticks", ticks);
}, 30);
