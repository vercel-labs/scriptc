// A JavaScript package function compiled for a tuple argument. `Enum` takes
// an array of values or an object whose values are the enum's; its object
// branch reads the argument's own property names and indexes it by them. An
// array never takes that branch, but the branch is compiled for the tuple:
// Object.getOwnPropertyNames of a tuple lists its indices and "length", and
// a tuple read by a name answers the element, the length, or undefined.
import { Enum, Guard, Named } from "enum-kit";

const LEVELS = ["low", "high"] as const;
const SIZES = ["s", "m", "l"] as const;
console.log(JSON.stringify(Enum(LEVELS)), JSON.stringify(Enum(SIZES)));
console.log(JSON.stringify(Enum({ A: "a", B: "b", 7: "seven" })));
console.log(JSON.stringify(Guard.Keys(LEVELS)), JSON.stringify(Guard.Keys(SIZES)));
console.log(JSON.stringify(Guard.Keys({ x: 1, y: 2 })), Guard.IsObjectNotArray(LEVELS));
console.log(Named(LEVELS, "1"), Named(LEVELS, "length"), Named(LEVELS, "missing"), Named(SIZES, "2"));
console.log(Named({ k: "v" }, "k"));

// The same reflection in typed code.
console.log(Object.getOwnPropertyNames(LEVELS).join(), Object.getOwnPropertyNames(SIZES).length);
const pair: [number, string] = [1, "one"];
console.log(JSON.stringify(Object.getOwnPropertyNames(pair)));
