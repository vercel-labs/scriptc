// An object-literal method keeps its object's identity: the call that runs
// it supplies `this`, so `o.m()` writes and reads the object's fields. The
// method value moved to another object runs against that object, and it
// takes the receiver `call`, `apply` and `Reflect.apply` name. A wrapper
// function with its own `this` stored back into the member forwards it, and
// mock.method's wrapper calls the method it replaced with the object as
// `this`, records the call's receiver, and restores the original.
import { mock } from "node:test";

interface Counter {
  base: number;
  add(x: number): number;
  describe(): string;
}

const counter: Counter = {
  base: 2,
  add(x: number) {
    this.base += x;
    return this.base;
  },
  describe() {
    return `base=${this.base}`;
  },
};
console.log(counter.add(3), counter.describe());
const other: Counter = { base: 100, add: counter.add, describe: counter.describe };
console.log(other.add(1), other.describe(), counter.describe());
const add = counter.add;
console.log(add.call(other, 10), other.describe());
console.log(add.apply(other, [20]), Reflect.apply(add, other, [30]));
counter.add = function (this: Counter, x: number) {
  return add.call(this, x) * 10;
};
console.log(counter.add(1), other.describe());
const m = mock.method(counter, "add", (x: number) => x * 2);
console.log(counter.add(3), m.mock.callCount(), m.mock.calls[0]!.this === counter);
m.mock.mockImplementation((x: number) => x + 1000);
console.log(counter.add(1));
m.mock.restore();
console.log(counter.add(5), m.mock.callCount());


// The mock itself takes a receiver from `call`, `apply` and `Reflect.apply`,
// and records it as the call's `this`.
interface Adder {
  base: number;
  add(x: number): number;
}
const counter2: Adder = { base: 1, add: (x: number) => x };
const other2: Adder = { base: 100, add: counter2.add };
const callable = mock.method(counter2, "add");
console.log(callable(2), callable.mock.callCount());
console.log(callable.call(other2, 5), callable.mock.calls[1]!.this === other2);
console.log(callable.apply(other2, [6]), callable.mock.calls[2]!.this === other2);
callable.mock.restore();
console.log(counter2.add(3), other2.add(4));

// A mocked method copied to another record runs against the record the call
// went through, and the method read off the object and called alone runs
// without a receiver, as in Node.
const base3: Adder = { base: 1, add: (x: number) => x };
const moved = mock.method(base3, "add", function (this: Adder, x: number) {
  return x * 10;
});
const copy3: Adder = { base: 100, add: base3.add };
console.log(copy3.add(2), moved.mock.calls[0]!.this === copy3);
const detached3 = base3.add;
console.log(detached3(3), moved.mock.calls[1]!.this === undefined);
moved.mock.restore();
console.log(base3.add(4), copy3.add(5));

// The wrapper stored under another member name runs against the object that
// call goes through too.
const source3: Adder = { base: 7, add: (x: number) => x };
const renamed = mock.method(source3, "add", function (this: Adder, x: number) {
  return x + 100;
});
const underAnotherName = { run: source3.add };
console.log(underAnotherName.run(1), renamed.mock.calls[0]!.this === underAnotherName);
renamed.mock.restore();
console.log(source3.add(2), underAnotherName.run(3));
