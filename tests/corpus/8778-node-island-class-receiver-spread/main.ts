// @requires-libnode
// A method call with a spread argument on a value typed by an island's
// interface. The type does not say where the value lives, so the call
// follows it. A native class instance used to throw "take is not a
// function" here: a call that spreads has no fixed argument list for the
// dynamic call node the class dispatch rewrites, and the runtime's call by
// name has no table of class methods. It now reads the member and calls
// it with the spread arguments, as a value typed `any` does.
import {
  makeAdder,
  makeSink,
  tableSize,
  type Adder,
  type Names,
  type Sink,
  type Table,
} from "spread-pkg";

let calls = 0;
function next(): number {
  calls++;
  return calls;
}

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
class Sum implements Adder {
  total = 0;
  add(...ns: number[]): number {
    for (const n of ns) this.total += n;
    return this.total;
  }
}

// 1. A class instance and a subclass instance: a spread of a binding, of
// an expression that runs code, and of an empty list beside plain
// arguments.
const one: [number] = [5];
const sink: Sink = new Counter();
console.log(sink.take(...one), sink.take(...([next()] as [number])), sink.name);
const doubling: Sink = new Doubling();
console.log(doubling.take(...one), doubling.take(...one));

// 2. A rest parameter: spreads before, between and after plain arguments.
const adder: Adder = new Sum();
const many = [1, 2, 3];
console.log(adder.add(...many), adder.add(next(), ...many, next()), adder.add(...[]), adder.add());

// 3. A parameter typed by the interface: the same call site serves a class
// instance, an island object and a native object with a closure member.
const closure: Sink = { name: "closure", take: (n: number) => n * 10 };
function drain(target: Sink, ns: [number]): string {
  return target.name + ":" + target.take(...ns) + ":" + target.take(...ns);
}
console.log(drain(new Counter(), [7]), drain(new Doubling(), [7]));
console.log(drain(makeSink(), [7]), drain(closure, [7]));
function sum(target: Adder, ns: number[]): number {
  return target.add(...ns, calls);
}
console.log(sum(new Sum(), many), sum(makeAdder(), many));

// 4. The member is read before the arguments run, and an own property
// hides the method.
class Loud implements Sink {
  name = "loud";
  take(n: number): number {
    return n + 1;
  }
}
const loud: Sink = new Loud();
function swap(): [number] {
  loud.take = (n: number) => n * 100;
  return [3];
}
console.log(loud.take(...swap()), loud.take(...one));

// 5. Native receivers the runtime calls by name keep working: an array and
// a Map typed by the island's aliases.
const names: Names = [];
const more = ["x", "y"];
names.push(...more, "z" + next());
console.log(names.join(","), names.indexOf(...(["y"] as [string])));
const table: Table = new Map();
const entry: [string, number] = ["k", 1];
table.set(...entry);
console.log(tableSize(table), table.get(...(["k"] as [string])));

// 6. A member that is not a function is Node's TypeError, after the
// arguments ran.
try {
  sink.note!(...(["n" + next()] as [string]));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message, calls);
}
