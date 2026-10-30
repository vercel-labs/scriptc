// Methods on arrays of unknown elements, which are stored checked-dynamic:
// direct `unknown[]` bindings and generic bodies instantiated at `unknown`.
const values: unknown[] = [1, "two", 3, { four: 4 }];
const removed = values.splice(1, 2);
console.log(values, removed, removed.length);
values.splice(1, 0, "inserted", null);
console.log(values, values.indexOf(null), values.includes("inserted"));
console.log(values.slice(1).reverse(), values.join("|"));

function takeAt<T>(items: readonly T[], index: number): T[] {
  const pool = [...items];
  return pool.splice(index, 1);
}
console.log(takeAt([10, 20, 30], 1), takeAt<unknown>([true, "x", 7], 2));
