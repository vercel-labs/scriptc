// @requires-libnode
// A value typed by an island's declarations may still be a native value: an
// island alias or interface annotating a native array, Map, object or class
// instance. A method call on it follows the value: an island object's call
// takes the bridge, and a native receiver's is the ordinary native method
// call. A builtin member or a class method of a native value has no
// function value to hold or look up at run time, so these calls used to
// throw "a call needs a Node island value" (arguments that run code) or
// "take is not a function" (a class instance).
import {
  makeNames,
  makeSink,
  send,
  tableSize,
  total,
  useSink,
  type Input,
  type Names,
  type Sink,
  type Table,
} from "recv-pkg";

let calls = 0;
function next(): string {
  calls++;
  return "n" + calls;
}

// 1. The reported shape: a generic instance pushing a literal whose members
// are computed, onto a native array typed by the island's alias.
function convert<T extends string>(model: T, n: number): string {
  const messages: Input = [];
  for (let i = 0; i < n; i++) {
    messages.push({ type: "out", call_id: model + i, output: "o" + i });
  }
  return send(messages);
}
console.log(convert<string>("m", 2));
function plain(n: number): string {
  const messages: Input = [];
  for (let i = 0; i < n; i++) messages.push({ role: "user", content: "c" + i });
  return send(messages);
}
console.log(plain(2));

// 2. Other array members, with calls, operators and spreads as arguments.
const names: Names = [];
names.push(next());
names.push(next(), next());
names.unshift("z" + calls);
console.log(names.indexOf("n" + 2), names.includes(next()), names.length);
const more = ["x", "y"];
names.push(...more);
console.log(names.concat([next()]).join(","), names.slice(calls - 3).join(","));
console.log(total(names), names.pop(), names.length);
console.log(names.map((name) => name + calls).join(","), names.lastIndexOf("n" + 1));

// 3. A native Map typed by the island's alias.
const table: Table = new Map();
table.set("k" + calls, calls + 1);
table.set(next(), 2);
console.log(tableSize(table), table.get("k" + 5), table.get("k" + 4), table.has(next()));

// 4. A native object and a native class instance typed by the island's
// interface: the member is a closure, or a class method. Inert arguments
// and arguments that run code, a binding and a parameter.
const sink: Sink = { name: "s", take: (n: number) => n * 10 };
console.log(sink.take(4), sink.take(calls + 1), useSink(sink));
class Counter implements Sink {
  name = "counter";
  sum = 0;
  take(n: number): number {
    this.sum += n;
    return this.sum;
  }
}
class Doubling extends Counter {
  override take(n: number): number {
    return super.take(n * 2);
  }
}
const counter: Sink = new Counter();
console.log(counter.take(5), counter.take(calls * 2), counter.name, counter.take(calls - 6));
function drain(target: Sink, n: number): string {
  return target.name + ":" + target.take(n + 1) + ":" + target.take(1);
}
console.log(drain(new Counter(), 1), drain(new Doubling(), 1), drain(sink, 1), drain(makeSink(), 1));

// 5. The same calls on values that are island objects take the bridge.
const islandNames = makeNames();
islandNames.push(next(), "t" + calls);
console.log(total(islandNames), islandNames.indexOf("t" + calls));
const islandSink = makeSink();
console.log(islandSink.take(calls + 1), useSink(islandSink), islandSink.take(calls - 9));

// 6. A member that is not a function is Node's TypeError, after the
// arguments ran.
const broken = { name: "b" } as unknown as Sink;
try {
  broken.take(calls + Number(next().slice(1)));
} catch (e) {
  console.log(e instanceof TypeError, calls);
}

// 7. An argument that runs code replaces the member: the call is the one
// the read before the arguments answered, so the replacement never runs.
const blank: { name: string; take?: unknown } = { name: "k" };
function replaceTake(target: { take?: unknown }): [number] {
  target.take = (n: number) => n * 100;
  return [2];
}
try {
  (blank as unknown as Sink).take(...replaceTake(blank));
} catch (e) {
  console.log(e instanceof TypeError, typeof blank.take);
}

// 8. The same without a spread, where the call that follows the arguments
// is compiled code's own by-name call: a member that is a function when it
// is read is the one called, whatever the arguments store in its place, and
// a member that is not a function when it is read is not called even when
// the arguments store one there. The TypeError names the callee.
function swap(target: Sink, take: (n: number) => number, value: number): number {
  target.take = take;
  return value;
}
const first: Sink = { name: "first", take: (n: number) => n + 100 };
console.log(first.take(swap(first, (n) => n - 100, 1)), first.take(1));
// (An untyped object: a literal typed by its own members is a record whose
// `take` is a number for good.)
const lateFields: any = { name: "late", take: 5 };
const late: Sink = lateFields;
try {
  console.log(late.take(swap(late, (n) => n * 2, 3)));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message, late.take(4));
}
const absent = { name: "absent" } as unknown as Sink;
try {
  console.log(absent.take(swap(absent, (n) => n + 1, 3)));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message, absent.take(4));
}
// Arguments that leave the member alone change nothing: a class method and
// an array's builtin still take the by-name call.
const kept: Sink = new Counter();
console.log(kept.take(swap(sink, (n) => n * 11, 2)), sink.take(2), names.push(next()) > 0);
