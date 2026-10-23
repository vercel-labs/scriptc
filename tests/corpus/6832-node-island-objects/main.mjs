// @requires-libnode
// Native objects and class instances passed into a Node island are live
// objects there (scope-B NI-5): island reads and writes reach the native
// storage, and the same native object comes back as itself.
import { requireModule } from "@scriptc/node";

const { bump, describe, has, keep, keptAt, readThrough, same, store } = requireModule("./lib.cjs");

class Greeter {
  constructor(greeting) {
    this.greeting = greeting;
  }
  greet(who) {
    return `${this.greeting}, ${who}`;
  }
}

const counter = { count: 1, label: "c" };
console.log(describe(counter));
console.log("bump", bump(counter, 2), bump(counter, 3));
console.log("native sees", counter.count, counter.label);
counter.count = 100;
console.log(describe(counter));

console.log("kept", keep(counter));
const back = keptAt(0);
console.log("identity", back === counter, same(counter, counter), same(counter, { ...counter }));
back.label = "via island";
console.log("label", counter.label);

console.log("has", has(counter, "count"), has(counter, "missing"));

const g = new Greeter("Hello");
console.log(readThrough(g));
g.greeting = "Hi";
console.log(readThrough(g));
const boxed = store(g);
console.log("boxed", boxed.inner === g, boxed.inner.greet("native"));
