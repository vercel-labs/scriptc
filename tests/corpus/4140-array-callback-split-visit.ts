// Inline array callbacks over plain element types: a present value reaches
// the callback as the element itself, while holes and present undefined
// still reach it as undefined. Pins arguments, mutation during iteration,
// captured bindings, exceptions, and nested callbacks on both paths.
interface Item {
  id: number;
  tag: string;
}
class Box {
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  twice(): number {
    return this.n * 2;
  }
}

const items: Item[] = [
  { id: 1, tag: "a" },
  { id: 2, tag: "b" },
  { id: 3, tag: "a" },
];
// Spreading a holey array materializes present undefined values.
const holey: Item[] = [];
holey[1] = { id: 7, tag: "z" };
holey.length = 3;
const padded: Item[] = [...holey];

function describe(label: string, run: () => unknown): void {
  try {
    console.log(label, JSON.stringify(run()));
  } catch (error) {
    if (error instanceof Error) console.log(label, "threw", error.name, error.message);
  }
}

describe("map", () => items.map((item) => item.id * 10));
describe("map-index-array", () => items.map((item, index, array) => `${item.tag}${index}/${array.length}`));
describe("filter", () => items.filter((item) => item.tag === "a").map((item) => item.id));
describe("filter-index", () => items.filter((_item, index) => index !== 1).length);
describe("some", () => items.some((item) => item.id === 3));
describe("every", () => items.every((item) => item.id > 0));
describe("findIndex", () => items.findIndex((item) => item.tag === "b"));
describe("findLastIndex", () => items.findLastIndex((item) => item.tag === "a"));
describe("flatMap", () => items.flatMap((item) => (item.tag === "a" ? [item.id, -item.id] : [])));
describe("flatMap-scalar", () => items.flatMap((item) => item.id + 0.5));
describe("reduce", () => items.reduce((sum, item) => sum + item.id, 100));
describe("reduce-seedless", () => items.map((item) => item.id).reduce((a, b) => a * b));
describe("reduceRight", () => items.reduceRight((acc, item) => acc + item.tag, ">"));

// Holes are skipped by map/filter/some/every/forEach/reduce/flatMap and
// visited as undefined by findIndex; present undefined is always visited.
describe("holey-map", () => holey.map((item) => item.id).length);
describe("holey-filter", () => holey.filter((item) => item.id > 0).length);
describe("holey-findIndex", () => holey.findIndex((item) => item === undefined));
describe("padded-findIndex", () => padded.findIndex((item) => item === undefined));
describe("padded-some-throws", () => padded.some((item) => item.id === 7));
describe("padded-every-guarded", () => padded.every((item) => item === undefined || item.id === 7));
describe("padded-filter-guarded", () => padded.filter((item) => item === undefined || item.id > 0).length);
describe("padded-map-throws", () => padded.map((item) => item.tag));
describe("padded-reduce-guarded", () =>
  padded.reduce((acc, item) => acc + (item === undefined ? "u" : item.tag), ""),
);
describe("padded-flatMap-guarded", () => padded.flatMap((item) => (item === undefined ? [0] : [item.id])));
let seen = "";
padded.forEach((item, index) => {
  seen += item === undefined ? `u${index}` : `${item.tag}${index}`;
});
console.log("padded-forEach", seen);
const keptUndefined = padded.filter((item): boolean => item === undefined);
console.log("kept-undefined", keptUndefined.length, keptUndefined.findIndex((item) => item === undefined));

// Class elements and method calls inside the callback.
const boxes = [new Box(1), new Box(2), new Box(3)];
describe("class-map", () => boxes.map((box) => box.twice()));
describe("class-filter", () => boxes.filter((box) => box.twice() > 2).length);

// Mutation during iteration: the length is read once; elements are read fresh.
const growing: Item[] = [{ id: 1, tag: "g" }, { id: 2, tag: "g" }];
describe("push-during-map", () =>
  growing.map((item) => {
    growing.push({ id: item.id + 10, tag: "h" });
    return item.id;
  }),
);
console.log("grown", growing.length);
const shrinking: Item[] = [{ id: 1, tag: "s" }, { id: 2, tag: "s" }, { id: 3, tag: "s" }];
describe("shrink-during-filter", () =>
  shrinking.filter((item, index) => {
    if (index === 0) shrinking.length = 2;
    return item.id > 0;
  }).length,
);
const replacing: Item[] = [{ id: 1, tag: "r" }, { id: 2, tag: "r" }];
describe("replace-during-some", () =>
  replacing.some((item, index) => {
    if (index === 0) replacing[1] = { id: 99, tag: "x" };
    return item.id === 99;
  }),
);

// Captured bindings: per-iteration lets, mutated counters, escaping closures.
const readers: (() => number)[] = [];
let calls = 0;
for (let round = 0; round < 3; round++) {
  const picked = items.filter((item) => {
    calls++;
    return item.id > round;
  });
  readers.push(() => round * 100 + picked.length);
  const scale = round + 1;
  console.log("round", round, picked.map((item) => item.id * scale).join(","), calls);
}
console.log("readers", readers.map((read) => read()).join(","));

// Exceptions leave the loop at the throwing element.
let visited = 0;
describe("throw-in-map", () =>
  items.map((item) => {
    visited++;
    if (item.id === 2) throw new RangeError(`bad ${item.tag}`);
    return item.id;
  }),
);
console.log("visited", visited);

// Nested callbacks over the same and other arrays.
describe("nested", () =>
  items.map((outer) => items.filter((inner) => inner.tag === outer.tag).map((inner) => inner.id).join("+")),
);
describe("nested-reduce", () =>
  items.reduce((acc, outer) => acc + items.filter((inner) => inner.id <= outer.id).length, 0),
);
