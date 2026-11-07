// A record derived from one that was checked from a dynamic value takes that
// value's key order: a rest binding, a conversion to another record type, a
// spread at any position and a clone hand it on, and a record derived from a
// value built in the declared order stays in the declared order.
interface Point { x: number; y: number; z?: number; label?: string }
interface Flat { x: number; y: number }
interface Tagged { tag: string; x: number; y: number; z?: number; label?: string }
function show(tag: string, value: object): void {
  const seen: string[] = [];
  for (const key in value) seen.push(key);
  console.log(tag, Object.keys(value).join(","), seen.join(","), JSON.stringify(value));
}
const parsed = JSON.parse('{"y":1,"label":"p","x":2}') as Point;
const plain: Point = { x: 1, y: 2 };
show("parsed", parsed);
show("plain", plain);

// Rest bindings.
function others(p: Point): { x: number; y: number; z?: number } {
  const { label, ...rest } = p;
  return rest;
}
show("rest of parsed", others(parsed));
show("rest of plain", others(plain));

// A conversion to a record type with fewer properties.
function flatten(p: Flat): string {
  return Object.keys(p).join(",") + " " + JSON.stringify(p);
}
console.log("flat of parsed", flatten(parsed));
console.log("flat of plain", flatten(plain));

// Spreads before and after a property the literal writes.
const before: Tagged = { tag: "t", ...parsed };
const after: Tagged = { ...parsed, tag: "t" };
show("tag then parsed", before);
show("parsed then tag", after);
const beforePlain: Tagged = { tag: "t", ...plain };
const afterPlain: Tagged = { ...plain, tag: "t" };
show("tag then plain", beforePlain);
show("plain then tag", afterPlain);

// Two spreads: the first one creates the keys both hold.
const first: Point = { ...plain, ...parsed };
const second: Point = { ...parsed, ...plain };
show("plain then parsed", first);
show("parsed then plain", second);

// A clone keeps its source's keys and appends the key it creates.
const moved: Point = { ...parsed, z: 3 };
const movedPlain: Point = { ...plain, z: 3 };
show("clone of parsed", moved);
show("clone of plain", movedPlain);

// A write that creates a key on a derived record puts it last.
const late = others(parsed);
late.z = 9;
show("late write", late);
const latePlain = others(plain);
latePlain.z = 9;
show("late write plain", latePlain);

// A source that may be missing.
function withDefaults(options?: Point): Point {
  return { x: 0, y: 0, ...options };
}
show("defaults", withDefaults());
show("defaults parsed", withDefaults(parsed));
show("defaults plain", withDefaults(plain));
function overDefaults(options?: Point): Point {
  return { ...options, x: 0, y: 0 };
}
show("over nothing", overDefaults());
show("over parsed", overDefaults(parsed));
show("over plain", overDefaults(plain));

// Every element of a parsed array has its own order.
const many = JSON.parse('[{"y":1,"x":2},{"x":3,"y":4,"z":5},{"z":6,"y":7,"x":8,"label":"l"}]') as Point[];
for (const p of many) {
  show("each rest", others(p));
  const tagged: Tagged = { tag: "m", ...p };
  show("each spread", tagged);
  show("each clone", { ...p, label: "c" });
}

// A derived record that is derived from again.
const twice = others({ ...parsed, z: 1 });
show("rest of clone", twice);
const again: Tagged = { ...others(parsed), tag: "u" };
show("spread of rest", again);

// A copy narrowed from a record with more properties shows that record's
// keys, in its order, and so does a clone of the copy.
interface Extra { a: number; b: number; extra: number }
interface Pair { a: number; b: number }
function narrow(wide: Extra): Pair {
  return wide;
}
const narrowed = narrow({ extra: 9, b: 2, a: 1 });
show("narrowed", narrowed);
const cloned: Pair = { ...narrowed, a: 5 };
show("clone of narrowed", cloned);
const reparsed = JSON.parse('{"b":1,"a":2}') as Pair;
show("clone of parsed pair", { ...reparsed, a: 5 });

// A type that a rest copy produces and a literal also builds in another
// order: a copy of a parsed or cloned value keeps that value's key order.
interface Trio { a: number; b: number; c: number }
type Duo = { b: number; c: number };
function withoutA(trio: Trio): Duo {
  const { a, ...duo } = trio;
  return duo;
}
const parsedTrio = JSON.parse('{"c":1,"b":2,"a":3}') as Trio;
const clonedTrio: Trio = { ...parsedTrio, a: 9 };
const madeDuo: Duo = { c: 5, b: 6 };
show("duo of parsed", withoutA(parsedTrio));
show("duo of cloned", withoutA(clonedTrio));
show("duo literal", madeDuo);
show("duo of plain", withoutA({ a: 1, b: 2, c: 3 }));
