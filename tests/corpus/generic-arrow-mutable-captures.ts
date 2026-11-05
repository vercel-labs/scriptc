// Generic arrow bindings inside functions that WRITE a binding of the
// enclosing frame (`++callCount`, `total += n`) or read one the frame
// reassigns. Every instance shares the frame's binding with the frame
// and with ordinary closures over it: writes from either side are seen by
// the other, as in Node.
interface Result {
  ok: boolean;
}

// The counter idiom: an async generic arrow numbering its calls, called
// from closures in a returned record, with a reassignment outside.
function makeRunner(prefix: string): { run: (n: number) => Promise<string[]> } {
  let callCount = 0;
  const ids: string[] = [];
  const runCall = async <TResult extends Result>(name: string, make: () => Promise<TResult>): Promise<TResult> => {
    const id = `${prefix}/${name}/${++callCount}`;
    ids.push(id);
    const result = await make();
    ids.push(`${id}:${result.ok}`);
    return result;
  };
  return {
    run: async (n) => {
      for (let i = 0; i < n; i++) {
        await runCall("a", async () => ({ ok: true }));
        const b = await runCall("b", async () => ({ ok: false, extra: i }));
        ids.push(`extra=${b.extra}`);
      }
      callCount += 100;
      await runCall("c", async () => ({ ok: true }));
      return ids;
    },
  };
}

// Sync: two instances (different T) sharing two captured lets, a call from
// the declaring frame and from a nested arrow, a parameter captured and
// reassigned, and a frame write between calls.
function accumulate(start: number): string {
  let total = start;
  let last = "none";
  const add = <T extends { n: number }>(item: T): T => {
    total += item.n;
    last = `${item.n}@${start}`;
    return item;
  };
  add({ n: 1 });
  const later = (): { n: number; tag: string } => add({ n: 2, tag: "x" });
  const tagged = later();
  total = total * 10;
  start = -1;
  add({ n: 3 });
  return `${total} ${last} ${tagged.tag}`;
}

// A generic arrow that reads a binding only the frame writes, called in a
// loop: each call sees the current value, never a copy from an earlier one.
function snapshots(): string {
  let step = 0;
  const seen: string[] = [];
  const note = <T,>(value: T): T => {
    seen.push(`${step}:${String(value)}`);
    return value;
  };
  for (; step < 3; step++) note(step % 2 === 0 ? "even" : step);
  note(true);
  return seen.join(" ");
}

// A recursive generic arrow over a captured counter.
function depth(): number {
  let calls = 0;
  const walk = <T,>(items: T[], index: number): number => {
    calls++;
    return index >= items.length ? 0 : 1 + walk(items, index + 1);
  };
  return walk(["a", "b", "c"], 0) * 10 + calls;
}

// A `var` that a second declaration re-initializes is one binding the
// frame writes: a closure the generic arrow returned reads the new value.
function redeclared(): string {
  var label = "first";
  const make = <T,>(value: T): (() => string) => () => `${label}:${String(value)}`;
  const getter = make(1);
  var label = "second";
  return `${getter()} ${make(true)()}`;
}

// A `var` in a for-of head is one binding the loop writes on every
// iteration: closures returned in earlier iterations read the last value.
function loopVar(): string {
  const readers: Array<() => string> = [];
  for (var item of ["a", "b", "c"]) {
    const make = <T,>(value: T): (() => string) => () => `${item}${String(value)}`;
    readers.push(make(1));
  }
  return readers.map((reader) => reader()).join(" ");
}

// A `var` with an initializer in a loop body is one binding the body writes
// on every iteration: closures returned in earlier iterations read the last
// value. (The binding is declared with the type its hoisted storage has.)
function loopInitializer(): string {
  const readers: Array<() => string> = [];
  for (let i = 0; i < 3; i++) {
    var step: string | undefined = `s${i}`;
    const make = <T,>(value: T): (() => string) => () => `${step}${String(value)}`;
    readers.push(make(i));
  }
  return readers.map((reader) => reader()).join(" ");
}

async function main(): Promise<void> {
  console.log((await makeRunner("p").run(2)).join(" "));
  console.log(accumulate(5));
  console.log(snapshots());
  console.log(depth());
  console.log(redeclared(), loopVar(), loopInitializer());
}
main();
