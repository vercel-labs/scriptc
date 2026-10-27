// Iterator helpers over generators, stored array iterators and Map/Set
// iterators: chains that end in a consuming method, helper objects driven
// by next(), for...of, spreads, Array.from and yield*, and the points at
// which a helper closes its source (runs its return()).
const log: string[] = [];
function* count(label: string, n: number): Generator<number> {
  try {
    for (let i = 1; i <= n; i++) {
      log.push(`${label}${i}`);
      yield i;
    }
  } finally {
    log.push(`${label}:closed`);
  }
}
function flush(what: unknown): void {
  console.log(what, "|", log.join(" "));
  log.length = 0;
}

// Consuming methods over generator chains.
flush(count("a", 5).map((x) => x * 10).filter((x) => x !== 20).toArray());
flush(count("b", 4).reduce((acc, x) => acc + x));
flush(count("c", 4).reduce((acc, x, i) => acc + x * i, 100));
flush(count("d", 5).some((x) => x === 2));
flush(count("e", 5).every((x) => x < 3));
flush(count("f", 5).find((x) => x > 3) ?? -1);
flush(count("g", 2).find((x) => x > 3) ?? -1);
let each = "";
count("h", 3).forEach((x, i) => {
  each += `${x}@${i} `;
});
flush(each.trim());

// take, drop and their budgets.
flush(count("i", 9).drop(2).take(3).toArray());
flush(count("j", 3).take(Infinity).toArray());
flush([count("k", 4).take(2.9).toArray(), count("l", 4).drop(1.5).toArray()]);
for (const budget of [-1, NaN, -0.5]) {
  try {
    console.log(count("m", 1).take(budget).toArray());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
try {
  count("n", 0).reduce((a, b) => a + b);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
flush("budgets");

// An invalid budget closes a started source before the RangeError.
const invalid = count("bad", 3);
invalid.next();
try {
  invalid.take(-1);
} catch (e) {
  log.push((e as Error).message);
}
flush(invalid.next().done);

// A started source closes through take(0) without another pull.
const started = count("o", 3);
started.next();
flush([started.take(0).toArray(), started.next().done]);

// Helper objects step lazily, one source value per delivered value.
const h = count("p", 4)
  .map((x) => x * 2)
  .filter((x) => x !== 4);
log.push("made");
console.log(h.next(), h.next());
console.log(h.next(), h.next());
flush("next");
const words = count("q", 3).map((x, i) => "w".repeat(x) + i);
flush([...words]);
flush(Array.from(count("r", 3).drop(1)));
function* wrap(): Generator<number> {
  yield 0;
  yield* count("s", 2).map((x) => -x);
  yield 9;
}
flush([...wrap()]);
function sum(it: Iterator<number>): number {
  let total = 0;
  for (let r = it.next(); !r.done; r = it.next()) total += r.value;
  return total;
}
flush(sum(count("t", 4).filter((x) => x % 2 === 0)));

// next() from inside the helper's own callback.
const self: IteratorObject<number> = count("re", 2).map((x) => {
  if (x === 2) {
    try {
      self.next();
    } catch (e) {
      log.push(`${(e as Error).name}: ${(e as Error).message}`);
    }
  }
  return x;
});
flush(self.toArray());

// Leaving a for...of over a helper closes the helper and its source.
for (const x of count("u", 9).map((v) => v * v)) {
  if (x > 4) break;
  log.push(`got${x}`);
}
flush("break");
try {
  count("v", 3).forEach((x) => {
    if (x === 2) throw new Error("callback threw");
  });
} catch (e) {
  log.push((e as Error).message);
}
flush("throw");
function* failing(): Generator<number> {
  try {
    yield 1;
    throw new Error("source threw");
  } finally {
    log.push("failing:finally");
  }
}
try {
  failing().map((x) => x).toArray();
} catch (e) {
  log.push((e as Error).message);
}
flush("source");
// When closing the source throws while another error propagates, the
// first error is the one that reaches the caller.
function* closeThrows(): Generator<number> {
  try {
    yield 1;
  } finally {
    log.push("closeThrows:finally");
    throw new Error("close threw");
  }
}
try {
  closeThrows()
    .map((x): number => {
      if (x > 0) throw new Error("callback threw");
      return x;
    })
    .toArray();
} catch (e) {
  log.push((e as Error).message);
}
try {
  for (const x of closeThrows().filter(() => true)) throw new Error(`body threw at ${x}`);
} catch (e) {
  log.push((e as Error).message);
}
try {
  for (const x of closeThrows()) throw new Error(`plain loop threw at ${x}`);
} catch (e) {
  log.push((e as Error).message);
}
flush("close errors");

// flatMap over arrays and generators; take stops mid-way through an inner
// generator and closes it before the outer source.
flush(count("w", 2).flatMap((x) => [x, -x]).toArray());
flush(count("x", 3).flatMap((x) => count(`y${x}-`, 2)).take(3).toArray());

// Map and Set iterators, observed live.
const set = new Set([1, 2, 3]);
console.log(
  set
    .values()
    .map((x) => {
      if (x === 1) set.add(4);
      if (x === 2) set.delete(3);
      return x * 100;
    })
    .toArray(),
);
const map = new Map<string, number>([
  ["a", 1],
  ["b", 2],
  ["c", 3],
]);
const pairs = map.entries().filter(([, v]) => v !== 2);
map.set("d", 4);
console.log([...pairs].map(([k, v]) => k + v).join(","));
console.log(map.keys().map((k) => k.toUpperCase()).toArray(), map.values().reduce((a, b) => a + b, 0));
console.log(set.keys().some((x) => x > 3), set.entries().find(([k]) => k === 2)?.[1]);

// Array iterators as helper sources.
const nums = [5, 6, 7];
const doubled = nums.values().map((x) => x * 2);
nums.push(8);
console.log([...doubled], nums.keys().filter((i) => i > 0).toArray(), [...nums.entries().drop(2)]);

// Records and strings flow through the stages by reference.
interface Item {
  name: string;
  qty: number;
}
const items: Item[] = [
  { name: "pen", qty: 3 },
  { name: "ink", qty: 0 },
  { name: "pad", qty: 7 },
];
function* stock(): Generator<Item> {
  yield* items;
}
const inStock = stock().filter((it) => it.qty > 0);
console.log(inStock.next().value === items[0], stock().find((it) => it.name === "pad")?.qty);
console.log(stock().map((it) => `${it.name}x${it.qty}`).toArray().join(" "));
