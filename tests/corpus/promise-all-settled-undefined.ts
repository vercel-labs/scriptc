// Promise.all over promises whose settled type admits undefined keeps the
// undefined entries in its result, for reads, callbacks and iteration.

class Item {
  weight: number;
  constructor(weight: number) {
    this.weight = weight;
  }
}

async function maybe(i: number): Promise<number | undefined> {
  return i === 1 ? undefined : i * 10;
}

async function find(i: number): Promise<Item | undefined> {
  return i % 2 === 0 ? new Item(i) : undefined;
}

async function main(): Promise<void> {
  const pending: Promise<number | undefined>[] = [
    Promise.resolve(1),
    Promise.resolve(undefined),
    Promise.resolve(3),
  ];
  const numbers = await Promise.all(pending);
  numbers.forEach((value) => console.log(value));
  console.log(numbers.map((value) => (value === undefined ? -1 : value * 2)).join(","));
  console.log(numbers.filter((value) => value !== undefined).length);
  console.log(numbers.some((value) => value === undefined));
  for (const value of numbers) console.log(typeof value);
  console.log(numbers[1], numbers.indexOf(undefined), numbers.includes(undefined));

  const mapped = await Promise.all([0, 1, 2].map((i) => maybe(i)));
  mapped.forEach((value, index) => console.log(index, value));
  console.log(mapped.reduce((sum: number, value) => sum + (value ?? 0), 0));

  const flags: Promise<boolean | undefined>[] = [Promise.resolve(true), Promise.resolve(undefined)];
  (await Promise.all(flags)).forEach((value) => console.log(value));

  const items = await Promise.all([0, 1, 2, 3].map((i) => find(i)));
  console.log(items.map((item) => (item === undefined ? "none" : String(item.weight))).join(","));
  console.log(items.filter((item) => item !== undefined).length);
}

void main();
