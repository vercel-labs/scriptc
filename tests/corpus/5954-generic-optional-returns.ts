// A generic function, method or arrow that returns an element read or an
// index-signature read answers undefined for a missing element or key, as
// in Node, for every instantiation.
export {};

function at<T>(items: T[], index: number): T {
  return items[index];
}
function lookup<T>(table: Record<string, T>, key: string): T {
  return table[key];
}
function viaBinding<T>(items: T[], index: number): T {
  const item = items[index];
  return item;
}
function either<T>(items: T[], index: number, fallback: T): T {
  return index >= 0 ? items[index] : fallback;
}
const first = <T,>(items: T[]): T => items[0];

console.log(at([1, 2], 1), at([1, 2], 5), at(["a"], 0), at(["a"], 3));
console.log(lookup({ a: 1 }, "a"), lookup({ a: 1 }, "b"), lookup({ s: "x" }, "t"));
console.log(viaBinding([true], 0), viaBinding([true], 2));
console.log(either([1], 4, 9), either([1], -1, 9));
console.log(first([7]), first<number>([]), first(["only"]));

const missing = at([10, 20], 7);
console.log(missing === undefined, typeof missing);
const label = lookup({ a: "A" }, "z");
console.log(label ?? "none", label === undefined);

class Store<T> {
  items: Record<string, T>;
  constructor(items: Record<string, T>) {
    this.items = items;
  }
  get(key: string): T {
    return this.items[key];
  }
  pick<K extends string>(keys: K[], index: number): K {
    return keys[index];
  }
}
const store = new Store({ a: 1 });
console.log(store.get("a"), store.get("b"), store.pick(["x", "y"], 1), store.pick(["x"], 4));

const pairs: [string, number][] = [["a", 1]];
function second<T>(rows: T[][], row: number, column: number): T {
  return rows[row][column];
}
console.log(second([[1, 2]], 0, 1), second([[1, 2]], 0, 9), second(pairs, 0, 1));

// An async generic function's promise is always present; its settled
// value is undefined for a missing element.
async function firstAsync<T>(items: T[]): Promise<T> {
  return items[0];
}
const lookupAsync = async <T,>(table: Record<string, T>, key: string): Promise<T> => table[key];
console.log(await firstAsync([1, 2]), await firstAsync<number>([]), (await firstAsync<string>([])) === undefined);
console.log(await lookupAsync({ a: "A" }, "a"), await lookupAsync({ a: "A" }, "b"));
async function settle(): Promise<void> {
  const found = await firstAsync(["x"]);
  const missing = await firstAsync<boolean>([]);
  console.log(found, missing, missing ?? "none");
}
await settle();
