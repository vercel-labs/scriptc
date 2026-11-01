// An annotated record declaration whose value names an existing record
// keeps the value's layout when every field the annotation declares fits
// its storage, so both names are one object: a write through either is
// visible through the other, as in Node, instead of a width copy taking
// the write. The `next` slot is untyped, so the declared union fits it.

type Value = { value: number };
type Box = { next: Value | undefined; count: number };

function openConst(next: any, count: number): [number, number] {
  const value = { next, count };
  const alias: Box = value;
  alias.next = { value: 42 };
  value.count++;
  return [alias.next.value, alias.count];
}

function openLet(next: any, count: number): [number, number] {
  const value = { next, count };
  let alias: Box = value;
  alias.next = { value: 7 };
  value.count += 2;
  return [alias.next.value, alias.count];
}

console.log(openConst(undefined, 0).join(","));
console.log(openLet(undefined, 0).join(","));

// A module-level binding keeps it too.
const shared = { next: undefined as any, count: 5 };
const sharedAlias: Box = shared;
sharedAlias.next = { value: 1 };
shared.count++;
console.log(sharedAlias.next.value, sharedAlias.count);

// An array field keeps the value's element storage, so a push through
// either name is visible through the other.
type List = { items: number[] };

function pushThrough(seed: any[]): [number, number] {
  const value = { items: seed };
  const alias: List = value;
  alias.items.push(9);
  value.items.push(4);
  return [alias.items.length, value.items.length];
}

console.log(pushThrough([1]).join(","));

// A bracket write reaches the field in the kept layout, so both names see it.
function bracketWrite(next: any, start: number): [number, number] {
  const value = { next, count: start };
  const alias: Box = value;
  alias["count"] = 3;
  return [alias.count, value.count];
}

console.log(bracketWrite(undefined, 1).join(","));

// A member of another binding that kept the layout stores without a copy:
// the push through `one.list` is visible through `two.list`.
type Item = { list: number[] };

function memberStore(seed: any[]): number {
  const wide = { list: seed };
  const one: Item = wide;
  const two: Item = wide;
  two.list = one.list;
  one.list.push(2);
  return two.list.length;
}

console.log(memberStore([1]));
