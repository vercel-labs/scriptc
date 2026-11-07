// Interface members implemented as methods by one class and as function-valued fields by another.
interface R { read(n: number): string; write: (s: string) => number }
class A implements R { read = (n: number): string => "a".repeat(n); write(s: string): number { return s.length; } }
class B implements R { read(n: number): string { return "b".repeat(n); } write = (s: string): number => s.length * 2; }
function use(r: R): string { const w = r.write; return `${r.read(2)} ${r.write("xyz")} ${w("q")}`; }
console.log(use(new A()), use(new B()));
