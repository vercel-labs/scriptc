// A missing array element passed where a generic function declares a bare
// type parameter reaches the instance as `undefined`, and a result declared
// as that type parameter answers it.
function id<T>(v: T): T {
  return v;
}
function viaUnknown<T>(v: T): T {
  const u: unknown = v;
  return u as T;
}
function boxed<T>(v: T): T {
  const b = { v };
  return b.v;
}
function listed<T>(v: T): T {
  const a: T[] = [v];
  return a[0] as T;
}
function orElse<T>(v: T, fallback: T): T {
  return v === undefined ? fallback : v;
}
function show<T>(v: T): string {
  return String(v);
}
function isMissing<T>(v: T): boolean {
  return v === undefined;
}
const arrow = <T,>(v: T): T => v;

interface Point {
  x: number;
}

const values: number[] = [1, 2];
const names: string[] = ["n"];
const flags: boolean[] = [true];
const points: Point[] = [{ x: 1 }];

const direct = values[20];
const wrapped = id(values[20]);
console.log(direct === undefined, wrapped === undefined, id(values[1]), id(names[0]));

const name = id(names[9]);
const flag = viaUnknown(flags[3]);
const point = boxed(points[4]);
const listedValue = listed(values[8]);
console.log(name === undefined, flag === undefined, point === undefined, listedValue === undefined);
console.log(viaUnknown(flags[0]), boxed(points[0]), listed(values[0]));

console.log(orElse(values[5], 7), orElse(values[0], 7), orElse(names[2], "d"));
console.log(show(values[9]), show(names[0]), isMissing(points[9]), isMissing(points[0]));
console.log(arrow(names[3]) === undefined, arrow(names[0]));

// An annotated destination.
const annotated: string = id(names[4]);
console.log(annotated === undefined, typeof annotated);

function inFunction(): void {
  const local: boolean[] = [];
  const q = id(local[0]);
  console.log(q === undefined);
  const chained = id(id(names[6]));
  console.log(chained === undefined, id(id(names[0])));
}
inFunction();

// An in-bounds loop.
let sum = 0;
for (let i = 0; i < values.length; i++) sum += id(values[i]);
console.log(sum);
