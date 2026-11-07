// Case C with one implementing class: the interface is the class.
interface Counter { readonly count: number; bump(): void; reset(to: number): Counter }
class Impl implements Counter {
  count = 0;
  bump(): void { this.count++; }
  reset(to: number): Counter { this.count = to; return this; }
}
function drive(c: Counter, n: number): number { for (let i = 0; i < n; i++) c.bump(); return c.count; }
const c: Counter = new Impl();
console.log(drive(c, 5), c.reset(2) === c, c.count, c instanceof Impl);
const list: Counter[] = [c, new Impl()];
console.log(list.map((x) => x.count).join(","), list[0] === c);
