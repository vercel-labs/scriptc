// Implementing classes whose methods answer narrower types than the interface declares.
interface N { next(): N | undefined; value(): number | string; self(): N }
class A implements N { next(): A | undefined { return undefined; } value(): number { return 1; } self(): A { return this; } }
class B implements N { inner = new A(); next(): N | undefined { return this.inner; } value(): string { return "b"; } self(): N { return this; } }
function use(n: N): string { const m = n.next(); return `${n.value()} ${m === undefined ? "end" : m.value()} ${n.self() === n}`; }
console.log(use(new A()), use(new B()));
