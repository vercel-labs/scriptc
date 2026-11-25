// A function object may carry own data properties named after the members
// Function.prototype and Object.prototype provide: the own property shadows
// the inherited one in reads, in calls and in enumeration.
interface Shadowing {
  (n: number): number;
  apply: () => number;
  call: () => number;
  bind: () => number;
  valueOf: () => string;
  hasOwnProperty: (key: string) => boolean;
}

const f = ((n: number) => n * 2) as Shadowing;
f.apply = () => 100;
f.call = () => 200;
f.bind = () => 300;
f.valueOf = () => "v";
f.hasOwnProperty = (key: string) => key === "apply";

console.log(f(3), f.apply(), f.call(), f.bind(), f.valueOf(), f.hasOwnProperty("apply"));
console.log(Object.keys(f).join(","), typeof f, f.hasOwnProperty("extra"));

// The same table through an `any` alias: Node reads the own property before
// it runs the builtin call/apply/bind.
const alias: any = f;
console.log(alias.apply(), alias.call(), alias.valueOf());

// Object.assign copies each source's own enumerable keys onto the function.
const g = ((n: number) => n + 1) as Shadowing;
Object.assign(g, { apply: () => 7 });
console.log(g(1), g.apply(), Object.keys(g).join(","));

// A write can be removed again: the own property goes, the inherited
// member stays where it has always been.
delete (f as any).apply;
console.log(Object.keys(f).join(","));
