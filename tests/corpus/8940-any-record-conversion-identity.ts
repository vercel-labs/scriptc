// Implicit conversions of `any` values into typed records and arrays keep
// one object: writes through either reference reach the same storage.

interface Narrow {
  id: number;
  name: string;
}

interface Point {
  x: number;
  y: number;
}

interface Shape {
  label: string;
  origin: Point;
  tags: string[];
}

// A typed binding from an untyped value with an extra key.
const loose: any = JSON.parse('{"id":1,"name":"a","extra":true}');
const probe: Narrow = loose;
probe.id = 99;
console.log(loose.id, probe.id, probe === loose, JSON.stringify(loose));

// Writes through the original after the conversion.
loose.name = "b";
console.log(probe.name);

// A typed parameter.
function rename(n: Narrow, name: string): void {
  n.name = name;
}
rename(loose, "c");
console.log(loose.name, probe.name);

// A typed return.
function asNarrow(value: any): Narrow {
  return value;
}
const literal: any = { id: 2, name: "d", more: [1] };
const returned = asNarrow(literal);
returned.id = 3;
console.log(literal.id, returned === literal);

// A later assignment to a typed binding.
let later: Narrow = { id: 0, name: "" };
const other: any = { id: 4, name: "e" };
later = other;
later.name = "f";
console.log(other.name);

// A field of a typed record.
const holder: { item: Narrow } = { item: { id: 0, name: "" } };
holder.item = other;
holder.item.id = 5;
console.log(other.id);

// Nested objects and arrays keep their identity too.
const raw: any = JSON.parse('{"label":"s","origin":{"x":1,"y":2},"tags":["t"]}');
const origin = raw.origin;
const shape: Shape = raw;
shape.origin.x = 10;
shape.tags.push("u");
console.log(origin.x, origin === shape.origin, raw.tags.length, JSON.stringify(raw));

// An array target.
const nums: any = [1, 2];
const typed: number[] = nums;
typed.push(3);
console.log(nums.length, typed === nums);

// An array of records.
const rows: any = JSON.parse('[{"x":1,"y":1},{"x":2,"y":2}]');
const points: Point[] = rows;
points[0]!.x = 7;
console.log(rows[0].x, points[1] === rows[1]);

// A union target with a record arm.
const maybe: Narrow | undefined = other;
if (maybe !== undefined) maybe.id = 6;
console.log(other.id);

