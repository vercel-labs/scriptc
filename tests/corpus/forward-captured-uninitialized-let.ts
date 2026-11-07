// A function created above `let x: T;` (no initializer) that reads or
// writes x. Before the declaration runs the binding is in its dead zone;
// from the declaration to the first assignment it holds undefined.
class Box {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

function start(seed: number): (n: number) => string {
  const apply = (n: number): string => `${label}:${String(count)}:${n}`;
  let label: string | undefined;
  let count: unknown;
  label = "a" + seed;
  count = seed + 1;
  return apply;
}
console.log(start(1)(2));

// Read between the declaration and the first assignment.
function between(seed: number): string {
  const read = (): string => `${String(u)}:${typeof d}:${String(o?.v)}`;
  let u: string | undefined;
  let d: unknown;
  let o: Box | undefined;
  const before = read();
  u = "s" + seed;
  d = seed;
  o = new Box(seed);
  return before + " " + read();
}
console.log(between(3));

// Read before the declaration runs: the dead zone.
function early(): string {
  const read = (): string => String(u);
  let out = "";
  try {
    out = read();
  } catch (e) {
    out = e instanceof ReferenceError ? `ReferenceError: ${e.message}` : "other";
  }
  let u: string | undefined;
  u = "set";
  return out + " " + read();
}
console.log(early());

// A write from the earlier function, after and before the declaration.
function written(): string {
  const set = (v: string): void => {
    u = v;
  };
  let out = "";
  try {
    set("too early");
  } catch (e) {
    out = e instanceof ReferenceError ? "ReferenceError" : "other";
  }
  let u: string | undefined;
  set("w");
  return out + " " + String(u);
}
console.log(written());

// In a loop body each iteration has its own binding.
function perIteration(): string {
  const fns: (() => string)[] = [];
  for (let i = 0; i < 3; i++) {
    const read = (): string => String(u);
    let u: number | undefined;
    if (i > 0) u = i;
    fns.push(read);
  }
  return fns.map((f) => f()).join(",");
}
console.log(perIteration());

// Two functions sharing the binding, one declared above it and one below.
function shared(): string {
  const above = (): string => String(n);
  let n: number | undefined;
  const below = (): void => {
    n = (n ?? 0) + 1;
  };
  below();
  below();
  return above();
}
console.log(shared());
