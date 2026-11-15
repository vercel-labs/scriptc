// A declared field wider than the value's field: no single storage can hold
// both the value's field and the declared field, so the annotation would
// copy the object and the write through it would reach only the copy.
type Wide = { next: string | number; count: number };

function f(): string | number {
  const value = { next: "x", count: 0 };
  const alias: Wide = value;
  alias.next = 42;
  return alias.next;
}

console.log(f());
