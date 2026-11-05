// Defaulted and optional number and boolean parameters, called with the
// argument omitted, with an explicit undefined, with a value, and through
// the function as a value: every form must see JavaScript's defaults.

function scale(value: number, by: number = 2): number {
  return value * by;
}

function flag(on: boolean = true): string {
  return on ? "on" : "off";
}

function depth(node: number, level: number = 0): number {
  // Recursion that omits the argument and passes it.
  if (node <= 1) return level;
  return node % 2 === 0 ? depth(node / 2, level + 1) : depth(node - 1);
}

let counter = 0;
function next(): number {
  counter++;
  return counter * 10;
}

function sideEffect(base: number, step: number = next()): number {
  // A default that is not a constant runs at each call that omits it.
  return base + step;
}

function optional(value: number, extra?: number): string {
  return extra === undefined ? `${value}` : `${value}+${extra}`;
}

function signed(value: number = 5): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

const values = [1, 2.5, -3, 0];
for (const v of values) {
  console.log("scale", scale(v), scale(v, undefined), scale(v, 3), scale(v, NaN));
  // A conditional argument, including one that passes undefined.
  console.log("choose", scale(v, v > 1 ? 3 : undefined), flag(v > 0 ? false : undefined), signed(v < 0 ? -0 : v));
}
console.log("flag", flag(), flag(undefined), flag(false), flag(true));
console.log("depth", depth(1), depth(12), depth(12, 5), depth(7));
console.log("side", sideEffect(1), sideEffect(1, 4), sideEffect(2), counter);
console.log("optional", optional(1), optional(2, 3), optional(4, undefined));
console.log("signed", signed(), signed(-0), signed(0), signed(undefined), signed(-1.5));

// The function as a value keeps its defaults.
const viaValue: (value: number, by?: number) => number = scale;
console.log("value", viaValue(4), viaValue(4, 5), viaValue(4, undefined));
const table = [scale, scale];
let sum = 0;
for (const f of table) sum += f(3);
console.log("table", sum);
