// An array that holds generators is a checked-dynamic value, because a
// generator has no array storage. A generator read back out of one, by an
// element read, a loop, a callback, a pop or a destructuring, is the
// generator that went in: the same object, with its own position and its
// own channel for sent values.
function* count(from: number): Generator<number> {
  yield from;
  yield from + 1;
  yield from + 2;
}

const first = count(1);
const second = count(10);
const list = [first, second];
console.log(list.length, list.indexOf(second), list.includes(first), list.indexOf(count(5)));

// An element read into a typed binding.
const head = list[0]!;
console.log(head === first, head.next().value, first.next().value);

// A declared, empty array that is pushed into.
const pushed: Generator<number>[] = [];
pushed.push(second);
const again = pushed[0]!;
console.log(again === second, pushed.length, again.next().value, second.next().value);

// A callback parameter given the generator type again.
let hits = 0;
list.forEach((each) => {
  const typed: Generator<number> = each;
  if (typed === first || typed === second) hits++;
});
console.log(hits, list.map((each) => each.next().value).join(","));

// Stepping in a loop steps the generators the array holds.
for (const each of list) console.log(each.next().value);
console.log(first.next().done, second.next().done);

// A value sent with next(value) reaches the generator.
function* echo(): Generator<number, void, number> {
  let got = 0;
  for (;;) got = yield got * 2;
}
const source = echo();
const held = [source];
const back = held[0]!;
back.next(0);
console.log(back === source, back.next(21).value, source.next(4).value);

// Removing, replacing and destructuring.
const pair = [count(100), count(200)];
const [a, b] = pair;
const last = pair.pop()!;
const lead = pair.shift()!;
console.log(a === lead, b === last, pair.length, last.next().value, lead.next().value);
const slots = [first];
slots[0] = second;
const done = slots[0]!;
console.log(done === second, done.return(7).done, second.next().done);

// Arrays of arrays, a record member, and a generic helper.
const grid: Generator<number>[][] = [[count(7)], [count(8)]];
const cell = grid[1]![0]!;
console.log(cell.next().value, grid.length);
interface Pool {
  name: string;
  gens: Generator<number>[];
}
const pool: Pool = { name: "p", gens: [count(30), count(40)] };
const got = pool.gens[1]!;
const gotAgain = pool.gens[1]!;
console.log(got === gotAgain, got.next().value, pool.name);
function viaArray<T>(value: T): T {
  const kept: T[] = [value];
  const read = kept[0]!;
  return read;
}
const through = count(50);
console.log(viaArray(through) === through, viaArray(7), viaArray("text"));

// An iterator of another kind in a generator-typed slot of the same
// program still steps through its adapter.
const values: IterableIterator<number> = new Map<string, number>([["k", 5]]).values();
console.log(values.next().value, values.next().done);

// Async generators.
async function* ticks(): AsyncGenerator<number> {
  yield 1;
  yield 2;
}
const ticker = ticks();
const tickers = [ticker];
const sameTicker = tickers[0]!;
console.log(sameTicker === ticker);
void sameTicker.next().then((step) => console.log(step.value));
