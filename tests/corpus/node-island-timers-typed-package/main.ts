// @requires-libnode
// A package that runs in a Node island and declares its timers: the program
// clears the island's timers and the island clears the program's.
import { cancel, cancelSoon, every, soon, start } from "timer-pkg";

cancel(setTimeout(() => console.log("NOT REACHED native timeout"), 10));
cancelSoon(setImmediate(() => console.log("NOT REACHED native immediate")));
let own = 0;
const mine = setInterval(() => {
  console.log(`native interval tick ${++own}`);
  if (own === 2) cancel(mine);
}, 100);

const t = start(10, "NOT REACHED island timeout");
clearTimeout(t);
const i = soon("NOT REACHED island immediate");
clearImmediate(i);
let ticks = 0;
const interval = every(150, () => {
  console.log(`island interval tick ${++ticks}`);
  if (ticks === 2) clearInterval(interval);
});
const kept = start(50, "fires");
console.log(`hasRef ${kept.hasRef()}`);
setTimeout(() => console.log("end"), 500);
