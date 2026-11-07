// An object filled in from an asserted empty literal, frozen, and handed on
// as an untyped value after every typed reference to it is gone. Asserting
// it back gives the same object each time, complete or not, and it is still
// frozen.
type Point = { x: number; y: number; z: number };

function complete(): unknown {
  const p = {} as Point;
  p.x = 1;
  p.y = 2;
  p.z = 3;
  return Object.freeze(p);
}

function partial(): unknown {
  const p = {} as Point;
  p.y = 5;
  Object.freeze(p);
  return p;
}

function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(label, "wrote");
  } catch (error) {
    console.log(label, error instanceof TypeError, (error as Error).message);
  }
}

const whole = complete();
const first = whole as Point;
const second = whole as Point;
console.log("complete", first === second, Object.isFrozen(first), first.x + first.y + first.z);
console.log("complete", JSON.stringify(whole), Object.keys(second).join(","));
attempt("complete x", () => {
  first.x = 10;
});

const half = partial();
const again = half as Point;
const once = half as Point;
console.log("partial", again === once, Object.isFrozen(again), again.y, "x" in again);
console.log("partial", JSON.stringify(half), Object.keys(once).join(","));
attempt("partial add x", () => {
  again.x = 1;
});
attempt("partial set y", () => {
  once.y = 6;
});

// Held in a container between uses, with no typed reference in between.
const kept: unknown[] = [complete(), partial()];
for (const value of kept) {
  const point = value as Point;
  console.log("kept", point === (value as Point), point.y, Object.isFrozen(value));
}
