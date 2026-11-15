// @tsc-emit
// With isolatedModules tsc does not inline a const enum across files: the
// enum is emitted as an object, a use of it keeps its import, and the
// declaring module is loaded even when nothing else of it is used.
import { Level } from "./levels.js";
import { Mode, describe } from "./modes.js";

function label(level: Level): string {
  return level === Level.High ? "high" : "low";
}

console.log("main", Level.Low, Level.High, label(Level.High));
console.log(describe(Mode.Fast), Mode.Slow);
