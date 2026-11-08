// A variadic untyped function value, `(...args: any[]) => any`, where a
// function type with fixed parameters is expected. The slot calls the same
// function with the arguments the slot declares; a `void` slot drops the
// result, a `Promise<void>` slot keeps the promise, and a typed result is
// checked.
let calls = 0;
const log: string[] = [];

function counting(tag: string): (...args: any[]) => any {
  return (...args: any[]): any => {
    calls++;
    log.push(`${tag}(${args.map((arg) => String(arg)).join(",")})`);
    return tag + args.length;
  };
}
function resolving(tag: string): (...args: any[]) => Promise<any> {
  return (...args: any[]) =>
    new Promise((resolve, reject) => {
      calls++;
      if (args[0] === "fail") reject(new Error(tag + " rejected"));
      else resolve(tag + args.length);
    });
}

// A result annotation, the first place such a value usually lands.
function take(tag: string): () => void {
  return counting(tag);
}
function takeOne(tag: string): (x: number) => void {
  return counting(tag);
}
function takeTwo(tag: string): (name: string, on: boolean) => void {
  return counting(tag);
}
const none = take("none");
const one = takeOne("one");
const two = takeTwo("two");
none();
one(4);
two("x", true);
console.log(log.join(" "));

// Annotated bindings, a class field, a record member, array elements.
const made = counting("made");
const bound: () => void = made;
class Holder {
  private kept: (() => void) | undefined;
  act: () => void;
  constructor(act: () => void) {
    this.act = act;
  }
  keep(act: () => void): void {
    this.kept = act;
  }
  drop(): boolean {
    const had = this.kept !== undefined;
    if (this.kept) this.kept();
    this.kept = undefined;
    return had;
  }
}
const holder = new Holder(counting("field"));
holder.act();
holder.keep(counting("kept"));
console.log(holder.drop(), holder.drop());
const record: { stop: () => void; name: string } = { stop: counting("member"), name: "r" };
record.stop();
const acts: (() => void)[] = [counting("a"), counting("b"), made];
for (const act of acts) act();
console.log(log.slice(3).join(" "));

// The converted value is the function it was made from.
console.log("same", bound === made, acts[2] === made, acts.indexOf(made), acts.includes(bound));
let optional: (() => void) | undefined;
console.log("unset", optional === undefined);
optional = made;
if (optional) optional();
console.log("set", optional === made);

// Positions inside other values: a record built for an interface, a
// conditional, a default, and a promise's value.
interface Handle {
  name: string;
  stop: () => void;
}
function build(name: string): Handle {
  return { name, stop: counting(name) };
}
const handle = build("handle");
handle.stop();
const chosen: () => void = handle.name === "handle" ? counting("yes") : counting("no");
chosen();
const absent: (() => void) | undefined = undefined;
const used: () => void = absent ?? counting("fallback");
used();
async function eventually(): Promise<() => void> {
  return counting("eventually");
}

// Slots that are variadic themselves pass every argument they were given.
const names: (...names: string[]) => void = counting("names");
names();
names("a", "b", "c");
const mixed: (first: number, ...rest: string[]) => void = counting("mixed");
mixed(1);
mixed(1, "a", "b");
const sum: (...xs: number[]) => string = counting("sum");
console.log("rest", sum(1, 2, 3), log.slice(-7).join(" "));

// Arguments are the caller's own objects: a write the function makes is
// seen by the caller, and a returned argument is the object that went in.
function writing(): (...args: any[]) => any {
  return (...args: any[]): any => {
    for (const arg of args) {
      if (Array.isArray(arg)) arg.push(args.length);
      else if (arg instanceof Map) arg.set("seen", args.length);
      else arg.count = arg.count + 10;
    }
    return args[0];
  };
}
class Tally {
  count = 0;
}
const touch: (items: number[], box: { count: number }, seen: Map<string, number>) => void =
  writing();
const items = [1];
const box = { count: 1 };
const seen = new Map<string, number>();
touch(items, box, seen);
const tally = new Tally();
const touchTally: (tally: Tally) => void = writing();
touchTally(tally);
console.log("written", items.join(","), box.count, seen.get("seen"), tally.count);
const touchAll: (...boxes: { count: number }[]) => void = writing();
const first = { count: 1 };
const second = { count: 2 };
touchAll(first, second);
const nested: (outer: { inner: { count: number }; rows: number[][] }) => void = ((): ((
  ...args: any[]
) => any) => {
  return (...args: any[]): any => {
    args[0].inner.count = 5;
    args[0].rows[0].push(7);
  };
})();
const outer = { inner: { count: 0 }, rows: [[1]] };
nested(outer);
console.log("written", first.count, second.count, outer.inner.count, outer.rows[0]!.join(","));
const giveBack: (items: number[]) => number[] = writing();
const back = giveBack(items);
back.push(100);
const giveBox: (box: { count: number }) => { count: number } = writing();
console.log("returned", back === items, giveBox(box) === box, items.join(","), box.count);

// Results the slot keeps: a promise, and a typed value that is checked.
const settle: () => Promise<void> = resolving("settle");
const settleWith: (how: string) => Promise<void> = resolving("with");
const size: (a: string, b: string) => string = counting("size");
console.log("typed", size("p", "q"));

async function main(): Promise<void> {
  (await eventually())();
  console.log(log[log.length - 1]);
  const settled = settle();
  console.log("promise", settled instanceof Promise);
  await settled;
  await settleWith("ok");
  try {
    await settleWith("fail");
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }
  let release: (() => Promise<void>) | undefined;
  try {
    release = resolving("release");
  } finally {
    if (release) await release();
  }
  for (let i = 0; i < 200; i++) {
    const act: () => void = counting("loop");
    act();
    const wait: () => Promise<void> = resolving("loop");
    await wait();
  }
  console.log("calls", calls, log.length);
}
main();
