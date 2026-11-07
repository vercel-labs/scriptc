// Values of a closed interface in conditions, unions, generics, fields and closures.
interface Shape { scale: number; readonly name: string; area(): number; grow(by: number): void }
class Sq implements Shape { scale = 1; readonly name = "sq"; s = 2; area(): number { return this.s * this.s; } grow(by: number): void { this.s += by; } }
class Ci implements Shape { scale = 2; readonly name: string = "ci"; r = 1; area(): number { return 3 * this.r * this.r; } grow(by: number): void { this.r += by; } }
function mk(i: number): Shape { return i % 2 === 0 ? new Sq() : new Ci(); }
const a = mk(0), b = mk(1);
a.scale = a.scale + 5; b.scale = 2;
console.log(a.scale, b.scale);
// truthiness, nullish, typeof, loose equality
let maybe: Shape | undefined = undefined;
console.log(typeof a, !a, !!b, (maybe ?? a) === a, (maybe || a) === a, maybe == null, a === a, a !== b);
maybe = b;
console.log(maybe ? maybe.name : "none", maybe && maybe.area(), typeof maybe);
// a record field
interface Slot { shape?: Shape; count: number }
const slot: Slot = { count: 1 };
console.log(slot.shape === undefined, slot.shape?.area());
slot.shape = a;
console.log(slot.shape === a, slot.shape?.area(), slot.shape.name);
// a union with a primitive
function describe(x: Shape | string | number): string { return typeof x === "string" ? `s:${x}` : typeof x === "number" ? `n:${x}` : `o:${x.name}`; }
console.log(describe(a), describe("t"), describe(3));
// tuples, readonly arrays, generics
const pair: [Shape, number] = [a, 1];
const ro: readonly Shape[] = [a, b];
function first<T>(xs: readonly T[]): T | undefined { return xs[0]; }
function wrap<T>(x: T): { value: T } { return { value: x }; }
console.log(pair[0].name, ro.length, first(ro) === a, wrap(b).value === b, first<Shape>([])?.name);
console.log(ro.reduce((sum, s) => sum + s.area(), 0), ro.some((s) => s.name === "ci"), ro.findIndex((s) => s === b), [...ro].reverse()[0] === b);
// switch on identity and conditional expressions
function which(x: Shape): string { switch (x) { case a: return "a"; case b: return "b"; default: return "?"; } }
console.log(which(a), which(b), which(mk(0)), (a.area() > 3 ? a : b).name);
// a static, a getter, and a closure over the interface
class Registry { static current: Shape = a; private items: Shape[] = []; get last(): Shape | undefined { return this.items[this.items.length - 1]; } add(s: Shape): this { this.items.push(s); return this; } }
const reg = new Registry().add(a).add(b);
const grower = (by: number) => { reg.last?.grow(by); return reg.last?.area(); };
console.log(Registry.current === a, reg.last === b, grower(1), b.area());
