// An interface property that one class stores and another implements with accessors.
interface K { readonly kind: string; size: number }
class A implements K { readonly kind = "a"; size = 1; }
class B implements K { private n = 2; get kind(): string { return "b" + this.n; } get size(): number { return this.n; } set size(v: number) { this.n = v; } }
function use(k: K): string { k.size = k.size + 1; return `${k.kind}:${k.size}`; }
console.log(use(new A()), use(new B()));
