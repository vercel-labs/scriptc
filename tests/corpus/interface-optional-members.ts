// An interface with optional members that only some implementing classes have.
interface T { send(s: string): number; setV?(v: string): void; label?: string }
class A implements T { n = 0; send(s: string): number { this.n += s.length; return this.n; } setV(v: string): void { this.n += v.length * 10; } }
class B implements T { label = "b"; send(s: string): number { return s.length; } }
function use(t: T): string { t.setV?.("xx"); if (t.setV) t.setV("y"); return `${t.send("abc")} ${t.label ?? "none"} ${typeof t.setV}`; }
console.log(use(new A()), use(new B()));
