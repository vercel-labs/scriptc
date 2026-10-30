// @requires-libnode
// Native records and class instances passed into a Node island are live
// objects there: island reads and writes reach the native storage, and the
// same native object comes back as itself.
import { bump, describe, has, keep, keptAt, readThrough, same, store } from "obj-pkg";

interface Counter {
  count: number;
  label: string;
}

class Greeter {
  greeting: string;
  constructor(greeting: string) {
    this.greeting = greeting;
  }
  greet(who: string): string {
    return `${this.greeting}, ${who}`;
  }
}

const counter: Counter = { count: 1, label: "c" };
console.log(describe(counter));
console.log("bump", bump(counter, 2), bump(counter, 3));
console.log("native sees", counter.count, counter.label);
counter.count = 100;
console.log(describe(counter));

console.log("kept", keep(counter));
const back = keptAt<Counter>(0);
console.log("identity", back === counter, same(counter, counter), same(counter, { count: counter.count, label: counter.label }));
back.label = "via island";
console.log("label", counter.label);

console.log("has", has(counter, "count"), has(counter, "missing"));

const g = new Greeter("Hello");
console.log(readThrough(g));
g.greeting = "Hi";
console.log(readThrough(g));
const boxed = store(g);
console.log("boxed", boxed.inner === g, boxed.inner.greet("native"));
