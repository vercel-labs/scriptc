class Base { value = 3; next: Base | undefined = undefined; }
class Child extends Base { extra = 4; read(): number { return this.value + this.extra; } }
class Grandchild extends Child { override read(): number { return super.read() + 1; } }
function read(value: Base): number { return (value as Child).read(); }
function nullable(value: Base | undefined): number { return (value as Child).extra; }
function nonnull(value: Base | undefined): number { return (value! as Child).read(); }
let calls = 0;
function make(): Base { calls++; return new Grandchild(); }
const child = new Child();
const base: Base = child;
console.log(read(base), nullable(base), nonnull(base));
console.log(read(make()), calls, (base as Child) === child);
base.next = new Grandchild();
console.log((base.next as Child).read());
// A guarded invalid member call throws TypeError in both execution models.
function badMethod(value: Base): void {
  try { (value as Child).read(); } catch (error) { console.log(error instanceof TypeError); }
}
badMethod(new Base());
class Other { value = 8; }
function unionRead(value: Base | Child | Other | undefined): number { return (value as Child).read(); }
console.log(unionRead(new Child()), unionRead(new Grandchild()));
function wrong(value: Base | Other | undefined): void {
  try { (value as Child).read(); } catch (error) { console.log(error instanceof TypeError); }
}
wrong(undefined);
wrong(new Other());
