// More ways a function reaches an untyped caller through typed slots: a
// chain of slots of different types, a slot that converts one parameter of
// two, a slot that converts only the result, a callback that closes over a
// method's receiver, an async function, a function that was itself untyped
// before it was stored, and callbacks registered through a typed parameter
// into a Map. In each the caller holds the slot's value at `any` or at a
// function type that takes `any`, and the function receives the argument
// as it was given.
interface P { diff: string; path: string }
interface Q { diff: string; path: string; line: number }
type ShowP = (p: P) => string;
type ShowQ = (q: Q) => string;
function see(v: unknown): string { return v === undefined ? "undefined" : JSON.stringify(v); }
function loose(p: any): string { return "loose " + see(p); }
// A chain of slots.
const first: { show: ShowP } = { show: loose };
const second: { show: ShowQ } = { show: first.show };
const third: ShowQ[] = [second.show];
const chained: any = third[0];
const chainedWide: (p: any) => string = third[0]!;
console.log(chained({}), chainedWide({}), chained(undefined), chainedWide(7));
console.log((third[0] as unknown) === (loose as unknown), chainedWide === loose);
// Two parameters, one converts.
function pair(label: string, p: any): string { return label + " " + see(p); }
const two: { run: (label: string, p: P) => string } = { run: pair };
const twoAny: any = two.run;
const twoWide: (label: string, p: any) => string = two.run;
console.log(twoAny("a", {}), twoWide("b", { diff: 1 }));
// A view that converts only the result relays to the function.
function count(p: any): number { return p === undefined ? 0 : Object.keys(p).length; }
const counted: { size: (p: P) => number | undefined } = { size: count };
const countedAny: any = counted.size;
const countedWide: (p: any) => number | undefined = counted.size;
console.log(countedAny({}), countedWide({ a: 1, b: 2, c: 3 }), countedAny(undefined));
// Methods and `this`.
const table = {
  prefix: "table",
  show(this: { prefix: string }, p: any): string { return this.prefix + " " + see(p); },
};
const bound: { show: ShowP } = { show: (p: any) => table.show(p) };
const boundAny: any = bound;
console.log(boundAny.show({}), boundAny.show({ diff: "d", path: "p", extra: [1] }));
// Async functions.
async function later(p: any): Promise<string> { return "later " + see(p); }
const asyncDef: { show: (p: P) => Promise<string> } = { show: later };
const asyncAny: any = asyncDef.show;
const asyncWide: (p: any) => Promise<string> = asyncDef.show;
// A function that crossed `any` before it reached the slot.
const crossed: any = loose;
const viaAny: { show: ShowP } = { show: crossed };
const again: any = viaAny.show;
const againWide: (p: any) => string = viaAny.show;
console.log(again({}), againWide({}), again === crossed);
// Passed on as a callback and stored again.
function register(cb: ShowP): ShowP { return cb; }
const registry = new Map<string, ShowP>();
registry.set("a", register(loose));
registry.set("b", register((p: any) => "arrow " + see(p)));
function tryAll(key: string, cb: ShowP, text: any): void {
  const untyped: any = cb;
  const wide: (p: any) => string = cb;
  console.log(key, untyped({}), wide(null), untyped(text));
}
for (const [key, cb] of registry) tryAll(key, cb, "text");
// Typed calls still work with values of the type.
console.log(first.show({ diff: "d", path: "p" }), second.show({ diff: "d", path: "p", line: 3 }));
(async () => {
  console.log(await asyncAny({}), await asyncWide(undefined));
})();
