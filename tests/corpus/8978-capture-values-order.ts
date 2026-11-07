// Bindings captured before they are initialized, hoisted declarations and
// recursive closures: a closure created before the initialization must see
// the value afterwards and throw before it.
function describe(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// Created before the initialization, called before and after it.
function deadZone(): string[] {
  const out: string[] = [];
  const read = (): string => value + "!";
  out.push(describe(read));
  const value = "ready";
  out.push(describe(read));
  const later = (): string => value + "?";
  out.push(later());
  return out;
}
console.log(deadZone().join(" | "));

function deadZoneNumber(): string[] {
  const out: string[] = [];
  const read = (): string => String(count + 1);
  out.push(describe(read));
  let count = 41;
  out.push(describe(read));
  count++;
  out.push(describe(read));
  return out;
}
console.log(deadZoneNumber().join(" | "));

// A hoisted function declaration captures bindings declared later.
function hoisted(scale: number): string[] {
  const out: string[] = [];
  out.push(describe(() => String(area(2))));
  const factor = scale * 3;
  out.push(String(area(2)));
  const unit = "cm";
  out.push(label(area(3)));
  function area(side: number): number {
    return side * side * factor;
  }
  function label(value: number): string {
    return `${value}${unit}`;
  }
  const both = (): string => label(area(1));
  out.push(both());
  return out;
}
console.log(hoisted(1).join(" | "), hoisted(2).join(" | "));

// Recursive closures: through the binding, through a declaration, and two
// that call each other.
function recursion(limit: number): string {
  const down = (n: number): number => (n <= 0 ? 0 : n + down(n - 1));
  function fact(n: number): number {
    return n <= 1 ? 1 : n * fact(n - 1);
  }
  const isEven = (n: number): boolean => (n === 0 ? true : isOdd(n - 1));
  const isOdd = (n: number): boolean => (n === 0 ? false : isEven(n - 1));
  function ping(n: number): string {
    return n === 0 ? "ping" : pong(n - 1);
  }
  function pong(n: number): string {
    return n === 0 ? "pong" : ping(n - 1);
  }
  const all = (): string =>
    [down(limit), fact(limit), isEven(limit), isOdd(limit), ping(limit), pong(limit)].join(",");
  return all();
}
console.log(recursion(4), recursion(7));

// The closure escapes, and so does a second one made after everything is
// declared: both keep working once the frame is gone.
function escaping(base: number): { early: () => number; late: () => number; walk: (n: number) => number } {
  const early = (): number => base + step();
  function step(): number {
    return size * 2;
  }
  const size = base + 1;
  const walk = (n: number): number => (n === 0 ? size : walk(n - 1) + step());
  const late = (): number => early() + step() + size;
  return { early, late, walk };
}
const escaped = [escaping(1), escaping(10)];
console.log(escaped.map((e) => `${e.early()}/${e.late()}/${e.walk(3)}`).join(" "));

// A closure created inside the initializer of the binding it captures.
function selfInInitializer(): string {
  const registry: (() => string)[] = [];
  const name: string = ((): string => {
    registry.push(() => "name is " + name);
    return "self";
  })();
  const handle = { tick: 0, read: (): number => handle.tick++ };
  handle.read();
  return `${registry[0]!()} ${handle.read()} ${describe(() => name)}`;
}
console.log(selfInInitializer());

// Declarations inside one switch case, captured in that case.
function inCase(kind: number): () => string {
  let read: () => string = () => "none";
  switch (kind) {
    case 0: {
      const zero = "zero";
      read = () => zero;
      break;
    }
    case 1:
      const one = "one" + kind;
      read = () => one;
      break;
    default: {
      const other = kind * 2;
      read = () => `other ${other}`;
    }
  }
  return read;
}
console.log([0, 1, 2, 5].map((kind) => inCase(kind)()).join(","));

// try, catch and finally each have their own bindings.
function guarded(fail: boolean): string[] {
  const reads: (() => string)[] = [];
  try {
    const attempt = fail ? "failing" : "passing";
    reads.push(() => attempt);
    if (fail) throw new Error("stop");
    const done = attempt + " done";
    reads.push(() => done);
  } catch (error) {
    const message = (error as Error).message;
    reads.push(() => "caught " + message);
  } finally {
    const closing = fail ? "closed after failure" : "closed";
    reads.push(() => closing);
  }
  return reads.map((read) => read());
}
console.log(guarded(false).join(" | "), guarded(true).join(" | "));
