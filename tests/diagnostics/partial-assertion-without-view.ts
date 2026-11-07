// An object literal asserted to a record type whose required properties it
// does not write is completed in place through a partial record view. Where
// the asserted type can have no view, the checked conversion would throw
// every time it runs, so the build names each site instead.
type Token = "accent" | "border" | "text";
const SLOTS: Record<Token, number> = { accent: 4, border: 8, text: 15 };

// Values of the asserted type are frozen elsewhere in the program.
function build(scale: number): Record<Token, string | number> {
  const colors = {} as Record<Token, string | number>;
  for (const [token, slot] of Object.entries(SLOTS) as [Token, number][]) {
    colors[token] = scale > 0 ? slot * scale : "";
  }
  return colors;
}

function defaults(): Readonly<Record<Token, string | number>> {
  const base: Record<Token, string | number> = { accent: "", border: "", text: "" };
  return Object.freeze(base);
}

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

console.log(JSON.stringify(build(2)), Object.isFrozen(defaults()));
console.log(handler().run(), JSON.stringify(circle(2)), item("a", undefined).name);
