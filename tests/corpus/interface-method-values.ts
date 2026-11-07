// Methods of an interface read as values, bound, and destructured.
interface F { name: string; greet(who: string): string }
class A implements F { name = "a"; greet(who: string): string { return `${this.name}>${who}`; } }
class B implements F { name = "b"; greet(who: string): string { return `${who}<${this.name}`; } }
function use(f: F): string { const g = f.greet.bind(f); const { name } = f; const m = f.greet; return `${g("x")} ${name} ${m.call(f, "y")} ${[1].map(() => f.greet("z"))[0]}`; }
console.log(use(new A()), use(new B()));
const fs: F[] = [new A(), new B()];
for (const { name, greet } of fs) console.log(name, typeof greet);
