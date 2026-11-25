// Inside a generic function TypeScript types a member receiver by the type
// parameter's constraint (`T extends A | B | C` reads as `A | B | C`), while
// an instantiation stores its own type argument. When the program's arrays
// can hold absent elements the loop variable also stores undefined; the read
// goes through the stored value, and an absent element throws Node's own
// TypeError.
interface A {
  id: string;
  kind: "a";
  size: number;
}
interface B {
  id: string;
  kind: "b";
  tags: string[];
}
interface C {
  id: string;
  kind: "c";
  flag: boolean;
}
type Any = A | B | C;
function kindOf(m: Any): string {
  return m.kind;
}
function merge<T extends Any>(base: readonly T[], extra: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const m of [...base, ...extra]) merged.set(`${m.id}\0${kindOf(m)}`, m);
  return [...merged.values()];
}
function ids<T extends Any>(list: readonly T[]): string {
  let out = "";
  for (const m of [...list]) out += m.id.toUpperCase() + m.kind;
  return out;
}

// A store past the end through a generic element type: arrays of any
// element type may now hold absent elements as far as the build can tell.
function put<T>(xs: T[], at: number, v: T): void {
  xs[at] = v;
}
const sparse: A[] = [];
put(sparse, 2, { id: "s", kind: "a", size: 0 });
console.log(sparse.length);

const as: A[] = [
  { id: "1", kind: "a", size: 1 },
  { id: "2", kind: "a", size: 2 },
];
const ab: (A | B)[] = [
  { id: "1", kind: "a", size: 1 },
  { id: "2", kind: "b", tags: ["x"] },
];
const mixed: Any[] = [
  { id: "1", kind: "a", size: 1 },
  { id: "2", kind: "b", tags: ["x"] },
  { id: "3", kind: "c", flag: true },
];
// One stored record, a stored sub-union, and the whole constraint.
console.log(JSON.stringify(merge(as, [{ id: "1", kind: "a", size: 7 }])), ids(as));
console.log(JSON.stringify(merge(ab, ab)), ids(ab));
console.log(JSON.stringify(merge(mixed, as)), ids(mixed));

// Absent elements: the member read throws what Node throws.
const sparseAb: (A | B)[] = [];
put(sparseAb, 1, { id: "t", kind: "b", tags: [] });
for (const attempt of [() => merge(sparse, as), () => ids(sparse), () => ids(sparseAb)]) {
  try {
    console.log(attempt());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
