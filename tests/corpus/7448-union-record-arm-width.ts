// A checked cast to a union of record types keeps every field of the
// value: arms with more required fields, then more fields, are tried
// before an arm whose fields are all optional, which matches every object.
type Full = { p: number; q: string };
type Bare = { p?: number };
type Other = { r: boolean };

const values = JSON.parse('[{"p":5,"q":"x"},{},{"r":true},{"p":7}]') as (Full | Bare | Other)[];
for (const value of values) {
  const q = "q" in value ? value.q : "-";
  const r = "r" in value ? value.r : "-";
  console.log(JSON.stringify(value), "q" in value, "r" in value, q, r);
}

const one = JSON.parse('{"p":1,"q":"y"}') as Bare | Full;
console.log(JSON.stringify(one), "q" in one ? one.q : "no q");

type Point = { x: number; y?: number };
type Labeled = { x: number; label: string };
const points = JSON.parse('[{"x":1,"label":"a"},{"x":2,"y":3},{"x":4}]') as (Point | Labeled)[];
for (const point of points) console.log(point.x, "label" in point ? point.label : "none", "y" in point ? point.y : "none");
