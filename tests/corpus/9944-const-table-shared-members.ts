// A constant table may name objects that were made elsewhere: a binding of a
// declared type, the result of a call, a class instance. When the table takes
// the layout of the type it is read through, such a member sits in its slot
// as the object it is, so the table and the member keep their identities
// through the table's own type and through the interface.

interface Ink {
  readonly hue: string;
  readonly dry?: boolean;
}

class Nib {
  readonly width: number;
  constructor(width: number) {
    this.width = width;
  }
}

interface Pen {
  readonly name: string;
  readonly ink?: Ink;
  readonly spare?: Ink | null;
  readonly nib?: Nib;
  readonly refills?: ReadonlyArray<Ink>;
}

function mix(hue: string): Ink {
  return { hue };
}

function maybe(hue: string): Ink | null {
  return hue === "" ? null : { hue, dry: true };
}

const black: Ink = { hue: "black" };
const broad = new Nib(1.1);
const sepia = { hue: "sepia" } as const;

const fine = { name: "fine", ink: black, nib: broad } as const;
const brush = { name: "brush", ink: mix("teal"), spare: maybe("red"), nib: new Nib(3) } as const;
const empty = { name: "empty", spare: maybe("") } as const;
const set = { name: "set", refills: [black, sepia, { hue: "moss", dry: false }] } as const;

const cup = new Set<Pen>();
const inks = new Map<Ink, string>();
const nibs = new Set<Nib>();

function drop(pen: Pen): void {
  cup.add(pen);
  if (pen.ink !== undefined) inks.set(pen.ink, pen.name);
  if (pen.spare) inks.set(pen.spare, `${pen.name} spare`);
  if (pen.nib !== undefined) nibs.add(pen.nib);
  for (const refill of pen.refills ?? []) inks.set(refill, `${pen.name} refill`);
}

function inkOf(pen: Pen): Ink | undefined {
  return pen.ink;
}

drop(fine);
drop(brush);
drop(empty);
drop(set);

// The tables are the objects the collection holds.
console.log(cup.has(fine), cup.has(brush), cup.has(empty), cup.has(set), cup.size);

// A member of a declared type is that binding's object, both ways.
console.log(inks.get(black), inks.get(fine.ink), fine.ink === black, inkOf(fine) === black);

// A call's result and a class instance.
console.log(inks.get(brush.ink), brush.ink.hue, inkOf(brush) === brush.ink);
console.log(nibs.has(broad), nibs.has(fine.nib), nibs.has(brush.nib), fine.nib.width + brush.nib.width);

// A member that may be null.
console.log(brush.spare === null ? "none" : inks.get(brush.spare), empty.spare === null);

// A list that mixes a declared object, another table and a literal.
console.log(inks.get(sepia), inks.size, black.dry === undefined, sepia.hue);

// What the tables hold is what the literals wrote.
console.log(Object.keys(fine).join(), Object.keys(empty).join(), JSON.stringify(set));
