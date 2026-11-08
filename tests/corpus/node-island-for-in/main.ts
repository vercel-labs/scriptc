// @requires-libnode
// for-in over a value that lives in a Node island visits what Node visits:
// the enumerable string keys of the object and of its prototype chain, in
// Node's order. A key that is gone when the loop reaches it is skipped, a
// key added during the loop is not visited, and a Proxy is asked what
// for-in asks it, when for-in asks it.
import {
  dim,
  hidden,
  inherited,
  jar,
  labelled,
  list,
  locked,
  notes,
  odd,
  picked,
  put,
  recipe,
  remove,
  restock,
  restockLoose,
  stock,
  visit,
  walk,
  watched,
  watchedBelow,
} from "pantry";

function keysOf(shelf: any): string {
  const seen: string[] = [];
  for (const key in shelf) seen.push(key);
  return seen.join(",");
}

function keysOfUnknown(shelf: unknown): string {
  if ((typeof shelf !== "object" || shelf === null) && typeof shelf !== "function") return "not an object";
  const seen: string[] = [];
  for (const key in shelf) seen.push(key);
  return seen.length + ":" + seen.join(",");
}

// Kinds of value: index keys first and ascending, inherited members after
// the object's own, an array's indices, a function's own members, nothing
// for a generator, hidden keys neither visited nor let through from below.
console.log("object:", keysOf(stock()));
console.log("inherited:", keysOf(inherited()));
console.log("instance:", keysOfUnknown(jar()));
console.log("array:", keysOf(list()));
console.log("function:", keysOf(recipe()));
console.log("generator:", keysOfUnknown(restockLoose()));
console.log("hidden:", keysOf(hidden()));
console.log("odd keys:", JSON.stringify(keysOf(odd()).split(",")));

// A type the package declares names fewer members than the object has.
const typed = labelled();
const declared: string[] = [];
for (const key in typed) declared.push(key);
console.log("declared type:", declared.join(","));

// A generator the program holds with its own type is the island's iterator
// where it is untyped: no keys, and the walk does not step it.
const steps: Generator<string, void, undefined> = restock();
const loose: unknown = steps;
console.log("typed generator:", keysOfUnknown(loose), steps.next().value);

// The values during the loop, an early exit, a nested walk, a key declared
// before the loop and a `var` key.
const shelf: any = stock();
const pairs: string[] = [];
for (const key in shelf) pairs.push(key + "=" + String(shelf[key]));
console.log("values:", pairs.join(" "));
let first = "none";
for (const key in shelf) {
  first = key;
  break;
}
console.log("first:", first);
let crossings = 0;
for (const outer in shelf) for (const inner in shelf) if (outer < inner) crossings++;
console.log("nested:", crossings);
let last = "none";
for (last in shelf) continue;
const hoisted: string[] = [];
for (var slot in shelf) hoisted.push(slot);
console.log("last:", last, hoisted.length);

// Changes during the loop: a key removed before its turn is skipped, a key
// put back is visited, a new key is not, a key that stops being enumerable
// is still visited.
const removed: string[] = [];
const emptied: any = stock();
for (const key in emptied) {
  removed.push(key);
  remove(emptied, "beans");
  put(emptied, "late");
}
console.log("removed:", removed.join(","), "then", keysOf(emptied));
const restored: string[] = [];
const refilled: any = stock();
for (const key in refilled) {
  restored.push(key);
  remove(refilled, "beans");
  put(refilled, "beans");
}
console.log("put back:", restored.join(","));
const dimmed: string[] = [];
const dimShelf: any = stock();
for (const key in dimShelf) {
  dimmed.push(key);
  dim(dimShelf, "beans");
}
console.log("dimmed:", dimmed.join(","), "then", keysOf(dimShelf));
const native: string[] = [];
const cleared: any = inherited();
for (const key in cleared) {
  native.push(key);
  delete cleared.tea;
  cleared.fresh = 1;
}
console.log("native delete:", native.join(","), "then", keysOf(cleared));

// A Proxy: its own list of keys, and its traps in Node's order between the
// loop's passes.
console.log("picked:", keysOf(picked()));
const asked: string[] = [];
const herbs: any = watched();
notes();
for (const key in herbs) asked.push(key + " [" + notes() + "]");
console.log("watched:", asked.join(" "), "end [" + notes() + "]");
const below: string[] = [];
const stacked: any = watchedBelow();
notes();
for (const key in stacked) below.push(key + " [" + notes() + "]");
console.log("watched below:", below.join(" "), "end [" + notes() + "]");
try {
  console.log(keysOf(locked()));
} catch (error) {
  console.log("locked:", error instanceof Error ? error.message : "not an error");
}

// The island walks its own value handed back, the program walks it inside
// a callback the island calls, and the island walks a native object.
console.log("handed back:", walk(shelf));
console.log("callback:", visit(keysOf));
console.log("native object:", walk({ rye: 1, corn: 2 }));
