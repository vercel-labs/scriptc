// Values of an interface compared loosely and passed to narrower structural parameters.
interface Shape { scale: number; readonly name: string; area(): number }
class Sq implements Shape { scale = 1; readonly name = "sq"; area(): number { return 4; } }
class Ci implements Shape { scale = 2; readonly name: string = "ci"; area(): number { return 3; } }
function mk(i: number): Shape { return i % 2 === 0 ? new Sq() : new Ci(); }
const a = mk(0), b = mk(1);
function scaleOf(x: { scale: number }): number { return x.scale; }
function nameOf(x: { readonly name: string }): string { return x.name; }
console.log(scaleOf(a), nameOf(b), a == a, a != b, a == b);
