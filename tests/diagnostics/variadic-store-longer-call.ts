// A variadic function stored under a fixed signature is called with the
// parameters that signature names. The store is refused when the program
// hands a function of that type to a caller that passes more arguments
// than the type names, where no look-through reaches the stored function:
// the stored function would not receive them.
import { EventEmitter } from "node:events";

function spell(): (...args: unknown[]) => string {
  return (...args: unknown[]): string => String(args.length);
}
function quiet(): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    console.log(args.length);
  };
}

// (1) A replacer receives the match, its offset and the subject.
const text: (s: string) => string = spell();
console.log("a1".replace("1", text));

// (2) An event listener receives the event's arguments.
const flag: (on: boolean) => void = quiet();
const emitter = new EventEmitter();
emitter.on("flag", flag);
emitter.emit("flag", true, 1);

// (3) A function expression that reads `arguments`, written for a
// signature that a wider one is then made from.
const empty: () => number = function () {
  return arguments.length;
};
const filled: (x: string) => number = empty;
console.log(filled("x"));

// (4) A typed rest function packed behind a fixed signature.
const packed: (a: string) => number = (...parts: string[]): number => parts.length;
console.log(["a"].map(packed).join(","));

// (5) A variadic function that reads `this`, stored under a type that does
// not show the read, in a program that hands a function of that type to a
// timer, which Node calls with the timer object as `this`.
const hidden: (flag: boolean, n: number) => void = function (
  this: unknown,
  ...args: unknown[]
): void {
  console.log(typeof this, args.length);
};
setTimeout(hidden, 0, true, 1);
