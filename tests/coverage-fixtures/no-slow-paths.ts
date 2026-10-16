// Writes that cannot replace a method report no slow path: a number index,
// and a string key into an object created in the same scope.
class Counter {
  n: number;
  constructor() {
    this.n = 0;
  }
  bump(): void {
    this.n++;
  }
}

const slots: (Counter | null)[] = [new Counter(), new Counter()];
const positions = new Map<string, number>([["a", 1]]);
const at = positions.get(process.argv.length > 99 ? "z" : "a") ?? 0;
if (slots.length > 0) slots[at] = null;

const bag: Record<string, unknown> = {};
bag[String(slots.length)] = 1;

const counter = new Counter();
counter.bump();
console.log(slots.length, counter.n, Object.keys(bag).length);
