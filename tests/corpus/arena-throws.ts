// A builder that throws part way: the arena of the group it was building
// is dropped as the exception leaves, and building goes on afterwards.
interface Item {
  id: number;
  tags: string[];
  next: Item | null;
}

function chain(n: number, failAt: number): Item {
  let head: Item = { id: 0, tags: ["head"], next: null };
  const first = head;
  for (let i = 1; i < n; i++) {
    if (i === failAt) throw new Error(`failed at ${i} of ${n}`);
    const item: Item = { id: i, tags: [`t${i}`, `u${i % 3}`], next: null };
    head.next = item;
    head = item;
  }
  return first;
}

function length(item: Item | null): number {
  let n = 0;
  for (let at = item; at !== null; at = at.next) n++;
  return n;
}

let built = 0;
let failed = 0;
for (let round = 0; round < 60; round++) {
  try {
    const c = chain(20 + (round % 7), round % 5 === 0 ? 10 + (round % 3) : -1);
    built += length(c) + c.next!.tags.length;
  } catch (e) {
    failed++;
    if (round < 20) console.log("caught", (e as Error).message);
  }
}
console.log("built", built, "failed", failed);
const last = chain(5, -1);
console.log(last.id, last.next!.id, last.next!.tags.join("/"), length(last));
