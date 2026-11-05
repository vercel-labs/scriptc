// listeners() and rawListeners() of an event registered only under computed
// names: no literal emit or listener fixes its arguments, so each returned
// listener takes every argument a call passes, as in Node.
import { EventEmitter } from "node:events";
const ee = new EventEmitter();
const keys = ["a", "b"];
for (const k of keys) ee.on(`evt:${k}`, (x: number, y: number) => console.log("listener", k, x, y));
function run(): void {
  const fns = ee.listeners("evt:a");
  console.log("count", fns.length);
  fns[0]!(1, 2);
  const typed = ee.listeners("evt:b") as Array<(x: number, y: number) => void>;
  typed[0]!(3, 4);
  for (const fn of ee.rawListeners("evt:a")) fn(5, 6);
  console.log("same", fns[0] === ee.listeners("evt:a")[0]);
}
run();
