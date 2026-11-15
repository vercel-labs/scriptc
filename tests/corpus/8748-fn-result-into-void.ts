// A function value whose result the slot declares `void`: any result type
// converts, the call drops what comes back, and the converted value is still
// the same function (compared, searched for and removed like in Node).
let calls = 0;

const five = (): number => {
  calls++;
  return 5;
};
const label = (): string => {
  calls++;
  return "label " + calls;
};
const rows = (): number[] => {
  calls++;
  return [calls, calls + 1];
};
const pair = (): { a: number; b: string } => {
  calls++;
  return { a: calls, b: "b" + calls };
};
const either = (): string | number => {
  calls++;
  return calls % 2 === 0 ? "s" + calls : calls;
};
const anything = (): unknown => {
  calls++;
  return calls % 2 === 0 ? "even " + calls : { n: calls };
};
const loose = (): any => {
  calls++;
  return ["x", calls];
};
const fail = (): never => {
  calls++;
  throw new Error("never returns " + calls);
};

// A plain annotated binding.
const run: () => void = five;
run();
run();
console.log("binding", calls, run === five);

// A parameter and a result.
function pass(act: () => void): () => void {
  return act;
}
const passed = [pass(label), pass(rows), pass(pair), pass(either), pass(anything), pass(loose)];
for (const act of passed) act();
console.log("passed", calls);
console.log(
  "same",
  passed[0] === label,
  passed[1] === rows,
  passed[2] === pair,
  passed[3] === either,
  passed[4] === anything,
  passed[5] === loose,
);

// A class field and a record member, called many times: every result is
// released by the call that dropped it.
class Holder {
  act: () => void;
  constructor(act: () => void) {
    this.act = act;
  }
}
const holders = [new Holder(label), new Holder(rows), new Holder(pair), new Holder(anything)];
for (let i = 0; i < 250; i++) for (const holder of holders) holder.act();
const table: { first: () => void; second: () => void } = { first: either, second: loose };
for (let i = 0; i < 250; i++) {
  table.first();
  table.second();
}
console.log("stored", calls, holders[0]!.act === label, table.second === loose);

// A function that never returns still throws through the slot.
const thrower: () => void = fail;
try {
  thrower();
} catch (error) {
  console.log("thrown", (error as Error).message, thrower === fail);
}

// Listeners are removed by comparing the function that was added.
const listeners: (() => void)[] = [];
function on(listener: () => void): void {
  listeners.push(listener);
}
function off(listener: () => void): void {
  const at = listeners.indexOf(listener);
  if (at >= 0) listeners.splice(at, 1);
}
on(five);
on(label);
on(five);
console.log("listeners", listeners.length, listeners.includes(label), listeners.includes(rows));
off(five);
off(rows);
console.log("listeners", listeners.length, listeners[0] === label, listeners[1] === five);
off(label);
off(five);
console.log("listeners", listeners.length);

// Parameters are forwarded unchanged; only the result is dropped.
let total = 0;
const add = (x: number, name: string): string => {
  total += x;
  return name + total;
};
type Sink = (x: number, name: string) => void;
const sink: Sink = add;
sink(2, "a");
sink(3, "b");
const sinks = new Map<string, Sink>([["add", add]]);
sinks.get("add")!(4, "c");
console.log("forwarded", total, sinks.get("add") === add, sink === add);

function each(items: number[], visit: (item: number) => void): void {
  for (const item of items) visit(item);
}
const seen: number[] = [];
const push = (item: number): number => seen.push(item);
each([1, 2, 3], push);
each([4], (item) => seen.push(item));
console.log("each", seen.join(","));
