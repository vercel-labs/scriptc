class Base {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}
class Middle extends Base {
  constructor(label: string) {
    super(label);
  }
}
function fail(label: string): void {
  throw new TypeError("constructor: " + label);
}
class Broken extends Middle {
  constructor(label: string) {
    super(label);
    fail(label);
  }
}
class Sibling extends Base {
  constructor(label: string) {
    super(label);
  }
}

function make(C: typeof Base, label: string): Base {
  return new C(label);
}
function nested(C: typeof Middle, label: string): Base {
  return make(C, label);
}
for (const C of [Base, Middle, Broken, Sibling]) {
  try {
    console.log("made", make(C, C.name).label);
  } catch (error) {
    console.log("caught", error instanceof TypeError, (error as Error).message);
  } finally {
    console.log("finished", C.name);
  }
}
try {
  nested(Broken, "nested");
} catch (error) {
  console.log("nested", (error as Error).message);
}

// A descendant's throwing constructor does not affect these constructions.
const sibling: typeof Sibling = Sibling;
console.log("direct", new Base("base").label, new Middle("middle").label, new sibling("sibling").label);

// Callee and argument evaluation still propagate their own exceptions.
function choose(): typeof Base {
  throw new RangeError("choose");
}
function argument(): string {
  throw new RangeError("argument");
}
try {
  new (choose())("unused");
} catch (error) {
  console.log("callee", (error as Error).message);
}
try {
  new sibling(argument());
} catch (error) {
  console.log("argument", (error as Error).message);
}
