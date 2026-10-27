// Record unions meet other representations: widening into unions with
// string and number arms, narrowing back, `in` tests on undiscriminated
// arms, generic helpers, class fields and promises.
type Point = { x: number; y: number };
type Named = { name: string };
type Item = Point | Named;
type Wide = Item | string | number;

function describe(i: Item): string {
  return "x" in i ? `point(${i.x},${i.y})` : `named(${i.name})`;
}

function widen(i: Item): Wide {
  return i;
}

function narrow(w: Wide): Item | undefined {
  if (typeof w === "string" || typeof w === "number") return undefined;
  return w;
}

const items: Item[] = [{ x: 1, y: 2 }, { name: "a" }, { x: 3, y: 4 }];
const wide: Wide[] = items.map(widen);
wide.push("text", 42);
for (const w of wide) {
  const back = narrow(w);
  console.log(typeof w, back === undefined ? "-" : describe(back), back !== undefined && items.includes(back));
}

// Generic helpers instantiate over the union.
function firstWhere<T>(xs: T[], pred: (x: T) => boolean): T | undefined {
  for (const x of xs) if (pred(x)) return x;
  return undefined;
}
const named = firstWhere(items, (i) => "name" in i);
console.log(named === items[1], named !== undefined ? describe(named) : "none");
const pair: [Item, Item] = [items[2]!, items[0]!];
const [p0, p1] = pair;
console.log(describe(p0), describe(p1));

// Class fields and methods.
class Cursor {
  private at: Item;
  readonly seen: Item[] = [];
  constructor(start: Item) {
    this.at = start;
  }
  move(next: Item): Item {
    const prev = this.at;
    this.seen.push(prev);
    this.at = next;
    return prev;
  }
  get current(): Item {
    return this.at;
  }
}
const cursor = new Cursor(items[0]!);
for (const i of items) cursor.move(i);
console.log(describe(cursor.current), cursor.seen.map(describe).join(" "));

// Promises carry union payloads.
async function load(i: number): Promise<Item> {
  await null;
  return items[i % items.length]!;
}
async function main(): Promise<void> {
  const loaded: Item[] = [];
  for (const i of [0, 1, 5]) loaded.push(await load(i));
  console.log(loaded.map(describe).join(" "), loaded[0] === items[0]);
  const slow = new Promise<Item>((resolve) => setTimeout(() => resolve({ x: 9, y: 9 }), 5));
  const raced = await Promise.race([load(1), slow]);
  console.log(describe(raced));
  const pending: Promise<Item>[] = [load(2), load(0)];
  const all = await Promise.all(pending);
  console.log(all.map(describe).join(" "), all[1] === items[0]);
}
main().then(() => console.log("done"));
