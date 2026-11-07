import { publish } from "@scriptc/threads";

// An object literal asserted to a record type whose required properties it
// does not write is completed in place through a partial record view. Where
// the asserted type can have no view, the checked conversion would throw
// every time it runs, so the build names each site instead.

// The literal holds a function.
interface Handler {
  run: () => number;
  label: string;
}
function handler(): Handler {
  const h = { run: () => 41 } as Handler;
  h.label = "h";
  return h;
}

// The asserted type is one arm of a union of object types.
interface Circle {
  kind: "circle";
  radius: number;
}
interface Square {
  kind: "square";
  side: number;
}
function circle(radius: number): Circle | Square {
  const c = { kind: "circle" } as Circle;
  c.radius = radius;
  return c;
}

// The asserted type refers to itself.
interface Item {
  name: string;
  next: Item | undefined;
}
function item(name: string, next: Item | undefined): Item {
  const made = {} as Item;
  made.name = name;
  made.next = next;
  return made;
}

// Values of the asserted type are written in two property orders.
type Span = { from: number; to: number };
function spans(): Span[] {
  const forward: Span = { from: 1, to: 2 };
  const backward: Span = { to: 3, from: 4 };
  const filled = {} as Span;
  filled.to = 5;
  filled.from = 6;
  return [forward, backward, filled];
}

// Values of the asserted type are published to other threads.
type Shared = { hits: number; misses: number };
function shared(): Shared {
  const fixed: Shared = { hits: 1, misses: 2 };
  publish(fixed);
  const filled = {} as Shared;
  filled.hits = 3;
  filled.misses = 4;
  return filled.hits > fixed.hits ? filled : fixed;
}

console.log(handler().run(), JSON.stringify(circle(2)), item("a", undefined).name, shared().hits);
console.log(spans().map((span) => Object.keys(span).join(",")).join(" "));
