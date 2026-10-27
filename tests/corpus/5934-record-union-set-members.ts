// A record union used as Set elements and Map keys keeps the runtime's
// tagged representation; other unions over the same records convert to and
// from it without changing identity semantics.
type Point = { x: number; y: number };
type Named = { name: string };
type Item = Point | Named;

const items: Item[] = [{ x: 1, y: 2 }, { name: "a" }, { x: 3, y: 4 }];
const marked = new Set<Item>();
marked.add(items[0]!);
marked.add(items[0]!);
marked.add({ x: 1, y: 2 });
console.log(marked.size, marked.has(items[0]!), marked.has(items[1]!));

const counts = new Map<Item, number>();
for (const i of [...items, items[0]!, items[2]!]) counts.set(i, (counts.get(i) ?? 0) + 1);
console.log([...counts.values()].join(","));

function maybeItem(i: number): Item | undefined {
  return i < items.length ? items[i] : undefined;
}
for (let i = 0; i < 4; i++) {
  const m = maybeItem(i);
  console.log(i, m === undefined ? "none" : "x" in m ? m.x : m.name, m !== undefined && marked.has(m));
}
