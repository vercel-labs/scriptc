// An assignment to an interface-typed binding used as a value.
interface Base { id(): string }
class A implements Base { id(): string { return "a"; } }
class B implements Base { id(): string { return "b"; } }
class C extends A { override id(): string { return "c"; } }
const all: Base[] = [new A(), new B(), new C()];
let cur: Base | undefined = all[1];
console.log(cur?.id(), (cur = new C()).id());
let other: Base = all[0]!;
console.log((other = new B()).id(), other.id());
