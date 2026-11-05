// Localized failure, stage L1: values of every kind held in a local or
// module global whose declared type has no static lowering keep their
// identity and behavior.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return Math.abs(this.x) + Math.abs(this.y);
  }
}
interface Cfg {
  name: string;
  depth: number;
}
type Anything =
  | Point
  | Cfg
  | number[]
  | Map<string, (x: number) => string>
  | AbortSignal
  | (() => number)
  | Promise<number>;

const p = new Point(3, -4);
const cfg: Cfg = { name: "a", depth: 1 };
const xs = [1, 2, 3];
let counter = 0;
const tick = (): number => ++counter;

// A module global holding a class instance.
let held: Anything = p;
if (held instanceof Point) {
  console.log("point", held.norm(), held === p);
  held.x = 10;
}
console.log("typed alias", p.x, p.norm());

// A record: mutation through the hole is visible in the typed alias.
held = cfg;
if (!(held instanceof Point) && !Array.isArray(held) && typeof held === "object" && "depth" in held) {
  held.depth = 5;
  console.log("record", held.name, held === cfg);
}
console.log("typed alias", cfg.depth, JSON.stringify(cfg), Object.keys(cfg).join(","));

// An array: pushes through the hole show in typed code.
held = xs;
if (Array.isArray(held)) {
  held.push(4);
  console.log("array", held.length, held === xs);
}
console.log("typed alias", xs.length, xs.join("+"));

function main(): void {
  // A local holding a closure, called through the hole.
  let local: Anything = tick;
  if (typeof local === "function") {
    console.log("closure", local(), local(), counter, local === tick);
  }
  // A promise, awaited through the hole.
  local = Promise.resolve(42);
  if (local instanceof Promise) {
    local.then((v) => console.log("promise", v));
  }
}
main();
