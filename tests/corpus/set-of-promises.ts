// A Set of promises. A promise is one object for its whole life, so its
// native reference IS its JavaScript identity: the set stores it like a
// record key — pointer identity, with the promise's own retain/release
// and trace adapters. Adding the same promise twice keeps one element,
// `delete`/`has` compare by identity, and spreading the set into
// `Promise.all` awaits each promise once, in insertion order.
const settled: string[] = [];

function tick(label: string, ms: number): Promise<string> {
  return new Promise<string>((resolve) => {
    setTimeout(() => {
      settled.push(label);
      resolve(label);
    }, ms);
  });
}

async function main(): Promise<void> {
  const pending = new Set<Promise<string>>();
  const a = tick("a", 5);
  const b = tick("b", 1);
  pending.add(a);
  pending.add(b);
  pending.add(a); // identity dedupe: one element, not two
  console.log("size", pending.size);
  console.log("has", pending.has(a), pending.has(b));

  const all = await Promise.all([...pending]);
  console.log("all", all.join(","));
  console.log("settled", settled.join(","));
  console.log("size after", pending.size);

  console.log("delete b", pending.delete(b), "size", pending.size);
  console.log("has b", pending.has(b), "delete b again", pending.delete(b));
  pending.add(b);
  console.log("re-add", pending.size);

  // A settled promise stays in the set, and iteration follows insertion
  // order.
  for (const p of pending) {
    console.log("member", await p);
  }

  // A set seeded from another set copies its members by identity.
  const copy = new Set<Promise<string>>(pending);
  console.log("copy", copy.size, copy.has(a), copy.has(b));
  pending.clear();
  console.log("cleared", pending.size, "copy", copy.size);

  // A promise resolved later joins a set that already holds others.
  const later = new Set<Promise<number>>();
  later.add(Promise.resolve(1));
  later.add(
    new Promise<number>((resolve) => {
      setTimeout(() => resolve(2), 1);
    }),
  );
  console.log("later", (await Promise.all([...later])).join(","));

  // A promise that went through `unknown` is the same key: `===` holds, and
  // Set.has, Map.get and a second add find the stored promise.
  const stored: Promise<number> = Promise.resolve(3);
  const keyed = new Set<Promise<number>>([stored]);
  const named = new Map<Promise<number>, string>([[stored, "stored"]]);
  const opaque: unknown = stored;
  const back = opaque as Promise<number>;
  console.log("round trip", back === stored, keyed.has(back), named.get(back));
  keyed.add(back);
  named.set(back, "again");
  console.log("one key", keyed.size, named.size, named.get(stored), await back);
}

main();
