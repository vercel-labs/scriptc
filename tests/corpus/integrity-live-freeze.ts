// integrity-dead-freeze.ts with the constants turned on: the same Object.freeze,
// Object.seal and Object.preventExtensions calls on untyped values sit in arms
// that run. Each value is frozen through its untyped reference, so the stores
// through the typed references throw Node's TypeError (this module is strict
// mode code) and the integrity queries report the state.
export {};

const DEV = true;
const PRODUCTION = false;
const VERBOSE = DEV && !PRODUCTION;

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
  PRODUCTION || Object.freeze(value);
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
  if (true) {
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
    console.log("recorded " + recorder.seen.length);
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

const sealedPoint = new Point(1, 2);
const closedTagged = new Tagged(3, 4, "t");
const frozenPoint = new Point(5, 6);
const frozenTagged = new Tagged(7, 8, "f");

guardSealed(sealedPoint);
guardClosed(closedTagged);
guard(frozenPoint);
guardVerbose(frozenTagged, true);
guardVerbose(closedTagged, false);

console.log(integrity(sealedPoint), integrity(closedTagged));
console.log(integrity(frozenPoint), integrity(frozenTagged));

sealedPoint.x = 10;
sealedPoint.move(5);
console.log(sealedPoint.x, sealedPoint.y);

const stores: (() => void)[] = [
  () => {
    frozenPoint.x = 10;
  },
  () => {
    frozenPoint.move(5);
  },
  () => {
    frozenTagged.tag = "u";
  },
  () => {
    frozenTagged.y = 40;
  },
  () => {
    closedTagged.tag = "u";
  },
];
for (const store of stores) {
  try {
    store();
    console.log("stored");
  } catch (e) {
    report(e);
  }
}
console.log(frozenPoint.x, frozenPoint.y, frozenTagged.x, frozenTagged.y, frozenTagged.tag);
console.log(closedTagged.x, closedTagged.y, closedTagged.tag);

let sum = 0;
let refused = 0;
for (let i = 0; i < 1000; i++) {
  const p = new Tagged(i, i + 1, "n");
  p.x = p.y + i;
  if (i % 4 === 0) guard(p);
  try {
    p.y = p.x;
  } catch {
    refused++;
  }
  sum += p.y;
}
console.log(sum, refused);
