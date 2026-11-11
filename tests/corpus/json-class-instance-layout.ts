// JSON.stringify of class instances. A class whose own enumerable properties
// are exactly its layout fields, in their slots, serializes from the slots in
// the order the runtime walk lists them; every other class instance keeps the
// runtime walk. Both agree byte for byte with Node: field types the writer
// covers, fields it drops (undefined values, functions), nullable class
// references, inheritance, getters that stay off the own properties, shared
// and circular references, and the instances that must stay with the runtime
// walk — one that took a property through an untyped reference, one the
// program deleted a field from, and a class that declares toJSON.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

class Tag {
  label: string;
  weight: number;
  active: boolean;
  constructor(label: string, weight: number, active: boolean) {
    this.label = label;
    this.weight = weight;
    this.active = active;
  }
}

class Tree {
  value: number;
  kids: Tree[];
  constructor(value: number) {
    this.value = value;
    this.kids = [];
  }
}

class Link {
  label: string;
  next: Link | null;
  constructor(label: string, next: Link | null) {
    this.label = label;
    this.next = next;
  }
}

class Maybe {
  a?: number;
  b: number | undefined;
  k: number;
  constructor(k: number, a: number | undefined, b: number | undefined) {
    this.k = k;
    this.a = a;
    this.b = b;
  }
}

class Collections {
  m: Map<string, number>;
  s: Set<number>;
  constructor() {
    this.m = new Map([["a", 1]]);
    this.s = new Set([1, 2]);
  }
}

// A field holding an inline-typed record and an array of class instances.
class Doc {
  title: string;
  created: Date;
  tags: Tag[];
  meta: { lang: string; version: number };
  holes: (number | null | undefined)[];
  constructor(title: string, tags: Tag[]) {
    this.title = title;
    this.created = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
    this.tags = tags;
    this.meta = { lang: "en", version: 3 };
    this.holes = [1, undefined, null, 4];
  }
}

// Function-valued fields contribute no key; a getter is not an own property.
class Calls {
  name: string;
  run: () => number;
  constructor(name: string) {
    this.name = name;
    this.run = () => name.length;
  }
  get upper(): string {
    return this.name.toUpperCase();
  }
  method(): number {
    return this.name.length;
  }
}

class Base {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
class Derived extends Base {
  extra: string;
  constructor(id: number, extra: string) {
    super(id);
    this.extra = extra;
  }
}

class WithToJSON {
  secret: number;
  constructor(secret: number) {
    this.secret = secret;
  }
  toJSON(): { redacted: boolean } {
    return { redacted: true };
  }
}

const point = new Point(3, -4);
console.log(JSON.stringify(point));
console.log(JSON.stringify(new Point(0, 0)));
console.log(JSON.stringify(new Tag("edge", 2.5, true)));
console.log(JSON.stringify(new Tag("negative", -1, false)));

// Nested, shared and repeated instances.
const leafA = new Tree(1);
const leafB = new Tree(2);
leafA.kids.push(leafB, leafB);
const forest = new Tree(0);
forest.kids.push(leafA, leafB);
console.log(JSON.stringify(forest));
console.log(JSON.stringify({ forest, point }));

// A cycle through a field the writer reads itself still throws V8's
// circular TypeError (the message's constructor names are the runtime's,
// which prints 'Object' for any object on every path).
const cyc = new Tree(9);
cyc.kids.push(cyc);
try {
  JSON.stringify(cyc);
} catch (error) {
  if (error instanceof Error) console.log(error.name);
}

// Nullable class references keep their own slots.
const chain = new Link("a", new Link("b", null));
console.log(JSON.stringify(chain));

// undefined-valued own fields are dropped; null stays.
console.log(JSON.stringify(new Maybe(1, undefined, undefined)));
console.log(JSON.stringify(new Maybe(2, 7, undefined)));
console.log(JSON.stringify(new Maybe(3, undefined, 8)));

// A Map and a Set field hold no own enumerable property.
console.log(JSON.stringify(new Collections()));

// Dates, records, arrays of instances and mixed nullish elements.
const doc = new Doc("spec", [new Tag("x", 1, true), new Tag("y", 2, false)]);
console.log(JSON.stringify(doc));

// Function-valued fields drop; accessors stay off the own properties.
console.log(JSON.stringify(new Calls("abc")), JSON.stringify(new Calls("abc").run()));

// Inheritance: a derived instance lists the base fields first.
console.log(JSON.stringify(new Base(1)));
console.log(JSON.stringify(new Derived(2, "two")));

// toJSON answers for the whole value, at or above the class.
console.log(JSON.stringify(new WithToJSON(5)));
class InheritsToJSON extends WithToJSON {}
console.log(JSON.stringify(new InheritsToJSON(6)));

// Indentation rides the compact writer and the shared re-writer.
console.log(JSON.stringify(point, null, 2));
console.log(JSON.stringify(doc, null, 1));

// A frozen instance keeps its enumerable properties.
const frozen = new Point(5, 6);
Object.freeze(frozen);
console.log(JSON.stringify(frozen));

// A property taken through an untyped reference lives past the layout: the
// instance keeps the runtime walk, which lists it after the declared fields.
const extended = new Point(7, 8);
const untyped: any = extended;
untyped.extra = 42;
untyped["more"] = "text";
console.log(JSON.stringify(extended));
delete untyped.extra;
console.log(JSON.stringify(extended));

// The same instance reaches JSON.stringify through a checked-dynamic value:
// that walk is the runtime's, whatever the static type says.
const boxed: unknown = new Point(1, 2);
console.log(JSON.stringify(boxed));
