// Object.create written where a record type is expected: a record holds its
// declared members as its own properties, so the created object, which
// inherits them, is refused at the call.
interface Base {
  shared: number;
  name: string;
}
const base: Base = { shared: 1, name: "b" };

const declared: Base = Object.create(base);
const asserted = Object.create(base) as Base;
const optional: Base | undefined = Object.create(base);
function make(): Base {
  return Object.create(base);
}
function take(value: Base): number {
  return value.shared;
}
const described: { v: number } = Object.create(null, { v: { value: 3, enumerable: true } });
const emptyRecord = Object.create(null) as { x?: number };
const inherited = Object.create(base) as Record<string, number>;

console.log(declared.shared, asserted.shared, optional?.shared, make().shared, take(Object.create(base)));
console.log(described.v, emptyRecord.x, inherited.shared);
