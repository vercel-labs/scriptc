// An untyped object that reaches a typed slot whose type can hold the empty
// literal's record (a union arm that declares no field) keeps every property
// under its other names. That record has no place for them, so the slot takes
// a copy and the source stays the object it was. Each block is one kind of
// slot; every line reads the source through an untyped name.

const none = {};
type Slot = typeof none | number;
type Text = typeof none | string;
type Either = { a: number } | typeof none;
type Box = { slot: Slot; n: number };

function make(n: number): any {
  if (n === 0) return { a: 1, b: "two" };
  if (n === 1) return { x: 1, y: [1, 2], z: { w: "w" } };
  return { p: 1, q: { r: 2 } };
}

function show(label: string, value: any): void {
  console.log(label, JSON.stringify(value), Object.keys(value).join(","));
}

// An annotated binding.
{
  const src: any = make(0);
  const keep: any = src;
  const slot: Slot = src;
  console.log("binding:", typeof slot);
  show("  source", keep);
  keep.c = 3;
  show("  after a write", src);
  console.log("  reads:", src.a, src.b, src.c);
}

// A typed parameter, with parsed text held in a variable.
{
  const take = (value: Text): string => typeof value;
  const parsed: any = JSON.parse('{"name":"n","items":[1,2,3],"inner":{"k":true}}');
  const keep: any = parsed;
  console.log("parameter:", take(parsed));
  show("  source", keep);
  console.log("  reads:", keep.name, keep.items.length, keep.inner.k);
}

// A returned value.
{
  const bag: any = make(2);
  const give = (): Text => bag;
  const got = give();
  console.log("return:", typeof got);
  show("  source", bag);
  console.log("  reads:", bag.p, bag.q.r);
}

// A stored field and a pushed element.
{
  class Holder {
    slot: Text = "";
    list: Slot[] = [];
  }
  const holder = new Holder();
  const first: any = { m: "m", n: [1] };
  const second: any = make(1);
  const alias: any = first;
  holder.slot = first;
  holder.list.push(second);
  console.log("field:", typeof holder.slot, holder.list.length);
  show("  field source", alias);
  show("  element source", second);
  console.log("  reads:", alias.m, second.x, second.z.w);
}

// A union of a record with fields and the empty literal's record: a source
// that fits the first arm and holds more, and one that fits only the second.
{
  const fits: any = make(0);
  const keepFits: any = fits;
  const one: Either = fits;
  console.log("either, first arm:", typeof one);
  show("  source", keepFits);
  const other: any = make(1);
  const keepOther: any = other;
  const two: Either = other;
  console.log("either, second arm:", typeof two);
  show("  source", keepOther);
  keepOther.added = 1;
  show("  after a write", other);
}

// The union as a field of the slot's record: the inner object has another
// holder.
{
  const inner: any = make(0);
  const outer: any = { slot: inner, n: 1 };
  const keep: any = outer;
  const box: Box = outer;
  console.log("nested field:", box.n, typeof box.slot);
  show("  inner", inner);
  show("  outer", keep);
}

// The union as the element of the slot's array: two elements have another
// holder.
{
  const list: any = [{ a: 1 }, 2, { b: "b", c: null }];
  const first: any = list[0];
  const third: any = list[2];
  const typed: Slot[] = list;
  console.log("element:", typed.length);
  show("  first", first);
  show("  third", third);
  console.log("  list:", JSON.stringify(list));
}
