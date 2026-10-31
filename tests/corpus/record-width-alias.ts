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
