// An interface that extends another, with classes declaring either, and a union of both.
interface Base { id(): string }
interface Wide extends Base { extra(): number }
class A implements Wide { id(): string { return "a"; } extra(): number { return 1; } }
class B implements Base { id(): string { return "b"; } }
class C extends A { override id(): string { return "c"; } }
function narrow(b: Base): string { return b.id(); }
function wide(w: Wide): string { const b: Base = w; return `${w.id()}${w.extra()}${narrow(b)}${b === w}`; }
const bases: Base[] = [new A(), new B(), new C()];
console.log(bases.map(narrow).join(""), wide(new A()), wide(new C()));
let cur: Base | Wide | undefined = bases[1];
console.log(cur?.id());
cur = new C();
console.log(cur.id(), cur instanceof A);
