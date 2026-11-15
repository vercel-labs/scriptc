// @requires-libnode
// A program record type that receives island values is a live view (wave-2
// 6 = C), and so are the program records its members are declared with: a
// member read from the island's object is the island's own nested object,
// whichever way the member's type names the record. Reading one into a
// binding used to throw `TypeError: expected object at $, got Object`,
// because only the type at the crossing was a view.
import { make, later, touch, same, innerOf, describe, keep, bumpKept } from "nest-pkg";

interface Inner {
  n: number;
}
interface Box<T> {
  value: T;
}
interface Chain {
  v: number;
  next?: Chain;
}
interface Outer {
  n: number;
  inner: Inner;
  opt?: Inner;
  missing?: Inner;
  either: Inner | string;
  byName: Record<string, Inner>;
  deep: { a: { b: Inner } };
  box: Box<Inner>;
  mixed: Inner & { extra?: string };
  chain: Chain;
  label: () => string;
  bytes: Uint8Array;
  later: Promise<number>;
  job: Promise<Inner>;
}

function read(i: Inner): number {
  return i.n;
}
function walk(c: Chain | undefined): string {
  const seen: number[] = [];
  for (let at = c; at !== undefined; at = at.next) seen.push(at.v);
  return seen.join(">");
}

const o = make<Outer>();
// Each nested record, held in a binding of its own type.
const inner = o.inner;
const opt = o.opt;
const missing = o.missing;
const either = o.either;
const byName = o.byName;
const entry = byName.a;
const a = o.deep.a;
const b = a.b;
const box = o.box;
const value = box.value;
const mixed = o.mixed;
const chain = o.chain;
let held: Inner | null = null;
function hold(i: Inner): void {
  held = i;
}
hold(o.inner);

function show(): void {
  console.log(
    inner.n,
    opt?.n,
    missing === undefined,
    typeof either === "string" ? either : either.n,
    entry.n,
    b.n,
    value.n,
    mixed.n,
    mixed.extra,
    read(o.inner),
    held!.n,
    walk(chain),
  );
}
show();
// The nested objects are the island's own, not copies.
console.log(same(inner, innerOf()), same(held, innerOf()), same(o.inner, inner));
// The island writes to every nested object; each binding sees it.
touch();
show();
// A write through a nested view lands on the island's object.
inner.n = 20;
entry.n = 21;
chain.next!.v = 22;
console.log(describe());
// Members that are not records keep their own crossing: an island function
// is called through the bridge, bytes share their memory, a promise is
// adopted.
console.log(o.label(), o.bytes.length, o.bytes[2], await o.later);
// A promise-typed member settles with the island's own object, and so does
// an island promise of the whole type: the payload and its members are
// views behind the promise too.
const job = await o.job;
const viaPromise = await later<Outer>();
const awaitedInner = viaPromise.inner;
console.log(job.n, same(job, innerOf()), same(awaitedInner, innerOf()), same(viaPromise, o));

// The program's own values of the same types are live objects too, and the
// island reads and writes them in place.
const mine: Outer = {
  n: 0,
  inner: { n: 30 },
  either: "text",
  byName: { a: { n: 31 } },
  deep: { a: { b: { n: 32 } } },
  box: { value: { n: 33 } },
  mixed: { n: 34 },
  chain: { v: 35 },
  label: () => "mine",
  bytes: new Uint8Array(1),
  later: Promise.resolve(36),
  job: Promise.resolve({ n: 37 }),
};
const mineInner = mine.inner;
const back = keep(mine);
bumpKept();
console.log(back === mine, mineInner.n, mine.inner.n, Object.keys(mine.byName).join(","), mine.byName.b?.n);
console.log(mine.either, mine.label(), walk(mine.chain), await mine.later, (await mine.job).n);
