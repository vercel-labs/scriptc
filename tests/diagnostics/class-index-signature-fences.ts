// A class index signature `[key: string]: any` (or `unknown`) compiles: a
// name the class does not declare is an own property of the instance
// (corpus 9361, 9362). What stays refused, by name:
// a signature whose value type has no `undefined` for an absent property,
class Labels {
  title = "t";
  [key: string]: string;
}
// a signature keyed by number,
class Slots {
  size = 0;
  [index: number]: unknown;
}
// and instance fields in a subclass of a class with a signature: Node
// creates them after the properties the base constructor added, and a
// compiled instance lists declared fields first.
class Open {
  id = 1;
  [key: string]: any;
  constructor() {
    this.added = true;
  }
}
class Closed extends Open {
  own = 2;
}
console.log(new Labels().title);
console.log(new Slots().size);
console.log(new Closed().own);

// A write through the signature that can run before the declared fields all
// exist: Node lists that property before the later fields, a compiled
// instance lists declared fields first. It can run that early from a field
// initializer that mentions `this` or calls something,
class Ledger {
  [key: string]: unknown;
  opened = this.stamp("early");
  closed = 2;
  stamp(name: string): number {
    this[name] = true;
    return 1;
  }
}
const ledger = new Ledger();
console.log(Object.keys(ledger).join(","));
// directly in an initializer, or in the last one,
class Tally {
  [key: string]: unknown;
  first = 1;
  second = (this.late = true) ? 2 : 0;
}
const tally = new Tally();
console.log(Object.keys(tally).join(","));
// from a base class's initializer, through a method the class overrides,
class Shelf {
  top = this.label("early");
  bottom = 2;
  label(name: string): number {
    return name.length;
  }
}
class OpenShelf extends Shelf {
  [key: string]: unknown;
  label(name: string): number {
    this[name] = true;
    return 1;
  }
}
const shelf = new OpenShelf();
console.log(Object.keys(shelf).join(","));
// and from a base constructor that calls out while the class still has
// fields to define.
class Drawer {
  constructor() {
    this.fill();
  }
  fill(): void {}
}
class OpenDrawer extends Drawer {
  depth = 3;
  [key: string]: unknown;
  fill(): void {
    this.filled = true;
  }
}
const drawer = new OpenDrawer();
console.log(Object.keys(drawer).join(","));

// Updates in place, deletes, calls and spreads through the signature have no
// lowering yet; each is refused where it is written.
const open = new Open();
open.hits = 1;
open.hits += 1;
open.hits++;
delete open.hits;
open.run = (): number => 1;
console.log(open.run());
console.log({ ...open });
