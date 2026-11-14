import { probes } from "./lib.ts";

function either<A, B>(a: A, _b: B): A | B {
  return a;
}

console.log("before the declarations: " + probes());
export const value: number = 42;
export const choice: string | number = either("s", 1);
export const when: Date | RegExp = either(new Date(0), /x/);
console.log("after the declarations: " + probes());
