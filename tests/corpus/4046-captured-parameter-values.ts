// Parameters captured by nested functions but never rebound. Closures see
// the entry value and later changes to the referenced object, on early
// returns, escaping callbacks, loops, nesting, and exceptions.
interface Filter {
  key: number;
  skip: boolean;
  label: string;
}
const values = [3, 1, 4, 1, 5, 9, 2, 6];

function matching(filter: Filter): number {
  if (filter.skip) return -1;
  return values.filter((value) => value % 3 === filter.key).length;
}
console.log(matching({ key: 1, skip: false, label: "a" }), matching({ key: 0, skip: true, label: "b" }));

function makeReaders(filter: Filter, scale: number, tag: string, enabled: boolean): (() => string)[] {
  const readers: (() => string)[] = [];
  if (!enabled) return readers;
  for (let i = 0; i < 3; i++) {
    readers.push(() => `${tag}:${filter.label}:${filter.key * scale + i}`);
  }
  readers.push(() => (enabled ? tag.toUpperCase() : "off"));
  return readers;
}
const shared: Filter = { key: 2, skip: false, label: "first" };
const readers = makeReaders(shared, 10, "r", true);
shared.label = "renamed";
shared.key = 5;
console.log(readers.map((read) => read()).join(" "), makeReaders(shared, 1, "x", false).length);

function nested(base: number, word: string): () => () => string {
  return () => {
    const inner = () => `${word}${base}`;
    return inner;
  };
}
const outer = nested(7, "n");
console.log(outer()(), outer()(), nested(1, "m")()());

function guarded(limit: number, items: number[]): number {
  if (items.length === 0) throw new Error(`empty for ${limit}`);
  const picked = items.filter((item) => item < limit);
  if (picked.length === 0) throw new Error(`none below ${limit}`);
  return picked.reduce((sum, item) => sum + item + limit, 0);
}
for (const input of [[], [8, 9], [1, 2, 9]]) {
  try {
    console.log(guarded(5, input));
  } catch (error) {
    console.log("caught", (error as Error).message);
  }
}

function throwsInside(code: string): string {
  try {
    [1, 2].forEach((n) => {
      if (n === 2) throw new Error(`${code}-${n}`);
    });
    return "unreachable";
  } catch (error) {
    return `${(error as Error).message} ${code}`;
  }
}
console.log(throwsInside("q"));

// Recursive and repeated creation keeps each call's own value.
function countdown(n: number): string[] {
  if (n === 0) return [];
  const here = () => `step${n}`;
  return [here(), ...countdown(n - 1), here()];
}
console.log(countdown(3).join(","));

class Counter {
  total = 0;
  addAll(amount: number, times: number): number {
    const add = () => {
      this.total += amount;
    };
    for (let i = 0; i < times; i++) add();
    return this.total;
  }
}
const counter = new Counter();
console.log(counter.addAll(2, 3), counter.addAll(5, 1));

function delayed(message: string, order: string[]): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      order.push(message);
      resolve();
    }, 0);
  });
}
const order: string[] = [];
Promise.all([delayed("later", order), delayed("last", order)]).then(() => console.log(order.join(" ")));
