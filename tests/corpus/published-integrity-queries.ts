import { publish } from "@scriptc/threads";

// Object.isFrozen, Object.isSealed and Object.isExtensible on published
// values. Under Node.js, publish() deep-freezes the graph, so every object it
// reaches is frozen, sealed and not extensible. Unpublished values of the same
// types keep their own state.

class Box {
  items: number[];
  constructor(items: number[]) {
    this.items = items;
  }
}

class Link {
  next: Link | undefined = undefined;
  label = "link";
}

interface Point {
  x: number;
  inner: { y: number };
}

function report(name: string, value: object): void {
  console.log(name, Object.isFrozen(value), Object.isSealed(value), Object.isExtensible(value));
}

const box = publish(new Box([]));
report("class", box);
report("class field array", box.items);
report("numbers", publish([1, 2]));
report("strings", publish(["a", "b"]));
const point: Point = publish({ x: 1, inner: { y: 2 } });
report("record", point);
report("nested record", point.inner);
report("map", publish(new Map([["a", 1]])));
report("set", publish(new Set([1])));
const chain = new Link();
chain.next = new Link();
publish(chain);
report("chain", chain);
report("chain next", chain.next!);
const loose: unknown = publish({ z: [3] });
report("unknown", loose as object);
report("unknown field", (loose as { z: number[] }).z);

// The same queries on statically typed values.
const numbers = publish([4, 5]);
const pair = publish({ x: 3, inner: { y: 4 } });
const table = publish(new Map([["b", 2]]));
const members = publish(new Set(["s"]));
console.log(
  "typed",
  Object.isFrozen(numbers),
  Object.isFrozen(pair),
  Object.isFrozen(pair.inner),
  Object.isFrozen(table),
  Object.isFrozen(members),
  Object.isFrozen(box),
  Object.isFrozen(box.items),
);
console.log("typed sealed", Object.isSealed(table), Object.isSealed(members), Object.isSealed(box));
console.log(
  "typed extensible",
  Object.isExtensible(table),
  Object.isExtensible(members),
  Object.isExtensible(box),
);
const otherNumbers = [4, 5];
const otherPair = { x: 3, inner: { y: 4 } };
const otherTable = new Map([["b", 2]]);
console.log(
  "typed unpublished",
  Object.isFrozen(otherNumbers),
  Object.isFrozen(otherPair),
  Object.isFrozen(otherTable),
  Object.isExtensible(otherTable),
  Object.isFrozen(new Box([])),
);

// Unpublished values of the same types.
report("unpublished class", new Box([1]));
report("unpublished numbers", [1, 2]);
report("unpublished record", { x: 1, inner: { y: 2 } });
report("unpublished map", new Map<string, number>());
report("unpublished set", new Set<number>());
const fresh = new Link();
report("unpublished chain", fresh);
fresh.next = new Link();
report("unpublished chain next", fresh.next);

// Frozen without publishing.
report("frozen record", Object.freeze({ x: 1, inner: { y: 2 } }));
report("frozen numbers", Object.freeze([1, 2]));

// Writes into published values still throw.
try {
  box.items.push(1);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
try {
  (chain as { label: string }).label = "changed";
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
