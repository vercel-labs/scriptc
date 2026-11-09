// Object.freeze, Object.seal and Object.preventExtensions of untyped values
// in code that never runs: the untaken arm of an `if` whose condition is
// `false`, a `const` that is false, or `!` and `&&` over those, the right
// operand of `&&` and `||` after a constant that decides them, and the
// unselected arm of a conditional expression (a development-only block of a
// production build). Nothing is frozen, so every
// store goes through and the integrity queries answer as for a plain object.
// The untaken arms also hold a class, closures and a labeled loop, which
// never run, and the taken `else` arms do. integrity-live-freeze.ts is the
// same program with the constants turned on.
export {};

const DEV = false;
const PRODUCTION = true;
const VERBOSE = DEV && PRODUCTION;

function report(e: unknown): void {
  console.log((e as Error).name + ": " + (e as Error).message);
}

function integrity(value: unknown): string {
  return [Object.isFrozen(value), Object.isSealed(value), Object.isExtensible(value)].join(" ");
}

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  move(dx: number): void {
    this.x += dx;
  }
}

class Tagged extends Point {
  tag: string;
  constructor(x: number, y: number, tag: string) {
    super(x, y);
    this.tag = tag;
  }
}

function guard(value: unknown): unknown {
  if (DEV) {
    Object.freeze(value);
  }
  DEV && Object.freeze(value);
  PRODUCTION || Object.seal(value);
  return DEV ? Object.freeze(value) : value;
}

function guardSealed(value: unknown): unknown {
  if (!PRODUCTION) {
    return Object.seal(value);
  } else {
    return value;
  }
}

function guardClosed(value: unknown): unknown {
  if (false) {
    class Recorder {
      seen: unknown[] = [];
      record(item: unknown): void {
        this.seen.push(Object.preventExtensions(item));
      }
    }
    const recorder = new Recorder();
    const each = (item: unknown): void => recorder.record(item);
    outer: for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (j === 1) continue outer;
        each(value);
      }
    }
  }
  return value;
}

function guardVerbose(value: unknown, wanted: boolean): unknown {
  if (VERBOSE && wanted) {
    Object.freeze(value);
    console.log("frozen " + integrity(value));
  } else if (DEV || !PRODUCTION) {
    Object.seal(value);
  } else {
    console.log("left " + integrity(value));
  }
  return value;
}

const point = new Point(1, 2);
const tagged = new Tagged(3, 4, "t");
const record = { count: 1, name: "r" };
const list = [1, 2, 3];

for (const value of [point, tagged, record, list] as unknown[]) {
  guard(value);
  guardSealed(value);
  guardClosed(value);
  guardVerbose(value, true);
}

try {
  point.x = 10;
  point.move(5);
  tagged.tag = "u";
  tagged.y = 40;
  record.count = 2;
  list[0] = 9;
  list.push(4);
  console.log(point.x, point.y, tagged.x, tagged.y, tagged.tag, record.count, list.join(","));
} catch (e) {
  report(e);
}

console.log(integrity(point), integrity(tagged), integrity(record), integrity(list));

let sum = 0;
for (let i = 0; i < 1000; i++) {
  const p = new Tagged(i, i + 1, "n");
  p.x = p.y + i;
  guard(p);
  p.y = p.x;
  sum += p.y;
}
console.log(sum);
