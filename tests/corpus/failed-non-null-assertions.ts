// A non-null assertion that turns out wrong throws the TypeError Node gives
// the operation that consumes the value: a member read of null or
// undefined, or a call of a value that is not a function.
type Item = { weight: number };
function pick(items: (Item | null)[], i: number): Item | null {
  return items[i] ?? null;
}
const items: (Item | null)[] = [{ weight: 2 }, null];
console.log(pick(items, 0)!.weight);
try {
  console.log(pick(items, 1)!.weight);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
const maybe: Item | undefined = undefined as Item | undefined;
try {
  console.log(maybe!.weight);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
type Fn = () => number;
function lookup(i: number): Fn | null | undefined {
  return i === 0 ? () => 1 : i === 1 ? null : undefined;
}
for (const i of [0, 1, 2]) {
  try {
    console.log(lookup(i)!());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
function both(i: number): Item | null | undefined {
  return i === 0 ? { weight: 4 } : i === 1 ? null : undefined;
}
for (const i of [0, 1, 2]) {
  try {
    console.log(both(i)!.weight);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
