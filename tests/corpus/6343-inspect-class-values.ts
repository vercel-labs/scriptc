// Classes reached through `unknown` print as Node prints them:
// `[class C]`, `[class C extends B]` with the runtime class's base, and
// `[class (anonymous)]`, at the top level and inside arrays and records.
import { inspect } from "node:util";

class A {
  x = 1;
}
class B extends A {
  y = 2;
}
class C extends B {}
class MyErr extends Error {}
const Anon = [class {}][0]!;
const Sub = class extends A {};

const a: unknown = A;
const b: unknown = B;
console.log(a, b);
console.log([a], { b });
const values: unknown[] = [C, MyErr, Anon, Sub];
console.log(values);
console.log(inspect({ deep: { values } }, { depth: 0 }), inspect(values, { depth: 0 }));
console.log(String(typeof values[0]));

// A slot typed as the base holds a subclass at runtime.
const pick = (k: number): typeof A => (k === 0 ? A : k === 1 ? B : C);
for (let k = 0; k < 3; k++) {
  const picked: unknown = pick(k);
  console.log(k, picked);
}
